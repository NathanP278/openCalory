import type { FoodItem } from '@/types/nutrition';
import {
  catalogRowToFoodItem,
  type CatalogManifest,
} from '@/lib/foods/catalog-schema';
import { normalizeBarcode } from '@/lib/foods/dedup';
import {
  PREP_MODIFIERS,
  rankCandidates,
  rowRecordToCatalogFoodRow,
  tokenizeQuery,
  type CandidateRow,
} from '@/lib/foods/fts-query';
import type { Database, SAHPoolUtil, SqlValue } from '@sqlite.org/sqlite-wasm';

export interface CatalogSyncState {
  status: 'idle' | 'syncing' | 'ready' | 'fallback';
  tier?: 'core' | 'expanded';
  foodCount?: number;
  version?: string;
  progressPct?: number;
  reason?: string;
}

export type WorkerRequestMessage =
  | { type: 'init'; manifest?: CatalogManifest }
  | { type: 'search'; requestId: number; query: string; limit?: number; region?: string }
  | { type: 'cancel'; requestId: number }
  | { type: 'barcode'; requestId: number; barcode: string }
  | { type: 'resolveLegacyIds'; requestId: number; legacyIds: string[] };

export type WorkerResponseMessage =
  | { type: 'status'; state: CatalogSyncState }
  | { type: 'searchResult'; requestId: number; items: FoodItem[] }
  | { type: 'barcodeResult'; requestId: number; item: FoodItem | null }
  | { type: 'legacyIdsResult'; requestId: number; entries: Array<[string, FoodItem]> }
  | { type: 'error'; requestId?: number; message: string };

export interface OpfsFileLike {
  size: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface OpfsWritableLike {
  write(data: Uint8Array | string): Promise<void>;
  close(): Promise<void>;
}

export interface OpfsFileHandleLike {
  getFile(): Promise<OpfsFileLike>;
  createWritable(): Promise<OpfsWritableLike>;
}

export interface OpfsDirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>;
  removeEntry(name: string): Promise<void>;
}

export interface SyncCatalogOptions {
  opfsRoot: OpfsDirectoryLike;
  fetchImpl?: typeof fetch;
  manifestUrl?: string;
  catalogUrl?: string;
  preloadedManifest?: CatalogManifest;
  hasExistingDb?: (manifest: CatalogManifest) => Promise<boolean> | boolean;
  importDbStream?: (
    manifest: CatalogManifest,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onBytesRead: (bytes: number) => void
  ) => Promise<void>;
  verifyDb?: (manifest: CatalogManifest) => Promise<void> | void;
  onProgress?: (pct: number) => void;
}

export interface SyncCatalogResult {
  manifest: CatalogManifest;
  downloaded: boolean;
}

const MANIFEST_FILENAME = 'catalog-manifest.json';
const DEFAULT_DB_FILENAME = 'food-catalog.db';
const DEFAULT_TMP_DB_FILENAME = 'food-catalog.tmp.db';

function isValidManifest(value: unknown): value is CatalogManifest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<CatalogManifest>;
  return (
    typeof v.version === 'string' &&
    typeof v.sha256 === 'string' &&
    typeof v.foodCount === 'number' &&
    typeof v.rawBytes === 'number'
  );
}

