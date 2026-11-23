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

const CATALOG_GZIP_FILENAME = 'food-catalog.db.gz';
const CATALOG_MANIFEST_FILENAME = 'catalog-manifest.json';

const FTS_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

const PREP_MODIFIERS = new Set([
  'grilled',
  'steamed',
  'boiled',
  'baked',
  'roasted',
  'fried',
  'pan',
  'seared',
  'sauteed',
  'poached',
  'scrambled',
  'mashed',
  'cooked',
  'raw',
  'fresh',
  'organic',
  'boneless',
  'skinless',
  'fillet',
  'sliced',
  'chopped',
  'diced',
  'minced',
  'shredded',
  'grated',
  'plain',
  'extra',
  'virgin',
  'light',
  'lean',
  'trimmed',
  'peeled',
  'dry',
  'uncooked',
]);

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

function extractQueryTokens(raw: string): string[] {
  if (!raw || typeof raw !== 'string') return [];

  // Normalize possessive "'s" / "’s" so "ben & jerry's" yields ["ben", "jerry"]
  const cleaned = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/(?<=[\p{L}\p{N}])['’]s\b/giu, ' ');

  const rawTokens = cleaned.match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const token of rawTokens) {
    if (FTS_OPERATORS.has(token.toUpperCase())) continue;
    const lower = token.toLowerCase();
    if (!lower || seen.has(lower)) continue;
    seen.add(lower);
    tokens.push(lower);
    if (tokens.length >= 12) break;
  }

  return tokens;
}

export function sanitizeFtsQuery(raw: string): string {
  const tokens = extractQueryTokens(raw);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token}"*`).join(' ');
}

function toCatalogFoodRow(row: Row): CatalogFoodRow {
  return {
    rowid: Number(row.rowid ?? 0),
    id: String(row.id ?? ''),
    barcode: row.barcode == null ? null : String(row.barcode),
    source: String(row.source ?? 'catalog'),
    accuracy_tier: Number(row.accuracy_tier ?? 4),
    region: String(row.region ?? 'GLOBAL'),
    category: String(row.category ?? ''),
    name: String(row.name ?? ''),
    brand: String(row.brand ?? ''),
    aliases: String(row.aliases ?? ''),
    basis: String(row.basis ?? 'per100g'),
    serving_size: Number(row.serving_size ?? 100),
    serving_unit: String(row.serving_unit ?? 'g'),
    serving_weight_grams:
      row.serving_weight_grams == null ? null : Number(row.serving_weight_grams),
    calories: Number(row.calories ?? 0),
    protein: Number(row.protein ?? 0),
    carbs: Number(row.carbs ?? 0),
    fat: Number(row.fat ?? 0),
    fiber: Number(row.fiber ?? 0),
    micronutrients_json: String(row.micronutrients_json ?? '{}'),
    serving_options_json: String(row.serving_options_json ?? '[]'),
    search_rank: Number(row.search_rank ?? 0),
  };
}

interface CandidateRow {
  row: CatalogFoodRow;
  bm25: number;
}

