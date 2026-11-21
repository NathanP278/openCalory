import { useState, useCallback } from 'react';
import type { FoodItem } from '@/types/nutrition';
import { db } from '@/lib/db/opencalory-db';
import { parseOffProduct } from '@/lib/foods/off-adapter';

export type BarcodeLookupResult =
  | { status: 'hit'; item: FoodItem }
  | { status: 'missing'; barcode: string }
  | { status: 'offline-miss'; barcode: string };

/**
 * Executes the barcode lookup waterfall:
 * 1. Checks local Dexie foodsCache by barcode (resolves offline instantly with 0 network calls).
 * 2. On miss, queries /api/off/[barcode] proxy.
 * 3. On valid hit (status 1 + parseable product), caches item in Dexie and returns { status: 'hit', item }.
 * 4. On not found (OFF status 0 or 404), returns { status: 'missing', barcode }.
 * 5. On network offline / 5xx, returns { status: 'offline-miss', barcode }.
 */
export async function lookupBarcodeWaterfall(rawBarcode: string): Promise<BarcodeLookupResult> {
  const barcode = rawBarcode.trim();
  if (!barcode) {
    return { status: 'missing', barcode };
  }

  // 1. Local Dexie cache lookup (offline-first, including UPC-A <-> EAN-13 leading-zero alias)
  const cacheCandidates = [barcode];
  if (barcode.length === 12) {
    cacheCandidates.push(`0${barcode}`);
  } else if (barcode.length === 13 && barcode.startsWith('0')) {
    cacheCandidates.push(barcode.slice(1));
  }

  try {
    const cached = await db.foodsCache.where('barcode').anyOf(cacheCandidates).first();
    if (cached) {
      return { status: 'hit', item: cached };
    }
  } catch (err) {
    console.error('Dexie foodsCache barcode lookup error:', err);
  }

  // 2. Fetch via Open Food Facts proxy route
  let res: Response;
  try {
    res = await fetch(`/api/off/${encodeURIComponent(barcode)}`);
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

  if (data && typeof data === 'object' && (data as { status?: number }).status === 0) {
    return { status: 'missing', barcode };
  }

  const item = parseOffProduct(barcode, data);
  if (!item) {
    return { status: 'missing', barcode };
  }

  // 3. Cache into Dexie for future offline hits
  try {
    await db.foodsCache.put(item);
  } catch (err) {
    console.error('Failed to cache item in Dexie:', err);
  }

  return { status: 'hit', item };
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
        setError('Barcode not found in Open Food Facts.');
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
