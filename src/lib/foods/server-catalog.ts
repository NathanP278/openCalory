import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { createClient, type Client, type Row } from '@libsql/client';
import type { FoodItem } from '@/types/nutrition';
import {
  catalogRowToFoodItem,
  type CatalogFoodRow,
  type CatalogManifest,
} from '@/lib/foods/catalog-schema';
import { normalizeBarcode } from '@/lib/foods/dedup';
import {
  PREP_MODIFIERS,
  rankCandidates,
  rowRecordToCatalogFoodRow,
  sanitizeFtsQuery,
  tokenizeQuery,
  type CandidateRow,
} from '@/lib/foods/fts-query';

export { sanitizeFtsQuery };

const CATALOG_GZIP_FILENAME = 'food-catalog.db.gz';
const CATALOG_MANIFEST_FILENAME = 'catalog-manifest.json';

let cachedClient: Client | null = null;
let cachedEnvCatalogDir: string | undefined = undefined;
let initClientPromise: Promise<Client | null> | null = null;

function getCandidateCatalogDirs(): string[] {
  const candidates: string[] = [];
  const envDir = process.env.FOOD_CATALOG_DIR?.trim();
  if (envDir) {
    candidates.push(path.resolve(envDir));
  }
  candidates.push(path.resolve(process.cwd(), 'data', 'catalog'));
  candidates.push('/app/data/catalog');
  candidates.push(path.resolve(process.cwd(), 'public', 'data'));

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const dir of candidates) {
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(dir);
    }
  }
  return unique;
}

async function fileExistsNonEmpty(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function readManifestFromDir(dir: string): Promise<CatalogManifest | null> {
  const manifestPath = path.join(dir, CATALOG_MANIFEST_FILENAME);
  try {
    const raw = await fsp.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CatalogManifest>;
    if (
      parsed &&
      typeof parsed.version === 'string' &&
      typeof parsed.sha256 === 'string' &&
      typeof parsed.foodCount === 'number'
    ) {
      return parsed as CatalogManifest;
    }
    return null;
  } catch {
    return null;
  }
}

async function computeFileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function ensureDecompressedDbPath(
  gzipPath: string,
  manifest: CatalogManifest | null
): Promise<string> {
  const sha256 =
    manifest?.sha256 && /^[a-f0-9]{16,64}$/i.test(manifest.sha256)
      ? manifest.sha256.toLowerCase()
      : await computeFileSha256(gzipPath);

  const targetPath = path.join(os.tmpdir(), `opencalory-food-catalog-${sha256}.db`);
  if (await fileExistsNonEmpty(targetPath)) {
    return targetPath;
  }

  const tmpPath = path.join(
    os.tmpdir(),
    `opencalory-food-catalog-${sha256}.${process.pid}.${Date.now()}.tmp`
  );

  try {
    await pipeline(
      fs.createReadStream(gzipPath),
      zlib.createGunzip(),
      fs.createWriteStream(tmpPath)
    );
    await fsp.rename(tmpPath, targetPath);
    return targetPath;
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => undefined);
    if (await fileExistsNonEmpty(targetPath)) {
      return targetPath;
    }
    throw err;
  }
}

export function resetServerCatalogCache(): void {
  if (cachedClient) {
    try {
      cachedClient.close();
    } catch {
      // Ignore close errors during reset
    }
  }
  cachedClient = null;
  cachedEnvCatalogDir = undefined;
  initClientPromise = null;
}

export async function getActiveCatalogManifest(): Promise<CatalogManifest | null> {
  for (const dir of getCandidateCatalogDirs()) {
    const gzipPath = path.join(dir, CATALOG_GZIP_FILENAME);
    if (!(await fileExistsNonEmpty(gzipPath))) {
      continue;
    }
    const manifest = await readManifestFromDir(dir);
    if (manifest) {
      return manifest;
    }
  }
  return null;
}

export async function getActiveCatalogGzipPath(): Promise<{
  path: string;
  manifest: CatalogManifest | null;
} | null> {
  for (const dir of getCandidateCatalogDirs()) {
    const gzipPath = path.join(dir, CATALOG_GZIP_FILENAME);
    if (await fileExistsNonEmpty(gzipPath)) {
      const manifest = await readManifestFromDir(dir);
      return { path: gzipPath, manifest };
    }
  }
  return null;
}

async function getCatalogClient(): Promise<Client | null> {
  const currentEnvDir = process.env.FOOD_CATALOG_DIR?.trim();
  if (cachedClient && cachedEnvCatalogDir === currentEnvDir) {
    return cachedClient;
  }
  if (cachedClient && cachedEnvCatalogDir !== currentEnvDir) {
    resetServerCatalogCache();
  }
  if (initClientPromise) {
    return initClientPromise;
  }

  initClientPromise = (async () => {
    const active = await getActiveCatalogGzipPath();
    if (!active) {
      return null;
    }
    const dbPath = await ensureDecompressedDbPath(active.path, active.manifest);
    const normalizedPath = dbPath.replace(/\\/g, '/');
    const client = createClient({ url: `file:${normalizedPath}` });
    await client.execute('PRAGMA query_only = ON');
    cachedClient = client;
    cachedEnvCatalogDir = currentEnvDir;
    return client;
  })();

  try {
    const client = await initClientPromise;
    return client;
  } finally {
    initClientPromise = null;
  }
}

