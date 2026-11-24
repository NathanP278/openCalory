import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient, type InStatement } from '@libsql/client';
import {
  CATALOG_SCHEMA_SQL,
  foodItemToCatalogRow,
  type CatalogFoodInput,
  type CatalogManifest,
} from '@/lib/foods/catalog-schema';
import { deduplicateCatalogRecords } from '@/lib/foods/dedup';
import type { AdapterLoadOptions, CatalogAdapter } from './catalog-adapters/types';
import { usdaAdapter } from './catalog-adapters/usda';
import { openNutritionAdapter } from './catalog-adapters/opennutrition';
import { nationalTablesAdapter } from './catalog-adapters/national-tables';
import { menuStatOpenNoshAdapter } from './catalog-adapters/menustat-opennosh';
import { offFoodRepoAdapter } from './catalog-adapters/off-foodrepo';
import { curatedAdapter } from './catalog-adapters/curated';

const BATCH_SIZE = 400;

export interface CompileCatalogMeta {
  tier: 'core' | 'expanded';
  version: string;
  gzipOutPath?: string;
  manifestOutPath?: string;
}

function toLibsqlFileUrl(filePath: string): string {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');
  return `file:${resolved}`;
}

function removeIfExists(filePath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = `${filePath}${suffix}`;
    if (fs.existsSync(candidate)) {
      fs.unlinkSync(candidate);
    }
  }
}

/**
 * Compiles catalog food records into an optimized, read-only SQLite FTS5 database,
 * optionally emitting a `.db.gz` archive and `catalog-manifest.json`.
 *
 * `manifest.sha256` is the hex SHA-256 digest of the **uncompressed** `.db` bytes
 * so browser Workers and server pull scripts can verify integrity after decompression.
 */