async function readStoredManifest(opfsRoot: OpfsDirectoryLike): Promise<CatalogManifest | null> {
  try {
    const handle = await opfsRoot.getFileHandle(MANIFEST_FILENAME);
    const file = await handle.getFile();
    const raw = await file.text();
    const parsed = JSON.parse(raw);
    return isValidManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeStoredManifest(
  opfsRoot: OpfsDirectoryLike,
  manifest: CatalogManifest
): Promise<void> {
  const handle = await opfsRoot.getFileHandle(MANIFEST_FILENAME, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(manifest));
  await writable.close();
}

async function defaultHasExistingDb(opfsRoot: OpfsDirectoryLike): Promise<boolean> {
  try {
    const handle = await opfsRoot.getFileHandle(DEFAULT_DB_FILENAME);
    const file = await handle.getFile();
    return file.size > 0;
  } catch {
    return false;
  }
}

async function defaultWriteStreamToOpfs(
  opfsRoot: OpfsDirectoryLike,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onBytesRead: (bytes: number) => void
): Promise<void> {
  // Write to temporary file first, then swap to final file so interrupted downloads never corrupt active DB.
  const tmpHandle = await opfsRoot.getFileHandle(DEFAULT_TMP_DB_FILENAME, { create: true });
  const tmpWritable = await tmpHandle.createWritable();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        await tmpWritable.write(value);
        onBytesRead(value.byteLength);
      }
    }
    await tmpWritable.close();

    // Copy validated temp file into final target and remove temp file
    const tmpFile = await tmpHandle.getFile();
    const finalHandle = await opfsRoot.getFileHandle(DEFAULT_DB_FILENAME, { create: true });
    const finalWritable = await finalHandle.createWritable();
    await finalWritable.write(new Uint8Array(await tmpFile.arrayBuffer()));
    await finalWritable.close();
  } finally {
    await opfsRoot.removeEntry(DEFAULT_TMP_DB_FILENAME).catch(() => undefined);
  }
}

/**
 * Syncs the full food catalog into OPFS.
 * - Skips downloading `/api/foods/catalog` when stored manifest `sha256` already matches
 *   and the local DB file exists.
 * - Streams gzipped catalog through `DecompressionStream('gzip')` so the full DB is never
 *   buffered in JS RAM.
 * - Persists `catalog-manifest.json` only after the DB write/import succeeds.
 */
export async function syncCatalogToOpfs(options: SyncCatalogOptions): Promise<SyncCatalogResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const manifestUrl = options.manifestUrl ?? '/api/foods/manifest';
  const catalogUrl = options.catalogUrl ?? '/api/foods/catalog';

  let remoteManifest = options.preloadedManifest;
  if (!remoteManifest) {
    const manifestRes = await fetchImpl(manifestUrl);
    if (!manifestRes.ok) {
      throw new Error(`Failed to fetch catalog manifest (${manifestRes.status})`);
    }
    const parsed = await manifestRes.json();
    if (!isValidManifest(parsed)) {
      throw new Error('Invalid catalog manifest payload');
    }
    remoteManifest = parsed;
  }

  const storedManifest = await readStoredManifest(options.opfsRoot);
  const dbExists = options.hasExistingDb
    ? await options.hasExistingDb(remoteManifest)
    : await defaultHasExistingDb(options.opfsRoot);

  if (storedManifest && storedManifest.sha256 === remoteManifest.sha256 && dbExists) {
    options.onProgress?.(100);
    return { manifest: remoteManifest, downloaded: false };
  }

  options.onProgress?.(5);

  const catalogRes = await fetchImpl(catalogUrl);
  if (!catalogRes.ok) {
    throw new Error(`Failed to fetch catalog archive (${catalogRes.status})`);
  }
  if (!catalogRes.body) {
    throw new Error('Catalog response body is not streamable');
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is unavailable in this browser');
  }

  const decompressedStream = catalogRes.body.pipeThrough(new DecompressionStream('gzip'));
  const reader = decompressedStream.getReader();

  let bytesWritten = 0;
  let lastReportedPct = 5;
  const totalExpected = Math.max(remoteManifest.rawBytes, 1);
  const reportBytes = (chunkLen: number) => {
    bytesWritten += chunkLen;
    const pct = Math.min(98, Math.max(5, Math.round((bytesWritten / totalExpected) * 95)));
    if (pct >= lastReportedPct + 5) {
      lastReportedPct = pct;
      options.onProgress?.(pct);
    }
  };

  try {
    if (options.importDbStream) {
      await options.importDbStream(remoteManifest, reader, reportBytes);
    } else {
      await defaultWriteStreamToOpfs(options.opfsRoot, reader, reportBytes);
    }
  } finally {
    reader.releaseLock();
  }

  // Verify the imported DB BEFORE persisting catalog-manifest.json so a corrupt
  // or schema-invalid download never poisons the manifest and prevents retries.
  if (options.verifyDb) {
    try {
      await options.verifyDb(remoteManifest);
    } catch (err) {
      if (!options.importDbStream) {
        await options.opfsRoot.removeEntry(DEFAULT_DB_FILENAME).catch(() => undefined);
      }
      throw err;
    }
  }

  await writeStoredManifest(options.opfsRoot, remoteManifest);
  options.onProgress?.(100);

  return { manifest: remoteManifest, downloaded: true };
}