async function runFtsMatchQuery(
  client: Client,
  matchExpr: string,
  fetchLimit: number
): Promise<CandidateRow[]> {
  if (!matchExpr) return [];
  try {
    const res = await client.execute({
      sql: `SELECT f.*, bm25(foods_fts, 10.0, 5.0, 4.0, 1.0) AS fts_bm25
            FROM foods_fts
            JOIN foods f ON f.rowid = foods_fts.rowid
            WHERE foods_fts MATCH ?
            ORDER BY (bm25(foods_fts, 10.0, 5.0, 4.0, 1.0) - (f.search_rank * 0.05) + (f.accuracy_tier * 1.2)) ASC
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

function damerauLevenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  const d: number[][] = Array.from({ length: la + 1 }, () => new Array<number>(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, d[i - 2][j - 2] + 1);
      }
      d[i][j] = val;
    }
  }
  return d[la][lb];
}

function normalizeForScoring(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function bestTokenMatchScore(queryToken: string, fieldTokens: string[]): number {
  let best = 0;
  for (const ft of fieldTokens) {
    if (ft === queryToken) return 1.0;
    if (
      (ft.length === queryToken.length + 1 && ft === `${queryToken}s`) ||
      (queryToken.length === ft.length + 1 && queryToken === `${ft}s`)
    ) {
      best = Math.max(best, 0.96);
      continue;
    }
    if (ft.startsWith(queryToken)) {
      const ratio = queryToken.length / ft.length;
      best = Math.max(best, 0.45 + 0.4 * ratio);
      continue;
    }
    if (queryToken.length >= 4 && Math.abs(ft.length - queryToken.length) <= 2) {
      const dist = damerauLevenshtein(queryToken, ft);
      if (dist === 1) {
        best = Math.max(best, 0.82);
      } else if (dist === 2 && queryToken.length >= 5) {
        best = Math.max(best, 0.58);
      }
    }
  }
  return best;
}

function scoreCandidate(
  candidate: CandidateRow,
  queryTokens: string[],
  queryNorm: string,
  region?: string
): number {
  const { row, bm25 } = candidate;
  const nameNorm = normalizeForScoring(row.name);
  const nameTokens = nameNorm ? nameNorm.split(' ') : [];
  const brandNorm = normalizeForScoring(row.brand);
  const brandTokens = brandNorm ? brandNorm.split(' ') : [];

  const aliasParts = row.aliases
    ? row.aliases
        .split('|')
        .map((a) => normalizeForScoring(a))
        .filter(Boolean)
    : [];
  const aliasTokens = aliasParts.flatMap((a) => a.split(' '));

  let score = Math.min(Math.max(-bm25, 0), 40);

  // Exact name / alias / prefix boosts
  if (nameNorm === queryNorm) {
    score += 140;
  } else if (aliasParts.includes(queryNorm)) {
    score += 105;
  } else if (
    nameNorm.startsWith(`${queryNorm} `) ||
    row.name.toLowerCase().startsWith(`${queryNorm},`) ||
    (nameTokens.length > 0 && queryTokens.length === 1 && (nameTokens[0] === queryTokens[0] || nameTokens[0] === `${queryTokens[0]}s`))
  ) {
    score += 65;
  } else if (nameNorm.startsWith(queryNorm)) {
    score += 22;
  }

  // Token coverage + fuzzy match score
  let matchedCount = 0;
  let tokenScoreSum = 0;
  for (const qt of queryTokens) {
    const inName = bestTokenMatchScore(qt, nameTokens);
    const inAlias = bestTokenMatchScore(qt, aliasTokens) * 0.9;
    const inBrand = bestTokenMatchScore(qt, brandTokens) * 0.75;
    const best = Math.max(inName, inAlias, inBrand);
    tokenScoreSum += best;
    if (best >= 0.55) {
      matchedCount++;
    }
  }

  const coverageRatio = queryTokens.length > 0 ? matchedCount / queryTokens.length : 0;
  score += tokenScoreSum * 28;
  score += coverageRatio * 30;
  if (matchedCount === queryTokens.length && queryTokens.length > 0) {
    score += 25;
  }

  // Accuracy tier bonus
  if (row.accuracy_tier === 1) score += 24;
  else if (row.accuracy_tier === 2) score += 14;
  else if (row.accuracy_tier === 3) score += 6;

  // Search rank contribution
  score += Math.min(Math.max(row.search_rank, 0), 100) * 0.35;

  // Optional regional boost
  if (region && row.region.toUpperCase() === region.trim().toUpperCase()) {
    score += 14;
  }

  // Mild conciseness tie-breaker
  score -= Math.min(row.name.length, 90) * 0.08;

  return score;
}

export async function searchServerCatalog(
  query: string,
  options?: { limit?: number; region?: string }
): Promise<FoodItem[]> {
  const tokens = extractQueryTokens(query);
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

  const queryNorm = tokens.join(' ');
  const ranked = Array.from(candidates.values())
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, tokens, queryNorm, options?.region),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.candidate.row.accuracy_tier !== b.candidate.row.accuracy_tier) {
        return a.candidate.row.accuracy_tier - b.candidate.row.accuracy_tier;
      }
      if (b.candidate.row.search_rank !== a.candidate.row.search_rank) {
        return b.candidate.row.search_rank - a.candidate.row.search_rank;
      }
      return a.candidate.row.name.length - b.candidate.row.name.length;
    })
    .slice(0, limit);

  return ranked.map(({ candidate }) => catalogRowToFoodItem(candidate.row));
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

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const res = await client.execute({
    sql: `SELECT a.legacy_id, f.*
          FROM food_id_aliases a
          JOIN foods f ON f.id = a.canonical_id
          WHERE a.legacy_id IN (${placeholders})`,
    args: uniqueIds,
  });

  for (const row of res.rows) {
    const legacyId = String(row.legacy_id ?? '');
    if (legacyId) {
      result.set(legacyId, catalogRowToFoodItem(toCatalogFoodRow(row)));
    }
  }

  return result;
}
