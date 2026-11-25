// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import { NextRequest } from 'next/server';
import {
  CATALOG_SCHEMA_SQL,
  foodItemToCatalogRow,
  type CatalogFoodInput,
  type CatalogManifest,
} from '../catalog-schema';
import {
  sanitizeFtsQuery,
  resetServerCatalogCache,
  getActiveCatalogManifest,
  getActiveCatalogGzipPath,
  searchServerCatalog,
  lookupServerCatalogBarcode,
  resolveServerLegacyIds,
} from '../server-catalog';
import { GET as getManifestRoute } from '@/app/api/foods/manifest/route';
import { GET as getCatalogRoute } from '@/app/api/foods/catalog/route';

async function buildTempCatalogDir(
  foods: CatalogFoodInput[],
  legacyAliases: Array<{ legacyId: string; canonicalId: string }> = [],
  barcodeAliases: Array<{ barcode: string; canonicalId: string }> = []
): Promise<{ dir: string; manifest: CatalogManifest; gzipBytes: Buffer }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencalory-test-catalog-'));
  const rawDbPath = path.join(dir, 'temp-build.db');
  const client = createClient({ url: `file:${rawDbPath.replace(/\\/g, '/')}` });

  try {
    await client.executeMultiple(CATALOG_SCHEMA_SQL);
    for (const item of foods) {
      const row = foodItemToCatalogRow(item);
      const res = await client.execute({
        sql: `INSERT INTO foods (
          id, barcode, source, accuracy_tier, region, category, name, brand, aliases,
          basis, serving_size, serving_unit, serving_weight_grams,
          calories, protein, carbs, fat, fiber,
          micronutrients_json, serving_options_json, search_rank
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      });
      await client.execute({
        sql: `INSERT INTO foods_fts (rowid, name, brand, aliases, category)
              VALUES (?, ?, ?, ?, ?)`,
        args: [Number(res.lastInsertRowid), row.name, row.brand, row.aliases, row.category],
      });
    }

    for (const alias of legacyAliases) {
      await client.execute({
        sql: `INSERT INTO food_id_aliases (legacy_id, canonical_id) VALUES (?, ?)`,
        args: [alias.legacyId, alias.canonicalId],
      });
    }

    for (const alias of barcodeAliases) {
      await client.execute({
        sql: `INSERT INTO food_barcode_aliases (barcode, canonical_id) VALUES (?, ?)`,
        args: [alias.barcode, alias.canonicalId],
      });
    }
  } finally {
    client.close();
  }

  const rawBytes = await fs.readFile(rawDbPath);
  const gzipBytes = zlib.gzipSync(rawBytes);
  const sha256 = crypto.createHash('sha256').update(gzipBytes).digest('hex');

  const manifest: CatalogManifest = {
    version: '2026.11.23-test',
    tier: 'core',
    sha256,
    builtAt: new Date().toISOString(),
    foodCount: foods.length,
    gzipBytes: gzipBytes.byteLength,
    rawBytes: rawBytes.byteLength,
    license: 'ODbL-1.0',
  };

  await fs.writeFile(path.join(dir, 'food-catalog.db.gz'), gzipBytes);
  await fs.writeFile(path.join(dir, 'catalog-manifest.json'), JSON.stringify(manifest, null, 2));

  return { dir, manifest, gzipBytes };
}

describe('server-catalog', () => {
  const originalCatalogDir = process.env.FOOD_CATALOG_DIR;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (originalCatalogDir === undefined) {
      delete process.env.FOOD_CATALOG_DIR;
    } else {
      process.env.FOOD_CATALOG_DIR = originalCatalogDir;
    }
    resetServerCatalogCache();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  describe('sanitizeFtsQuery (Review Focus #1)', () => {
    it('safely sanitizes punctuation, FTS5 operators, and empty inputs', () => {
      expect(sanitizeFtsQuery("ben & jerry's")).toBe('"ben"* "jerry"*');
      expect(sanitizeFtsQuery('coca-cola')).toBe('"coca"* "cola"*');
      expect(sanitizeFtsQuery('2% milk')).toBe('"2"* "milk"*');
      expect(sanitizeFtsQuery('egg (raw)')).toBe('"egg"* "raw"*');
      expect(sanitizeFtsQuery('OR NOT *')).toBe('');
      expect(sanitizeFtsQuery('AND OR NOT NEAR')).toBe('');
      expect(sanitizeFtsQuery('')).toBe('');
      expect(sanitizeFtsQuery('   \t\n  ')).toBe('');
      expect(sanitizeFtsQuery('*** : ^ + / () ""')).toBe('');
    });

    it('never throws FTS5 syntax errors when searching special-character queries against the real catalog', async () => {
      const queries = [
        "ben & jerry's",
        'coca-cola',
        '2% milk',
        'egg (raw)',
        'OR NOT *',
        '',
        '   ',
        'foo:bar^2 + "baz" / (test)',
      ];

      for (const q of queries) {
        const results = await searchServerCatalog(q);
        expect(Array.isArray(results)).toBe(true);
      }

      const milkResults = await searchServerCatalog('2% milk');
      expect(milkResults.length).toBeGreaterThan(0);

      const eggRawResults = await searchServerCatalog('egg (raw)');
      expect(eggRawResults.length).toBeGreaterThan(0);

      expect(await searchServerCatalog('OR NOT *')).toEqual([]);
      expect(await searchServerCatalog('')).toEqual([]);
    });
  });

  describe('real Core SQLite catalog search quality', () => {
    it('returns deduplicated whole eggs near the top for "egg" with household & metric/imperial servingOptions', async () => {
      const results = await searchServerCatalog('egg', { limit: 10 });
      expect(results.length).toBeGreaterThan(0);

      const top5 = results.slice(0, 5);
      const wholeEgg = top5.find(
        (item) =>
          /\begg(s)?\b/i.test(item.name) &&
          !/eggplant|white|yolk|noodle|salad|roll|substitute/i.test(item.name) &&
          Array.isArray(item.servingOptions) &&
          item.servingOptions.length > 0
      );
      expect(wholeEgg).toBeDefined();

      const units = new Set(
        (wholeEgg!.servingOptions ?? []).map((opt) => opt.unit.toLowerCase())
      );
      const ids = new Set(
        (wholeEgg!.servingOptions ?? []).map((opt) => opt.id.toLowerCase())
      );
      const labels = (wholeEgg!.servingOptions ?? []).map((opt) => opt.label.toLowerCase());

      const hasUnitOrLabel = (token: string) =>
        units.has(token) ||
        ids.has(token) ||
        labels.some((l) => l.includes(token));

      expect(hasUnitOrLabel('large')).toBe(true);
      expect(hasUnitOrLabel('medium')).toBe(true);
      expect(hasUnitOrLabel('pc')).toBe(true);
      expect(hasUnitOrLabel('g')).toBe(true);
      expect(hasUnitOrLabel('oz')).toBe(true);
    });

    it('returns cooked white rice with cup and g in servingOptions for "white japanese rice"', async () => {
      const results = await searchServerCatalog('white japanese rice', { limit: 10 });
      expect(results.length).toBeGreaterThan(0);

      const whiteRice = results.slice(0, 5).find(
        (item) =>
          /rice/i.test(item.name) &&
          (/white/i.test(item.name) ||
            (item.aliases ?? []).some((a) => /white rice|gohan|japanese/i.test(a)))
      );
      expect(whiteRice).toBeDefined();

      const units = new Set(
        (whiteRice!.servingOptions ?? []).map((opt) => opt.unit.toLowerCase())
      );
      expect(units.has('cup')).toBe(true);
      expect(units.has('g')).toBe(true);
    });

    it('returns chicken breast results for typo query "chiken brest"', async () => {
      const results = await searchServerCatalog('chiken brest', { limit: 10 });
      expect(results.length).toBeGreaterThan(0);

      const hasChickenBreast = results
        .slice(0, 5)
        .some((item) => /chicken/i.test(item.name) && /breast/i.test(item.name));
      expect(hasChickenBreast).toBe(true);
    });
  });

  describe('barcode lookup and legacy ID resolution', () => {
    it('matches normalized UPC-A (12-digit) and EAN-13 (13-digit) barcodes via lookupServerCatalogBarcode', async () => {
      const temp = await buildTempCatalogDir([
        {
          id: 'catalog:off:0049000042566',
          barcode: '0049000042566',
          source: 'off',
          sourceProvider: 'off',
          accuracyTier: 4,
          region: 'US',
          category: 'Beverages',
          name: 'Coca-Cola Zero Sugar',
          brand: 'Coca-Cola',
          basis: 'per100ml',
          servingSize: 355,
          servingUnit: 'ml',
          servingWeightGrams: 355,
          nutrientsPerBasis: { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
          micronutrientsPerBasis: { sodiumMg: 11 },
          updatedAt: 0,
        },
      ]);
      tempDirs.push(temp.dir);
      process.env.FOOD_CATALOG_DIR = temp.dir;
      resetServerCatalogCache();

      // 12-digit UPC-A should normalize to 13-digit leading-zero EAN-13
      const fromUpcA = await lookupServerCatalogBarcode('049000042566');
      expect(fromUpcA).not.toBeNull();
      expect(fromUpcA!.id).toBe('catalog:off:0049000042566');

      // 13-digit EAN-13 with formatting hyphens/spaces
      const fromEan13 = await lookupServerCatalogBarcode('00490-0004-2566');
      expect(fromEan13).not.toBeNull();
      expect(fromEan13!.id).toBe('catalog:off:0049000042566');

      // Unknown barcode returns null
      expect(await lookupServerCatalogBarcode('9999999999999')).toBeNull();
      expect(await lookupServerCatalogBarcode('abc')).toBeNull();
    });

    it('resolves merged store-brand barcodes via food_barcode_aliases fallback', async () => {
      const temp = await buildTempCatalogDir(
        [
          {
            id: 'catalog:usda:pb-canonical',
            barcode: '0051500255162',
            source: 'usda',
            sourceProvider: 'usda_foundation',
            accuracyTier: 1,
            region: 'US',
            category: 'Nut Butters',
            name: 'Peanut Butter, Creamy',
            basis: 'per100g',
            servingSize: 32,
            servingUnit: 'tbsp',
            servingWeightGrams: 32,
            nutrientsPerBasis: { calories: 598, protein: 22, carbs: 22, fat: 51, fiber: 5 },
            micronutrientsPerBasis: {},
            updatedAt: 0,
          },
        ],
        [],
        [{ barcode: '0011110838049', canonicalId: 'catalog:usda:pb-canonical' }]
      );
      tempDirs.push(temp.dir);
      process.env.FOOD_CATALOG_DIR = temp.dir;
      resetServerCatalogCache();

      // 12-digit UPC-A of merged store-brand jar resolves to canonical Peanut Butter
      const resolved = await lookupServerCatalogBarcode('011110838049');
      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe('catalog:usda:pb-canonical');
      expect(resolved!.name).toBe('Peanut Butter, Creamy');
    });

    it('resolves known legacy staple:* / ph:* IDs from food_id_aliases in the real catalog', async () => {
      // Inspect the real catalog's food_id_aliases table via the active decompressed DB to get real legacy IDs
      const active = await getActiveCatalogGzipPath();
      expect(active).not.toBeNull();

      // Verify batch resolution against known staple/ph prefixes in the real catalog
      const knownCandidates = [
        'staple:egg-whole-large',
        'staple:egg-whole',
        'staple:chicken-breast',
        'staple:white-rice',
        'staple:ph-rice',
        'ph:white-rice',
        'ph:chicken-adobo',
        'ph:sinigang-na-baboy',
        'ph:tapsilog',
      ];

      // Also grab real legacy IDs from the catalog itself to ensure we test actual seeded aliases
      const rawGz = await fs.readFile(active!.path);
      const tempInspectDb = path.join(os.tmpdir(), `opencalory-inspect-${Date.now()}.db`);
      await fs.writeFile(tempInspectDb, zlib.gunzipSync(rawGz));
      const inspectClient = createClient({ url: `file:${tempInspectDb.replace(/\\/g, '/')}` });
      let sampleLegacyIds: string[] = [];
      try {
        const aliasRes = await inspectClient.execute(
          `SELECT legacy_id FROM food_id_aliases WHERE legacy_id LIKE 'staple:%' OR legacy_id LIKE 'ph:%' LIMIT 5`
        );
        sampleLegacyIds = aliasRes.rows.map((r) => String(r.legacy_id));
      } finally {
        inspectClient.close();
        await fs.unlink(tempInspectDb).catch(() => undefined);
      }

      const idsToResolve = sampleLegacyIds.length > 0 ? sampleLegacyIds : knownCandidates;
      expect(idsToResolve.length).toBeGreaterThan(0);

      const resolved = await resolveServerLegacyIds([...idsToResolve, 'nonexistent:legacy-id']);
      expect(resolved.size).toBeGreaterThan(0);
      for (const id of sampleLegacyIds) {
        const food = resolved.get(id);
        expect(food).toBeDefined();
        expect(food!.id).toBeTruthy();
        expect(food!.name).toBeTruthy();
      }
      expect(resolved.has('nonexistent:legacy-id')).toBe(false);
    });
  });

  describe('API routes: /api/foods/manifest and /api/foods/catalog', () => {
    it('GET /api/foods/manifest returns active manifest JSON with Cache-Control', async () => {
      const expected = await getActiveCatalogManifest();
      expect(expected).not.toBeNull();

      const res = await getManifestRoute();
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');

      const body = (await res.json()) as CatalogManifest;
      expect(body.version).toBe(expected!.version);
      expect(body.sha256).toBe(expected!.sha256);
      expect(body.foodCount).toBe(expected!.foodCount);
    });

    it('GET /api/foods/catalog streams gzipped catalog with ETag/Content-Length and returns 304 on If-None-Match', async () => {
      const manifest = await getActiveCatalogManifest();
      expect(manifest).not.toBeNull();

      const req = new NextRequest('http://localhost:3000/api/foods/catalog');
      const res = await getCatalogRoute(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/gzip');
      expect(res.headers.get('etag')).toBe(`"${manifest!.sha256}"`);
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(Number(res.headers.get('content-length'))).toBe(manifest!.gzipBytes);

      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.byteLength).toBe(manifest!.gzipBytes);
      // Gzip magic bytes 0x1f 0x8b
      expect(buf[0]).toBe(0x1f);
      expect(buf[1]).toBe(0x8b);

      // Conditional GET with matching ETag -> 304 Not Modified
      const req304 = new NextRequest('http://localhost:3000/api/foods/catalog', {
        headers: { 'if-none-match': `"${manifest!.sha256}"` },
      });
      const res304 = await getCatalogRoute(req304);
      expect(res304.status).toBe(304);
      expect(res304.headers.get('etag')).toBe(`"${manifest!.sha256}"`);
    });
  });
});