function getSahPoolDbName(sha256: string): string {
  const safeHash = sha256.replace(/[^a-f0-9]/gi, '').slice(0, 16) || 'active';
  return `/food-catalog-${safeHash}.db`;
}

function runFtsMatchQuery(
  db: Database,
  matchExpr: string,
  fetchLimit: number
): CandidateRow[] {
  if (!matchExpr) return [];
  try {
    const rows = db.selectObjects(
      `SELECT f.*, bm25(foods_fts, 10.0, 5.0, 4.0, 1.0) AS fts_bm25
       FROM foods_fts
       JOIN foods f ON f.rowid = foods_fts.rowid
       WHERE foods_fts MATCH ?
       ORDER BY (bm25(foods_fts, 10.0, 5.0, 4.0, 1.0) - (f.search_rank * 0.05) + (f.accuracy_tier * 1.2)) ASC
       LIMIT ?`,
      [matchExpr, fetchLimit]
    );
    return rows.map((r: Record<string, SqlValue>) => ({
      row: rowRecordToCatalogFoodRow(r),
      bm25: Number(r.fts_bm25 ?? 0),
    }));
  } catch {
    return [];
  }
}

function searchDb(
  db: Database,
  query: string,
  options?: { limit?: number; region?: string }
): FoodItem[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  const limit = Math.max(1, Math.min(100, Math.round(options?.limit ?? 20)));
  const fetchLimit = Math.max(limit * 5, 80);

  const candidates = new Map<string, CandidateRow>();
  const mergeCandidates = (rows: CandidateRow[]) => {
    for (const item of rows) {
      const existing = candidates.get(item.row.id);
      if (!existing || item.bm25 < existing.bm25) {
        candidates.set(item.row.id, item);
      }
    }
  };

  // Primary strict AND prefix query
  const strictMatch = tokens.map((t) => `"${t}"*`).join(' ');
  mergeCandidates(runFtsMatchQuery(db, strictMatch, fetchLimit));

  // Secondary fallbacks when strict query returns < 5 hits
  const canFallback = tokens.length >= 2 || tokens.some((t) => t.length >= 4);
  if (candidates.size < 5 && canFallback) {
    // Fallback 1: Strip prep modifiers
    const coreTokens = tokens.filter((t) => !PREP_MODIFIERS.has(t));
    if (coreTokens.length > 0 && coreTokens.length < tokens.length) {
      const strippedMatch = coreTokens.map((t) => `"${t}"*`).join(' ');
      mergeCandidates(runFtsMatchQuery(db, strippedMatch, fetchLimit));
    }

    // Fallback 2: 3-char prefix AND match for typo tolerance
    if (candidates.size < 5) {
      const prefixTokens = tokens.map((t) => (t.length >= 3 ? t.slice(0, 3) : t));
      const uniquePrefixes = Array.from(new Set(prefixTokens));
      const prefixAndMatch = uniquePrefixes.map((t) => `"${t}"*`).join(' ');
      mergeCandidates(runFtsMatchQuery(db, prefixAndMatch, fetchLimit));
    }

    // Fallback 3: Relaxed OR prefix query
    if (candidates.size < 5 && tokens.length >= 2) {
      const orMatch = tokens.map((t) => `"${t}"*`).join(' OR ');
      mergeCandidates(runFtsMatchQuery(db, orMatch, fetchLimit));
    }

    // Fallback 4: 3-char prefix OR match
    if (candidates.size < 5 && tokens.length >= 2) {
      const prefixTokens = tokens.map((t) => (t.length >= 3 ? t.slice(0, 3) : t));
      const uniquePrefixes = Array.from(new Set(prefixTokens));
      if (uniquePrefixes.length >= 2) {
        const prefixOrMatch = uniquePrefixes.map((t) => `"${t}"*`).join(' OR ');
        mergeCandidates(runFtsMatchQuery(db, prefixOrMatch, fetchLimit));
      }
    }
  }

  if (candidates.size === 0) return [];

  const ranked = rankCandidates(candidates.values(), tokens, {
    limit,
    region: options?.region,
  });

  return ranked.map((row) => catalogRowToFoodItem(row));
}