export async function compileCatalogToSqlite(
  records: CatalogFoodInput[],
  outputDbPath: string,
  meta: CompileCatalogMeta
): Promise<CatalogManifest> {
  fs.mkdirSync(path.dirname(path.resolve(outputDbPath)), { recursive: true });
  removeIfExists(outputDbPath);

  const { foods, legacyAliases } = deduplicateCatalogRecords(records);

  const builtAt = new Date().toISOString();
  const client = createClient({ url: toLibsqlFileUrl(outputDbPath) });
  try {
    await client.execute('PRAGMA journal_mode = OFF');
    await client.execute('PRAGMA synchronous = OFF');
    await client.execute('PRAGMA temp_store = MEMORY');
    await client.executeMultiple(CATALOG_SCHEMA_SQL);

    const insertFoodSql = `
      INSERT INTO foods (
        id, barcode, source, accuracy_tier, region, category, name, brand, aliases,
        basis, serving_size, serving_unit, serving_weight_grams,
        calories, protein, carbs, fat, fiber,
        micronutrients_json, serving_options_json, search_rank
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    for (let i = 0; i < foods.length; i += BATCH_SIZE) {
      const slice = foods.slice(i, i + BATCH_SIZE);
      const statements: InStatement[] = slice.map((item) => {
        const row = foodItemToCatalogRow(item);
        return {
          sql: insertFoodSql,
          args: [
            row.id,
            row.barcode,
            row.source,
            row.accuracy_tier,
            row.region,
            row.category,
            row.name,
            row.brand,
            row.aliases,
            row.basis,
            row.serving_size,
            row.serving_unit,
            row.serving_weight_grams,
            row.calories,
            row.protein,
            row.carbs,
            row.fat,
            row.fiber,
            row.micronutrients_json,
            row.serving_options_json,
            row.search_rank,
          ],
        };
      });
      await client.batch(statements, 'write');
    }

    // Populate FTS5 index from content='foods'
    await client.execute(`INSERT INTO foods_fts(foods_fts) VALUES('rebuild')`);

    // Insert legacy ID aliases
    const aliasEntries = Array.from(legacyAliases.entries());
    for (let i = 0; i < aliasEntries.length; i += BATCH_SIZE) {
      const slice = aliasEntries.slice(i, i + BATCH_SIZE);
      const statements: InStatement[] = slice.map(([legacyId, canonicalId]) => ({
        sql: `INSERT OR REPLACE INTO food_id_aliases (legacy_id, canonical_id) VALUES (?, ?)`,
        args: [legacyId, canonicalId],
      }));
      await client.batch(statements, 'write');
    }

    const metaRows: Array<[string, string]> = [
      ['version', meta.version],
      ['tier', meta.tier],
      ['built_at', builtAt],
      ['food_count', String(foods.length)],
      ['license', 'ODbL-1.0'],
    ];
    await client.batch(
      metaRows.map(([k, v]) => ({
        sql: `INSERT OR REPLACE INTO catalog_meta (key, value) VALUES (?, ?)`,
        args: [k, v],
      })),
      'write'
    );

    // Optimize FTS5 segments and compact database
    await client.execute(`INSERT INTO foods_fts(foods_fts) VALUES('optimize')`);
    await client.execute('ANALYZE');
    await client.execute('VACUUM');
  } finally {
    client.close();
  }

  const rawBuffer = fs.readFileSync(outputDbPath);
  const sha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex');
  const rawBytes = rawBuffer.byteLength;

  let gzipBytes = 0;
  if (meta.gzipOutPath) {
    fs.mkdirSync(path.dirname(path.resolve(meta.gzipOutPath)), { recursive: true });
    const compressed = zlib.gzipSync(rawBuffer, { level: 9 });
    gzipBytes = compressed.byteLength;
    const tmpGz = `${meta.gzipOutPath}.tmp`;
    fs.writeFileSync(tmpGz, compressed);
    fs.renameSync(tmpGz, meta.gzipOutPath);
  }

  const manifest: CatalogManifest = {
    version: meta.version,
    tier: meta.tier,
    sha256,
    builtAt,
    foodCount: foods.length,
    gzipBytes,
    rawBytes,
    license: 'ODbL-1.0',
  };

  if (meta.manifestOutPath) {
    fs.mkdirSync(path.dirname(path.resolve(meta.manifestOutPath)), { recursive: true });
    const tmpManifest = `${meta.manifestOutPath}.tmp`;
    fs.writeFileSync(tmpManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpManifest, meta.manifestOutPath);
  }

  return manifest;
}

interface CliArgs {
  tier: 'core' | 'expanded';
  csvPath?: string;
  outDir: string;
  offlineOnly: boolean;
  cacheDir: string;
  version: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  let tier: 'core' | 'expanded' = 'core';
  let csvPath: string | undefined;
  let outDir: string | undefined;
  let offlineOnly = false;
  let cacheDir = path.join(os.tmpdir(), 'opencalory-catalog-cache');

  for (const arg of argv) {
    if (arg.startsWith('--tier=')) {
      const val = arg.slice('--tier='.length).trim().toLowerCase();
      if (val === 'core' || val === 'expanded') tier = val;
    } else if (arg.startsWith('--csv=')) {
      csvPath = arg.slice('--csv='.length).trim();
    } else if (arg.startsWith('--out-dir=')) {
      outDir = arg.slice('--out-dir='.length).trim();
    } else if (arg.startsWith('--cache-dir=')) {
      cacheDir = arg.slice('--cache-dir='.length).trim();
    } else if (arg === '--offline-only') {
      offlineOnly = true;
    }
  }

  const defaultOutDir =
    tier === 'core'
      ? path.resolve(process.cwd(), 'public', 'data')
      : path.resolve(process.cwd(), 'data', 'catalog');

  const now = new Date();
  const version = `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, '0')}.${String(now.getUTCDate()).padStart(2, '0')}`;

  return {
    tier,
    csvPath,
    outDir: outDir ? path.resolve(outDir) : defaultOutDir,
    offlineOnly,
    cacheDir,
    version,
  };
}

const ADAPTERS: CatalogAdapter[] = [
  usdaAdapter,
  openNutritionAdapter,
  nationalTablesAdapter,
  menuStatOpenNoshAdapter,
  offFoodRepoAdapter,
  curatedAdapter,
];

export async function runBuildFoodCatalogCli(argv: string[]): Promise<CatalogManifest> {
  const args = parseCliArgs(argv);
  console.log(
    `[food-db:build] Starting ${args.tier} catalog build (version=${args.version}, offlineOnly=${args.offlineOnly})`
  );
  console.log(`[food-db:build] Cache dir: ${args.cacheDir}`);
  console.log(`[food-db:build] Output dir: ${args.outDir}`);

  const loadOpts: AdapterLoadOptions = {
    tier: args.tier,
    cacheDir: args.cacheDir,
    offlineOnly: args.offlineOnly,
    csvPath: args.csvPath,
    projectRoot: process.cwd(),
  };

  const allRecords: CatalogFoodInput[] = [];
  for (const adapter of ADAPTERS) {
    try {
      const loaded = await adapter.load(loadOpts);
      console.log(`[food-db:build] Adapter "${adapter.id}" contributed ${loaded.length} raw record(s).`);
      allRecords.push(...loaded);
    } catch (err) {
      console.warn(
        `[food-db:build] Adapter "${adapter.id}" failed and was skipped: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  console.log(`[food-db:build] Total raw records collected: ${allRecords.length}`);

  const tempDbPath = path.join(args.cacheDir, `food-catalog-${args.tier}.db`);
  const gzipOutPath = path.join(args.outDir, 'food-catalog.db.gz');
  const manifestOutPath = path.join(args.outDir, 'catalog-manifest.json');

  const manifest = await compileCatalogToSqlite(allRecords, tempDbPath, {
    tier: args.tier,
    version: args.version,
    gzipOutPath,
    manifestOutPath,
  });

  // For expanded tier, also keep the uncompressed .db in outDir for direct server reads
  if (args.tier === 'expanded') {
    fs.copyFileSync(tempDbPath, path.join(args.outDir, 'food-catalog.db'));
  }

  const rawMb = (manifest.rawBytes / 1024 / 1024).toFixed(2);
  const gzMb = (manifest.gzipBytes / 1024 / 1024).toFixed(2);
  console.log(
    `[food-db:build] Compiled ${manifest.foodCount} deduplicated foods -> ${gzipOutPath} (${gzMb} MB gz, ${rawMb} MB raw, sha256=${manifest.sha256.slice(0, 12)}...)`
  );

  if (args.tier === 'core' && manifest.gzipBytes > 15 * 1024 * 1024) {
    console.warn(
      `[food-db:build] WARNING: Core .db.gz (${gzMb} MB) exceeds the 15 MB target budget!`
    );
  }

  return manifest;
}

const isDirectCliRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
  runBuildFoodCatalogCli(process.argv.slice(2)).catch((err) => {
    console.error('[food-db:build] Build failed:', err);
    process.exit(1);
  });
}
