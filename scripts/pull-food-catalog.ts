import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { CatalogManifest } from '@/lib/foods/catalog-schema';

const DEFAULT_RELEASE_BASE_URL =
  'https://github.com/opencalory/opencalory/releases/latest/download';

export interface PullFoodCatalogOptions {
  releaseBaseUrl?: string;
  targetDir?: string;
  timeoutMs?: number;
}

function writeAtomic(destPath: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(path.resolve(destPath)), { recursive: true });
  const tmpPath = `${destPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, destPath);
}

/**
 * Downloads the Expanded Pack `catalog-manifest.json` and `food-catalog.db.gz`,
 * verifies the SHA-256 of the decompressed `.db` bytes against `manifest.sha256`,
 * and atomically installs `food-catalog.db`, `food-catalog.db.gz`, and `catalog-manifest.json`
 * into `targetDir` (defaulting to `process.env.FOOD_CATALOG_DIR || ./data/catalog`).
 */
export async function pullFoodCatalog(
  options?: PullFoodCatalogOptions
): Promise<CatalogManifest> {
  const baseUrl = (
    options?.releaseBaseUrl ||
    process.env.FOOD_CATALOG_RELEASE_URL ||
    DEFAULT_RELEASE_BASE_URL
  ).replace(/\/+$/, '');

  const targetDir = path.resolve(
    options?.targetDir || process.env.FOOD_CATALOG_DIR || path.join(process.cwd(), 'data', 'catalog')
  );
  const timeoutMs = options?.timeoutMs ?? 60_000;

  const manifestUrl = `${baseUrl}/catalog-manifest.json`;
  const dbGzUrl = `${baseUrl}/food-catalog.db.gz`;

  console.log(`[food-db:pull] Fetching manifest from ${manifestUrl}...`);
  const manifestRes = await fetch(manifestUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!manifestRes.ok) {
    throw new Error(
      `Failed to fetch catalog manifest from ${manifestUrl}: ${manifestRes.status} ${manifestRes.statusText}`
    );
  }
  const manifest = (await manifestRes.json()) as CatalogManifest;
  if (!manifest || typeof manifest.sha256 !== 'string' || !manifest.sha256) {
    throw new Error('Invalid catalog-manifest.json: missing sha256');
  }

  console.log(
    `[food-db:pull] Downloading ${manifest.tier} catalog v${manifest.version} (${manifest.foodCount} foods) from ${dbGzUrl}...`
  );
  const gzRes = await fetch(dbGzUrl, { signal: AbortSignal.timeout(timeoutMs * 3) });
  if (!gzRes.ok) {
    throw new Error(
      `Failed to fetch food-catalog.db.gz from ${dbGzUrl}: ${gzRes.status} ${gzRes.statusText}`
    );
  }

  const gzBuffer = Buffer.from(await gzRes.arrayBuffer());
  const rawBuffer = zlib.gunzipSync(gzBuffer);
  const actualSha = crypto.createHash('sha256').update(rawBuffer).digest('hex');

  if (actualSha !== manifest.sha256) {
    throw new Error(
      `SHA-256 verification failed for food-catalog.db! Expected ${manifest.sha256}, got ${actualSha}`
    );
  }

  fs.mkdirSync(targetDir, { recursive: true });
  writeAtomic(path.join(targetDir, 'food-catalog.db'), rawBuffer);
  writeAtomic(path.join(targetDir, 'food-catalog.db.gz'), gzBuffer);
  writeAtomic(
    path.join(targetDir, 'catalog-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  console.log(
    `[food-db:pull] Verified SHA-256 (${actualSha.slice(0, 12)}...) and installed catalog to ${targetDir}`
  );
  return manifest;
}

const isDirectCliRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
  let releaseBaseUrl: string | undefined;
  let targetDir: string | undefined;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--url=')) {
      releaseBaseUrl = arg.slice('--url='.length).trim();
    } else if (arg.startsWith('--dir=')) {
      targetDir = arg.slice('--dir='.length).trim();
    }
  }

  pullFoodCatalog({ releaseBaseUrl, targetDir }).catch((err) => {
    console.error('[food-db:pull] Pull failed:', err);
    process.exit(1);
  });
}