function lookupBarcodeInDb(db: Database, barcode: string): FoodItem | null {
  if (!barcode || typeof barcode !== 'string') return null;
  const normalized = normalizeBarcode(barcode);
  const rawDigits = barcode.replace(/\D+/g, '');
  if (!normalized && rawDigits.length < 8) return null;

  const candidates = Array.from(
    new Set([normalized, rawDigits].filter((v): v is string => Boolean(v && v.length >= 8)))
  );
  if (candidates.length === 0) return null;

  const placeholders = candidates.map(() => '?').join(', ');
  const rows = db.selectObjects(
    `SELECT *
     FROM foods
     WHERE barcode IN (${placeholders})
     ORDER BY CASE WHEN barcode = ? THEN 0 ELSE 1 END,
              accuracy_tier ASC,
              search_rank DESC
     LIMIT 1`,
    [...candidates, normalized ?? candidates[0]]
  );

  if (rows.length > 0) {
    return catalogRowToFoodItem(rowRecordToCatalogFoodRow(rows[0]));
  }

  try {
    const aliasRows = db.selectObjects(
      `SELECT f.*
       FROM food_barcode_aliases b
       JOIN foods f ON f.id = b.canonical_id
       WHERE b.barcode IN (${placeholders})
       ORDER BY CASE WHEN b.barcode = ? THEN 0 ELSE 1 END,
                f.accuracy_tier ASC,
                f.search_rank DESC
       LIMIT 1`,
      [...candidates, normalized ?? candidates[0]]
    );
    if (aliasRows.length === 0) return null;
    return catalogRowToFoodItem(rowRecordToCatalogFoodRow(aliasRows[0]));
  } catch {
    return null;
  }
}

function resolveLegacyIdsInDb(db: Database, legacyIds: string[]): Array<[string, FoodItem]> {
  if (!Array.isArray(legacyIds) || legacyIds.length === 0) return [];
  const uniqueIds = Array.from(
    new Set(legacyIds.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean))
  );
  if (uniqueIds.length === 0) return [];

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = db.selectObjects(
    `SELECT a.legacy_id, f.*
     FROM food_id_aliases a
     JOIN foods f ON f.id = a.canonical_id
     WHERE a.legacy_id IN (${placeholders})`,
    uniqueIds
  );

  const entries: Array<[string, FoodItem]> = [];
  for (const row of rows) {
    const legacyId = String(row.legacy_id ?? '');
    if (legacyId) {
      entries.push([legacyId, catalogRowToFoodItem(rowRecordToCatalogFoodRow(row))]);
    }
  }
  return entries;
}

// Dedicated Web Worker runtime registration (guarded so module is safely importable in tests/SSR)
const isDedicatedWorker =
  typeof self !== 'undefined' &&
  typeof window === 'undefined' &&
  typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function';

