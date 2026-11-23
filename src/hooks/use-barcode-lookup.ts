import { useState, useCallback } from 'react';
import type { FoodItem } from '@/types/nutrition';
import { db } from '@/lib/db/opencalory-db';
import {
  getCatalogSyncState,
  lookupClientCatalogBarcode,
} from '@/lib/foods/client-catalog';
import { normalizeBarcode } from '@/lib/foods/dedup';
import { parseOffProduct } from '@/lib/foods/off-adapter';

export type BarcodeLookupResult =
  | { status: 'hit'; item: FoodItem }
  | { status: 'missing'; barcode: string }
  | { status: 'offline-miss'; barcode: string };

/**
 * Executes the barcode lookup waterfall:
 * 1. Checks local Dexie foodsCache by barcode (including UPC-A <-> EAN-13 candidates, 0 network calls).
 * 2. Checks the offline OPFS SQLite catalog via lookupClientCatalogBarcode (0 network calls when ready).
 * 3. On miss, queries GET /api/foods/barcode/[code] (server catalog -> live OFF / opt-in providers).
 * 4. On valid hit, caches item in Dexie foodsCache and returns { status: 'hit', item }.
 * 5. On not found (404 / status 'missing' / status 0), returns { status: 'missing', barcode }.
 * 6. On network offline / 5xx / 429, returns { status: 'offline-miss', barcode }.
 */
export async function lookupBarcodeWaterfall(rawBarcode: string): Promise<BarcodeLookupResult> {
  const barcode = rawBarcode.trim();
  if (!barcode) {
    return { status: 'missing', barcode };
  }

  // 1. Local Dexie cache lookup (offline-first, including UPC-A <-> EAN-13 leading-zero alias)
  const normalized = normalizeBarcode(barcode);
  const candidateSet = new Set<string>([barcode]);
  if (normalized) {
    candidateSet.add(normalized);
  }
  if (barcode.length === 12) {
    candidateSet.add(`0${barcode}`);
  } else if (barcode.length === 13 && barcode.startsWith('0')) {
    candidateSet.add(barcode.slice(1));
  }
  if (normalized && normalized.length === 13 && normalized.startsWith('0')) {
    candidateSet.add(normalized.slice(1));
  }
  const cacheCandidates = Array.from(candidateSet);

  try {
    const cached = await db.foodsCache.where('barcode').anyOf(cacheCandidates).first();
    if (cached) {
      return { status: 'hit', item: cached };
    }
  } catch (err) {
    console.error('Dexie foodsCache barcode lookup error:', err);
  }

  // 2. Offline OPFS SQLite catalog lookup (0 network calls when catalog worker is ready)
  if (getCatalogSyncState().status === 'ready') {
    try {
      const catalogHit = await lookupClientCatalogBarcode(barcode);
      if (catalogHit) {
        try {
          await db.foodsCache.put(catalogHit);
        } catch (err) {
          console.error('Failed to cache catalog barcode item in Dexie:', err);
        }
        return { status: 'hit', item: catalogHit };
      }
    } catch (err) {
      console.error('Client catalog barcode lookup error:', err);
    }
  }

  // 3. Server catalog + live provider fallback via /api/foods/barcode/[code]
  let res: Response;
  try {
    res = await fetch(`/api/foods/barcode/${encodeURIComponent(barcode)}`);
  } catch {
    // Network offline / fetch rejected
    return { status: 'offline-miss', barcode };
  }

  if (res.status === 429 || res.status === 408 || res.status >= 500) {
    return { status: 'offline-miss', barcode };
  }

  if (res.status === 404 || !res.ok) {
    return { status: 'missing', barcode };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { status: 'offline-miss', barcode };
  }

  if (data && typeof data === 'object') {
    const payload = data as { status?: string | number; item?: FoodItem | null };
    if (payload.status === 'hit' && payload.item) {
      try {
        await db.foodsCache.put(payload.item);
      } catch (err) {
        console.error('Failed to cache barcode item in Dexie:', err);
      }
      return { status: 'hit', item: payload.item };
    }
    if (payload.status === 'missing' || payload.status === 0) {
      return { status: 'missing', barcode };
    }
  }

  // Compatibility fallback for direct Open Food Facts response shapes
  const parsedOff = parseOffProduct(barcode, data);
  if (!parsedOff) {
    return { status: 'missing', barcode };
  }

  try {
    await db.foodsCache.put(parsedOff);
  } catch (err) {
    console.error('Failed to cache item in Dexie:', err);
  }

  return { status: 'hit', item: parsedOff };
}

export interface UseBarcodeLookupReturn {
  isLoading: boolean;
  result: BarcodeLookupResult | null;
  error: string | null;
  lookup: (barcode: string) => Promise<BarcodeLookupResult>;
  reset: () => void;
}

export function useBarcodeLookup(): UseBarcodeLookupReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<BarcodeLookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = useCallback(async (barcode: string): Promise<BarcodeLookupResult> => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await lookupBarcodeWaterfall(barcode);
      setResult(res);
      if (res.status === 'offline-miss') {
        setError('Network offline or upstream service unavailable.');
      } else if (res.status === 'missing') {
        setError('Barcode not found in catalog or online databases.');
      }
      return res;
    } catch (err) {
      const offlineResult: BarcodeLookupResult = {
        status: 'offline-miss',
        barcode: barcode.trim(),
      };
      setResult(offlineResult);
      setError(err instanceof Error ? err.message : 'Unknown error during barcode lookup.');
      return offlineResult;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setIsLoading(false);
    setResult(null);
    setError(null);
  }, []);

  return {
    isLoading,
    result,
    error,
    lookup,
    reset,
  };
}
