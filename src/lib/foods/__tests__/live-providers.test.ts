// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { resetServerCatalogCache } from '../server-catalog';
import {
  getConfiguredLiveProviders,
  clearLiveProviderCache,
  searchLiveProviders,
  lookupBarcodeLiveProviders,
} from '../live-providers';
import { GET as searchRoute } from '@/app/api/foods/search/route';
import { GET as barcodeRoute } from '@/app/api/foods/barcode/[code]/route';

const PROVIDER_ENV_KEYS = [
  'USDA_API_KEY',
  'FATSECRET_CLIENT_ID',
  'FATSECRET_CLIENT_SECRET',
  'EDAMAM_APP_ID',
  'EDAMAM_APP_KEY',
  'NUTRITIONIX_APP_ID',
  'NUTRITIONIX_APP_KEY',
  'FOOD_CATALOG_DIR',
] as const;

async function buildTempCatalogDir(
  foods: CatalogFoodInput[]
): Promise<{ dir: string; manifest: CatalogManifest }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencalory-live-test-'));
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

  return { dir, manifest };
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('live-providers and unified food API routes', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const tempDirs: string[] = [];

  beforeEach(() => {
    for (const key of PROVIDER_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      if (key !== 'FOOD_CATALOG_DIR') {
        delete process.env[key];
      }
    }
    clearLiveProviderCache();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    for (const key of PROVIDER_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    clearLiveProviderCache();
    resetServerCatalogCache();
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  describe('getConfiguredLiveProviders', () => {
    it('excludes fatsecret, edamam, and nutritionix when env vars are unset', () => {
      const providers = getConfiguredLiveProviders();
      expect(providers).toEqual(['off', 'usda']);
      expect(providers).not.toContain('fatsecret');
      expect(providers).not.toContain('edamam');
      expect(providers).not.toContain('nutritionix');
    });

    it('requires both env vars for each commercial provider before enabling it', () => {
      process.env.FATSECRET_CLIENT_ID = 'fs-id';
      process.env.EDAMAM_APP_ID = 'ed-id';
      process.env.NUTRITIONIX_APP_ID = 'nx-id';
      expect(getConfiguredLiveProviders()).toEqual(['off', 'usda']);

      process.env.FATSECRET_CLIENT_SECRET = 'fs-secret';
      process.env.EDAMAM_APP_KEY = 'ed-key';
      process.env.NUTRITIONIX_APP_KEY = 'nx-key';
      expect(getConfiguredLiveProviders()).toEqual([
        'off',
        'usda',
        'fatsecret',
        'edamam',
        'nutritionix',
      ]);
    });
  });

  describe('searchLiveProviders', () => {
    it('does NOT call commercial APIs when env vars are unset and caches identical queries', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('openfoodfacts.org')) {
          return makeJsonResponse({
            products: [
              {
                code: '4800016644801',
                product_name: 'Lucky Me Pancit Canton',
                brands: 'Lucky Me',
                nutriments: {
                  'energy-kcal_100g': 450,
                  proteins_100g: 9.5,
                  carbohydrates_100g: 62,
                  fat_100g: 18,
                },
                serving_size: '1 pack (60g)',
              },
            ],
          });
        }
        if (url.includes('api.nal.usda.gov')) {
          return makeJsonResponse({
            foods: [
              {
                fdcId: 171287,
                description: 'Egg, whole, raw, fresh',
                dataType: 'SR Legacy',
                foodNutrients: [
                  { nutrientId: 1008, value: 143 },
                  { nutrientId: 1003, value: 12.6 },
                  { nutrientId: 1004, value: 9.5 },
                  { nutrientId: 1005, value: 0.7 },
                ],
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

      const first = await searchLiveProviders('egg');
      expect(first.providersUsed).toEqual(['off', 'usda']);
      expect(first.items.length).toBe(2);
      // Every item must be enriched with servingOptions
      for (const item of first.items) {
        expect(Array.isArray(item.servingOptions)).toBe(true);
        expect(item.servingOptions!.length).toBeGreaterThan(0);
      }

      const calledUrls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(calledUrls.some((u) => u.includes('fatsecret.com'))).toBe(false);
      expect(calledUrls.some((u) => u.includes('edamam.com'))).toBe(false);
      expect(calledUrls.some((u) => u.includes('nutritionix.com'))).toBe(false);

      const callsAfterFirst = fetchMock.mock.calls.length;
      expect(callsAfterFirst).toBe(2);

      // Second identical query must be served from the 30-min cache with 0 extra fetch calls
      const second = await searchLiveProviders('  EGG  ');
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
      expect(second.items.length).toBe(first.items.length);
    });

    it('calls FatSecret, Edamam, and Nutritionix when their env vars are set and caches results', async () => {
      process.env.FATSECRET_CLIENT_ID = 'fs-id';
      process.env.FATSECRET_CLIENT_SECRET = 'fs-secret';
      process.env.EDAMAM_APP_ID = 'ed-id';
      process.env.EDAMAM_APP_KEY = 'ed-key';
      process.env.NUTRITIONIX_APP_ID = 'nx-id';
      process.env.NUTRITIONIX_APP_KEY = 'nx-key';

      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('openfoodfacts.org')) {
          return makeJsonResponse({ products: [] });
        }
        if (url.includes('api.nal.usda.gov')) {
          return makeJsonResponse({ foods: [] });
        }
        if (url.includes('oauth.fatsecret.com/connect/token')) {
          return makeJsonResponse({ access_token: 'mock-fs-token', expires_in: 3600 });
        }
        if (url.includes('platform.fatsecret.com/rest/foods/search')) {
          return makeJsonResponse({
            foods: {
              food: [
                {
                  food_id: '33691',
                  food_name: 'Chicken Adobo',
                  brand_name: 'Lutong Bahay',
                  food_description:
                    'Per 100g - Calories: 210kcal | Fat: 12.00g | Carbs: 4.50g | Protein: 21.00g',
                },
              ],
            },
          });
        }
        if (url.includes('api.edamam.com/api/food-database/v2/parser')) {
          return makeJsonResponse({
            hints: [
              {
                food: {
                  foodId: 'food_ed_1',
                  label: 'Sinigang Mix',
                  brand: 'Knorr',
                  nutrients: {
                    ENERC_KCAL: 220,
                    PROCNT: 3.1,
                    FAT: 0.5,
                    CHOCDF: 50,
                    FIBTG: 2.0,
                  },
                },
                measures: [{ label: 'Tablespoon', weight: 15 }],
              },
            ],
          });
        }
        if (url.includes('trackapi.nutritionix.com/v2/search/instant')) {
          return makeJsonResponse({
            branded: [
              {
                nix_item_id: 'nix_12345',
                food_name: 'Quest Protein Bar Chocolate Chip',
                brand_name: 'Quest',
                serving_qty: 1,
                serving_unit: 'bar',
                serving_weight_grams: 60,
                nf_calories: 190,
                nf_protein: 21,
                nf_total_carbohydrate: 21,
                nf_total_fat: 8,
                nf_dietary_fiber: 14,
              },
            ],
            common: [],
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

      const res = await searchLiveProviders('protein bar');
      expect(res.providersUsed).toEqual(
        expect.arrayContaining(['off', 'usda', 'fatsecret', 'edamam', 'nutritionix'])
      );
      expect(res.items.some((i) => i.source === 'fatsecret')).toBe(true);
      expect(res.items.some((i) => i.source === 'edamam')).toBe(true);
      expect(res.items.some((i) => i.source === 'nutritionix')).toBe(true);

      const callsAfterFirst = fetchMock.mock.calls.length;
      const cached = await searchLiveProviders('protein bar');
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
      expect(cached.items.length).toBe(res.items.length);
    });
  });

  describe('GET /api/foods/search', () => {
    it('returns local catalog results with 0 external fetch calls by default (online=0)', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch');

      const req = new NextRequest('http://localhost:3000/api/foods/search?q=egg');
      const res = await searchRoute(req);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        items: Array<{ id: string; name: string }>;
        source: string;
        providersUsed: string[];
      };
      expect(body.source).toBe('catalog');
      expect(body.providersUsed).toEqual(['catalog']);
      expect(body.items.length).toBeGreaterThan(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('merges and deduplicates local catalog + mocked live results when online=1', async () => {
      const temp = await buildTempCatalogDir([
        {
          id: 'usda:171287',
          barcode: null,
          source: 'usda',
          sourceProvider: 'usda_sr_legacy',
          accuracyTier: 1,
          region: 'US',
          category: 'Dairy and Egg Products',
          name: 'Egg, whole, raw, fresh',
          brand: '',
          basis: 'per100g',
          servingSize: 100,
          servingUnit: 'g',
          nutrientsPerBasis: { calories: 143, protein: 12.6, carbs: 0.7, fat: 9.5, fiber: 0 },
          micronutrientsPerBasis: { cholesterolMg: 372, sodiumMg: 142 },
          updatedAt: 0,
        },
      ]);
      tempDirs.push(temp.dir);
      process.env.FOOD_CATALOG_DIR = temp.dir;
      resetServerCatalogCache();

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('openfoodfacts.org')) {
          return makeJsonResponse({
            products: [
              // Duplicate unbranded raw egg that should deduplicate against Tier 1 catalog egg
              {
                code: '0000000123456',
                product_name: 'Whole Raw Egg',
                nutriments: {
                  'energy-kcal_100g': 143,
                  proteins_100g: 12.6,
                  carbohydrates_100g: 0.7,
                  fat_100g: 9.5,
                },
              },
              // Distinct branded product that should be kept
              {
                code: '4800016644899',
                product_name: 'Century Salted Egg',
                brands: 'Century',
                nutriments: {
                  'energy-kcal_100g': 185,
                  proteins_100g: 13.0,
                  carbohydrates_100g: 1.4,
                  fat_100g: 14.0,
                },
              },
            ],
          });
        }
        if (url.includes('api.nal.usda.gov')) {
          return makeJsonResponse({
            foods: [
              // Exact same fdcId as catalog -> must deduplicate
              {
                fdcId: 171287,
                description: 'Egg, whole, raw, fresh',
                dataType: 'SR Legacy',
                foodNutrients: [
                  { nutrientId: 1008, value: 143 },
                  { nutrientId: 1003, value: 12.6 },
                  { nutrientId: 1004, value: 9.5 },
                  { nutrientId: 1005, value: 0.7 },
                ],
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

      const req = new NextRequest('http://localhost:3000/api/foods/search?q=egg&online=1');
      const res = await searchRoute(req);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        items: Array<{ id: string; name: string }>;
        source: string;
        providersUsed: string[];
      };

      expect(body.source).toBe('catalog+live');
      expect(body.providersUsed).toEqual(expect.arrayContaining(['catalog', 'off', 'usda']));

      // The duplicate USDA + OFF raw eggs should collapse into a single canonical raw egg
      const rawEggEntries = body.items.filter((i) => /raw/i.test(i.name) && /egg/i.test(i.name));
      expect(rawEggEntries.length).toBe(1);
      expect(rawEggEntries[0].id).toBe('usda:171287');

      // The distinct branded salted egg should be preserved
      expect(body.items.some((i) => i.name.includes('Century Salted Egg'))).toBe(true);
    });
  });

  describe('GET /api/foods/barcode/[code]', () => {
    it('returns local catalog hit without calling live OFF, and falls back to live OFF on miss', async () => {
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

      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/api/v2/product/4800016644801.json')) {
          return makeJsonResponse({
            status: 1,
            code: '4800016644801',
            product: {
              code: '4800016644801',
              product_name: 'Lucky Me Pancit Canton Original',
              brands: 'Lucky Me',
              nutriments: {
                'energy-kcal_100g': 450,
                proteins_100g: 9.5,
                carbohydrates_100g: 62,
                fat_100g: 18,
              },
              serving_size: '1 pack (60g)',
            },
          });
        }
        if (url.includes('/api/v2/product/9999999999999.json')) {
          return makeJsonResponse({ status: 0, status_verbose: 'product not found' });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

      // 1. Local catalog hit -> 0 external fetch calls
      const hitReq = new NextRequest('http://localhost:3000/api/foods/barcode/049000042566');
      const hitRes = await barcodeRoute(hitReq, { params: Promise.resolve({ code: '049000042566' }) });
      expect(hitRes.status).toBe(200);
      const hitBody = (await hitRes.json()) as {
        status: string;
        source: string;
        item: { id: string; name: string };
      };
      expect(hitBody.status).toBe('hit');
      expect(hitBody.source).toBe('catalog');
      expect(hitBody.item.id).toBe('catalog:off:0049000042566');
      expect(fetchMock).not.toHaveBeenCalled();

      // 2. Local miss with ?offline=1 -> 404 without external fetch
      const offlineReq = new NextRequest(
        'http://localhost:3000/api/foods/barcode/4800016644801?offline=1'
      );
      const offlineRes = await barcodeRoute(offlineReq, {
        params: Promise.resolve({ code: '4800016644801' }),
      });
      expect(offlineRes.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();

      // 3. Local miss -> falls back to live OFF
      const liveReq = new NextRequest('http://localhost:3000/api/foods/barcode/4800016644801');
      const liveRes = await barcodeRoute(liveReq, {
        params: Promise.resolve({ code: '4800016644801' }),
      });
      expect(liveRes.status).toBe(200);
      const liveBody = (await liveRes.json()) as {
        status: string;
        source: string;
        item: { id: string; name: string; servingOptions?: unknown[] };
      };
      expect(liveBody.status).toBe('hit');
      expect(liveBody.source).toBe('live');
      expect(liveBody.item.name).toBe('Lucky Me Pancit Canton Original');
      expect(Array.isArray(liveBody.item.servingOptions)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // 4. Both catalog and live miss -> 404 { status: 'missing', barcode }
      const missReq = new NextRequest('http://localhost:3000/api/foods/barcode/9999999999999');
      const missRes = await barcodeRoute(missReq, {
        params: Promise.resolve({ code: '9999999999999' }),
      });
      expect(missRes.status).toBe(404);
      const missBody = (await missRes.json()) as { status: string; barcode: string };
      expect(missBody.status).toBe('missing');
      expect(missBody.barcode).toBe('9999999999999');
    });

    it('lookupBarcodeLiveProviders returns null for invalid barcodes without fetching', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      const res = await lookupBarcodeLiveProviders('abc');
      expect(res).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('falls back from OFF miss to opt-in Nutritionix barcode endpoint when configured', async () => {
      process.env.NUTRITIONIX_APP_ID = 'nx-id';
      process.env.NUTRITIONIX_APP_KEY = 'nx-key';

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('openfoodfacts.org/api/v2/product/')) {
          return makeJsonResponse({ status: 0, status_verbose: 'product not found' });
        }
        if (url.includes('trackapi.nutritionix.com/v2/search/item?upc=0049000042599')) {
          return makeJsonResponse({
            foods: [
              {
                nix_item_id: 'nix_barcode_1',
                food_name: 'Sprite Zero Sugar',
                brand_name: 'Sprite',
                serving_qty: 1,
                serving_unit: 'can',
                serving_weight_grams: 355,
                nf_calories: 0,
                nf_protein: 0,
                nf_total_carbohydrate: 0,
                nf_total_fat: 0,
                nf_sodium: 35,
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

      const hit = await lookupBarcodeLiveProviders('0049000042599');
      expect(hit).not.toBeNull();
      expect(hit!.source).toBe('nutritionix');
      expect(hit!.name).toBe('Sprite Zero Sugar');
      expect(Array.isArray(hit!.servingOptions)).toBe(true);
    });
  });

  describe('searchLiveProviders edge cases', () => {
    it('queries regional + world OFF hosts when region is specified and surfaces partialError on provider failure', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('ph.openfoodfacts.org')) {
          return makeJsonResponse({
            products: [
              {
                code: '4800016644801',
                product_name: 'Lucky Me Pancit Canton',
                brands: 'Lucky Me',
                nutriments: {
                  'energy-kcal_100g': 450,
                  proteins_100g: 9.5,
                  carbohydrates_100g: 62,
                  fat_100g: 18,
                },
              },
            ],
          });
        }
        if (url.includes('world.openfoodfacts.org')) {
          return makeJsonResponse({ products: [] });
        }
        if (url.includes('api.nal.usda.gov')) {
          return makeJsonResponse({ error: 'rate limited' }, 429);
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

      const res = await searchLiveProviders('pancit canton', { region: 'ph' });
      expect(res.providersUsed).toEqual(['off']);
      expect(res.partialError).toContain('usda');
      expect(res.items.length).toBe(1);
      expect(res.items[0].region).toBe('PH');

      const urls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('ph.openfoodfacts.org'))).toBe(true);
      expect(urls.some((u) => u.includes('world.openfoodfacts.org'))).toBe(true);
    });
  });
});