function toCatalogFoodRow(row: Row): CatalogFoodRow {
  return rowRecordToCatalogFoodRow(row as unknown as Record<string, unknown>);
}

async function runFtsMatchQuery(
  client: Client,
  matchExpr: string,
  fetchLimit: number
): Promise<CandidateRow[]> {
  if (!matchExpr) return [];
  try {
    const res = await client.execute({
      sql: `SELECT f.rowid, f.*, bm25(foods_fts, 10.0, 5.0, 4.0, 1.0) AS fts_bm25
            FROM foods_fts
            JOIN foods f ON f.rowid = foods_fts.rowid
            WHERE foods_fts MATCH ?
            ORDER BY (fts_bm25 - (f.search_rank * 0.05) + (f.accuracy_tier * 1.2)) ASC
            LIMIT ?`,
      args: [matchExpr, fetchLimit],
    });
    return res.rows.map((r) => ({
      row: toCatalogFoodRow(r),
      bm25: Number(r.fts_bm25 ?? 0),
    }));
  } catch {
    return [];
  }
}

export async function searchServerCatalog(
  query: string,
  options?: { limit?: number; region?: string }
): Promise<FoodItem[]> {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  const client = await getCatalogClient();
  if (!client) return [];

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
  mergeCandidates(await runFtsMatchQuery(client, strictMatch, fetchLimit));

  // Secondary fallbacks when strict query returns < 5 hits
  const canFallback = tokens.length >= 2 || tokens.some((t) => t.length >= 4);
  if (candidates.size < 5 && canFallback) {
    // Fallback 1: Strip prep modifiers
    const coreTokens = tokens.filter((t) => !PREP_MODIFIERS.has(t));
    if (coreTokens.length > 0 && coreTokens.length < tokens.length) {
      const strippedMatch = coreTokens.map((t) => `"${t}"*`).join(' ');
      mergeCandidates(await runFtsMatchQuery(client, strippedMatch, fetchLimit));
    }

    // Fallback 2: Relaxed OR prefix query
    if (candidates.size < 5 && tokens.length >= 2) {
      const orMatch = tokens.map((t) => `"${t}"*`).join(' OR ');
      mergeCandidates(await runFtsMatchQuery(client, orMatch, fetchLimit));
    }

    // Fallback 3: 3-char prefix match for typo tolerance (uses FTS5 prefix='2 3' index)
    if (candidates.size < 5) {
      const prefixTokens = tokens.map((t) => (t.length >= 3 ? t.slice(0, 3) : t));
      const uniquePrefixes = Array.from(new Set(prefixTokens));
      const prefixAndMatch = uniquePrefixes.map((t) => `"${t}"*`).join(' ');
      mergeCandidates(await runFtsMatchQuery(client, prefixAndMatch, fetchLimit));

      if (candidates.size < 5 && uniquePrefixes.length >= 2) {
        const prefixOrMatch = uniquePrefixes.map((t) => `"${t}"*`).join(' OR ');
        mergeCandidates(await runFtsMatchQuery(client, prefixOrMatch, fetchLimit));
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

export async function lookupServerCatalogBarcode(barcode: string): Promise<FoodItem | null> {
  if (!barcode || typeof barcode !== 'string') return null;
  const normalized = normalizeBarcode(barcode);
  const rawDigits = barcode.replace(/\D+/g, '');
  if (!normalized && rawDigits.length < 8) return null;

  const client = await getCatalogClient();
  if (!client) return null;

  const candidates = Array.from(
    new Set([normalized, rawDigits].filter((v): v is string => Boolean(v && v.length >= 8)))
  );
  if (candidates.length === 0) return null;

  const placeholders = candidates.map(() => '?').join(', ');
  const res = await client.execute({
    sql: `SELECT *
          FROM foods
          WHERE barcode IN (${placeholders})
          ORDER BY CASE WHEN barcode = ? THEN 0 ELSE 1 END,
                   accuracy_tier ASC,
                   search_rank DESC
          LIMIT 1`,
    args: [...candidates, normalized ?? candidates[0]],
  });

  if (res.rows.length === 0) return null;
  return catalogRowToFoodItem(toCatalogFoodRow(res.rows[0]));
}

export async function resolveServerLegacyIds(
  legacyIds: string[]
): Promise<Map<string, FoodItem>> {
  const result = new Map<string, FoodItem>();
  if (!Array.isArray(legacyIds) || legacyIds.length === 0) return result;

  const uniqueIds = Array.from(
    new Set(legacyIds.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean))
  );
  if (uniqueIds.length === 0) return result;

  const client = await getCatalogClient();
  if (!client) return result;

  const CHUNK_SIZE = 500;
  for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await client.execute({
      sql: `SELECT a.legacy_id, f.rowid, f.*
            FROM food_id_aliases a
            JOIN foods f ON f.id = a.canonical_id
            WHERE a.legacy_id IN (${placeholders})`,
      args: chunk,
    });

    for (const row of res.rows) {
      const legacyId = String(row.legacy_id ?? '');
      if (legacyId) {
        result.set(legacyId, catalogRowToFoodItem(toCatalogFoodRow(row)));
      }
    }
  }

  return result;
}