if (isDedicatedWorker) {
  let activeDb: Database | null = null;
  let poolUtil: SAHPoolUtil | null = null;
  let activeDbFilename: string | null = null;
  let latestSearchRequestId = 0;
  const cancelledRequestIds = new Set<number>();

  const post = (msg: WorkerResponseMessage) => {
    (self as unknown as { postMessage(m: WorkerResponseMessage): void }).postMessage(msg);
  };

  const emitStatus = (state: CatalogSyncState) => {
    post({ type: 'status', state });
  };

  const handleInit = async (preloadedManifest?: CatalogManifest) => {
    try {
      if (
        typeof navigator === 'undefined' ||
        !navigator.storage ||
        typeof navigator.storage.getDirectory !== 'function'
      ) {
        emitStatus({
          status: 'fallback',
          reason: 'OPFS (navigator.storage.getDirectory) is unavailable in this browser.',
        });
        return;
      }

      // Fetch manifest first so we can verify storage quota before opening/downloading
      let manifest = preloadedManifest;
      if (!manifest) {
        const res = await fetch('/api/foods/manifest');
        if (!res.ok) {
          emitStatus({
            status: 'fallback',
            reason: `Catalog manifest unavailable (HTTP ${res.status}).`,
          });
          return;
        }
        const parsed = await res.json();
        if (!isValidManifest(parsed)) {
          emitStatus({
            status: 'fallback',
            reason: 'Invalid catalog manifest payload.',
          });
          return;
        }
        manifest = parsed;
      }

      // Quota safety check (Review Focus #4)
      if (typeof navigator.storage.estimate === 'function') {
        try {
          const estimate = await navigator.storage.estimate();
          if (typeof estimate.quota === 'number') {
            const usage = typeof estimate.usage === 'number' ? estimate.usage : 0;
            const available = Math.max(0, estimate.quota - usage);
            const required = manifest.rawBytes * 2;
            if (available < required) {
              emitStatus({
                status: 'fallback',
                tier: manifest.tier,
                foodCount: manifest.foodCount,
                version: manifest.version,
                reason: `Insufficient OPFS storage quota (${available} bytes free, need ${required} bytes).`,
              });
              return;
            }
          }
        } catch {
          // If estimate() fails in a restricted context, proceed cautiously or fall back on write error
        }
      }

      emitStatus({
        status: 'syncing',
        tier: manifest.tier,
        foodCount: manifest.foodCount,
        version: manifest.version,
        progressPct: 0,
      });

      const opfsRoot = (await navigator.storage.getDirectory()) as unknown as OpfsDirectoryLike;

      const sqlite3Module = await import('@sqlite.org/sqlite-wasm');
      const sqlite3Init = sqlite3Module.default as unknown as (opts?: {
        locateFile?: (file: string) => string;
      }) => Promise<Awaited<ReturnType<typeof sqlite3Module.default>>>;
      const sqlite3 = await sqlite3Init({
        locateFile: (file: string) => (file.endsWith('.wasm') ? '/wasm/sqlite3.wasm' : file),
      });

      if (!poolUtil) {
        poolUtil = await sqlite3.installOpfsSAHPoolVfs({
          name: 'opencalory-food-catalog',
          directory: '/opencalory-sahpool',
          initialCapacity: 6,
        });
      }

      const currentPool = poolUtil;
      let verifiedDb: Database | null = null;
      let verifiedDbName: string | null = null;

      const openAndVerifySahDb = (dbName: string): Database => {
        const candidate = new currentPool.OpfsSAHPoolDb(dbName);
        try {
          candidate.exec('PRAGMA query_only = ON');
          candidate.selectObjects('SELECT 1 AS ok FROM foods LIMIT 1');
          return candidate;
        } catch (err) {
          try {
            candidate.close();
          } catch {
            // Ignore close errors
          }
          try {
            currentPool.unlink(dbName);
          } catch {
            // Ignore unlink errors
          }
          throw err;
        }
      };

      const syncResult = await syncCatalogToOpfs({
        opfsRoot,
        preloadedManifest: manifest,
        hasExistingDb: (m) => currentPool.getFileNames().includes(getSahPoolDbName(m.sha256)),
        importDbStream: async (m, reader, onBytesRead) => {
          const targetName = getSahPoolDbName(m.sha256);
          await currentPool.reserveMinimumCapacity(4);
          await currentPool.importDb(targetName, async () => {
            const { value, done } = await reader.read();
            if (done) return undefined;
            if (value && value.byteLength > 0) {
              onBytesRead(value.byteLength);
            }
            return value;
          });
        },
        verifyDb: (m) => {
          const targetName = getSahPoolDbName(m.sha256);
          verifiedDb = openAndVerifySahDb(targetName);
          verifiedDbName = targetName;
        },
        onProgress: (pct) => {
          emitStatus({
            status: 'syncing',
            tier: manifest.tier,
            foodCount: manifest.foodCount,
            version: manifest.version,
            progressPct: pct,
          });
        },
      });

      const nextDbName = verifiedDbName ?? getSahPoolDbName(syncResult.manifest.sha256);
      let nextDb: Database;
      if (verifiedDb) {
        nextDb = verifiedDb;
      } else {
        try {
          nextDb = openAndVerifySahDb(nextDbName);
        } catch (err) {
          // Cached DB was corrupt; remove stale manifest so next reload re-downloads cleanly
          await opfsRoot.removeEntry(MANIFEST_FILENAME).catch(() => undefined);
          throw err;
        }
      }

      const prevDb = activeDb;
      const prevName = activeDbFilename;
      activeDb = nextDb;
      activeDbFilename = nextDbName;

      if (prevDb && prevDb !== nextDb) {
        try {
          prevDb.close();
        } catch {
          // Ignore close errors
        }
      }
      if (prevName && prevName !== nextDbName) {
        try {
          currentPool.unlink(prevName);
        } catch {
          // Ignore unlink errors
        }
      }
      // Clean up any other stale catalog files in the SAH pool
      for (const existingName of currentPool.getFileNames()) {
        if (existingName !== nextDbName && existingName.startsWith('/food-catalog-')) {
          try {
            currentPool.unlink(existingName);
          } catch {
            // Ignore unlink errors
          }
        }
      }

      emitStatus({
        status: 'ready',
        tier: syncResult.manifest.tier,
        foodCount: syncResult.manifest.foodCount,
        version: syncResult.manifest.version,
        progressPct: 100,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'OPFS SQLite-WASM initialization failed';
      emitStatus({
        status: 'fallback',
        reason,
      });
    }
  };

  self.addEventListener('message', (event: MessageEvent<WorkerRequestMessage>) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'init') {
      void handleInit(msg.manifest);
      return;
    }

    if (msg.type === 'cancel') {
      cancelledRequestIds.add(msg.requestId);
      if (cancelledRequestIds.size > 100) {
        const first = cancelledRequestIds.values().next().value;
        if (first !== undefined) cancelledRequestIds.delete(first);
      }
      return;
    }

    if (msg.type === 'search') {
      if (msg.requestId > latestSearchRequestId) {
        latestSearchRequestId = msg.requestId;
      }
      if (cancelledRequestIds.has(msg.requestId) || msg.requestId < latestSearchRequestId) {
        cancelledRequestIds.delete(msg.requestId);
        return;
      }
      if (!activeDb) {
        post({ type: 'error', requestId: msg.requestId, message: 'Catalog database not ready' });
        return;
      }
      try {
        const items = searchDb(activeDb, msg.query, {
          limit: msg.limit,
          region: msg.region,
        });
        if (cancelledRequestIds.has(msg.requestId) || msg.requestId < latestSearchRequestId) {
          cancelledRequestIds.delete(msg.requestId);
          return;
        }
        post({ type: 'searchResult', requestId: msg.requestId, items });
      } catch (err) {
        post({
          type: 'error',
          requestId: msg.requestId,
          message: err instanceof Error ? err.message : 'Worker search failed',
        });
      }
      return;
    }

    if (msg.type === 'barcode') {
      if (!activeDb) {
        post({ type: 'barcodeResult', requestId: msg.requestId, item: null });
        return;
      }
      try {
        const item = lookupBarcodeInDb(activeDb, msg.barcode);
        post({ type: 'barcodeResult', requestId: msg.requestId, item });
      } catch {
        post({ type: 'barcodeResult', requestId: msg.requestId, item: null });
      }
      return;
    }

    if (msg.type === 'resolveLegacyIds') {
      if (!activeDb) {
        post({ type: 'legacyIdsResult', requestId: msg.requestId, entries: [] });
        return;
      }
      try {
        const entries = resolveLegacyIdsInDb(activeDb, msg.legacyIds);
        post({ type: 'legacyIdsResult', requestId: msg.requestId, entries });
      } catch {
        post({ type: 'legacyIdsResult', requestId: msg.requestId, entries: [] });
      }
    }
  });
}
