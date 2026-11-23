// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';

import {
  passesMacroQualityGate,
  computeSearchRank,
} from '../catalog-adapters/types';
import { parseUsdaFoodRecord } from '../catalog-adapters/usda';
import { parseOpenNutritionTsv } from '../catalog-adapters/opennutrition';
import {
  parseNationalTableCsv,
  parseNationalTableRows,
} from '../catalog-adapters/national-tables';
import {
  parseMenuStatCsv,
  parseOpenNoshJson,
} from '../catalog-adapters/menustat-opennosh';
import {
  parseOffJsonlLines,
  parseFoodRepoJson,
  streamOffJsonlFile,
} from '../catalog-adapters/off-foodrepo';
import { loadCuratedFromFiles } from '../catalog-adapters/curated';
import { compileCatalogToSqlite } from '../build-food-catalog';
import { catalogRowToFoodItem, type CatalogFoodInput, type CatalogFoodRow } from '@/lib/foods/catalog-schema';

describe('Compiler Pipeline — Macro Quality Gate (Review Focus #3)', () => {
  it('rejects zero-macro stubs across all tiers', () => {
    const zeroStub = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
    expect(passesMacroQualityGate(zeroStub, 1)).toBe(false);
    expect(passesMacroQualityGate(zeroStub, 2)).toBe(false);
    expect(passesMacroQualityGate(zeroStub, 3)).toBe(false);
    expect(passesMacroQualityGate(zeroStub, 4)).toBe(false);
  });

  it('rejects NaN and negative macros', () => {
    expect(
      passesMacroQualityGate({ calories: Number.NaN, protein: 10, carbs: 10, fat: 2, fiber: 0 }, 1)
    ).toBe(false);
    expect(
      passesMacroQualityGate({ calories: 100, protein: -1, carbs: 10, fat: 2, fiber: 0 }, 1)
    ).toBe(false);
    expect(
      passesMacroQualityGate({ calories: 100, protein: 5, carbs: 10, fat: 2, fiber: -0.5 }, 2)
    ).toBe(false);
  });

  it('rejects kJ-stuffed values (calories > 950 per 100g)', () => {
    const kjStuffed = { calories: 1600, protein: 10, carbs: 70, fat: 5, fiber: 3 };
    expect(passesMacroQualityGate(kjStuffed, 1)).toBe(false);
    expect(passesMacroQualityGate(kjStuffed, 4)).toBe(false);
  });

  it('rejects Tier 4 crowdsourced items that violate Atwater energy balance by > max(50, 25%)', () => {
    // 4*2 + 4*10 + 9*1 = 57 kcal, but reported calories = 400 (diff 343 > max(50, 100))
    const inconsistentOff = { calories: 400, protein: 2, carbs: 10, fat: 1, fiber: 0 };
    expect(passesMacroQualityGate(inconsistentOff, 4)).toBe(false);

    // 4*5 + 4*5 + 9*2 = 58 kcal, reported = 140 (diff 82 > max(50, 35))
    const inconsistentLow = { calories: 140, protein: 5, carbs: 5, fat: 2, fiber: 0 };
    expect(passesMacroQualityGate(inconsistentLow, 4)).toBe(false);
  });

  it('accepts valid whole foods, oils, and consistent Tier 4 branded foods', () => {
    // Egg: 143 kcal, 12.6P, 0.7C, 9.5F (Atwater = 138.7)
    expect(
      passesMacroQualityGate({ calories: 143, protein: 12.6, carbs: 0.7, fat: 9.5, fiber: 0 }, 1)
    ).toBe(true);
    // Olive oil: 884 kcal, 0P, 0C, 100F
    expect(
      passesMacroQualityGate({ calories: 884, protein: 0, carbs: 0, fat: 100, fiber: 0 }, 1)
    ).toBe(true);
    // Valid Tier 4 branded snack: 4*8 + 4*60 + 9*12 = 380, reported 390
    expect(
      passesMacroQualityGate({ calories: 390, protein: 8, carbs: 60, fat: 12, fiber: 4 }, 4)
    ).toBe(true);
    // Low-calorie Tier 4 item (<= 20 kcal) is allowed if non-zero
    expect(
      passesMacroQualityGate({ calories: 15, protein: 0.5, carbs: 3, fat: 0, fiber: 0.5 }, 4)
    ).toBe(true);
  });

  it('computes higher search rank for Tier 1 whole foods than Tier 4 crowdsourced items', () => {
    const tier1 = computeSearchRank({
      accuracyTier: 1,
      name: 'Whole Egg (Raw)',
      region: 'US',
      servingOptions: [
        { id: 'large', label: 'large (50g)', unit: 'large', grams: 50, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
      micronutrientsPerBasis: { sodiumMg: 142, ironMg: 1.75, calciumMg: 56 },
    });
    const tier4 = computeSearchRank({
      accuracyTier: 4,
      name: 'Generic Brand Super Long Description Egg Product Pack',
      brand: 'SomeBrand',
      region: 'GLOBAL',
      servingOptions: [{ id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 }],
      micronutrientsPerBasis: {},
    });
    expect(tier1).toBeGreaterThan(tier4);
  });
});

describe('Compiler Pipeline — Adapter Pure Row Parsers', () => {
  it('parses USDA Foundation/SR/FNDDS payload with foodPortions, clean name, aliases, and legacy IDs', () => {
    const record = parseUsdaFoodRecord(
      {
        fdcId: 171287,
        description: 'Egg, whole, raw, fresh',
        dataType: 'SR Legacy',
        foodCategory: { description: 'Dairy and Egg Products' },
        foodNutrients: [
          { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'kcal' }, amount: 143 },
          { nutrient: { id: 1062, number: '268', name: 'Energy', unitName: 'kJ' }, amount: 598 },
          { nutrient: { id: 1003, number: '203', name: 'Protein', unitName: 'g' }, amount: 12.56 },
          { nutrient: { id: 1005, number: '205', name: 'Carbohydrate', unitName: 'g' }, amount: 0.72 },
          { nutrient: { id: 1004, number: '204', name: 'Total lipid (fat)', unitName: 'g' }, amount: 9.51 },
          { nutrient: { id: 1093, number: '307', name: 'Sodium', unitName: 'mg' }, amount: 142 },
        ],
        foodPortions: [
          { amount: 1, modifier: 'large', gramWeight: 50 },
          { amount: 1, modifier: 'medium', gramWeight: 44 },
          { amount: 1, measureUnit: { name: 'cup', abbreviation: 'cup' }, gramWeight: 243 },
        ],
      },
      'sr_legacy'
    );

    expect(record).not.toBeNull();
    expect(record!.name).toBe('Whole Egg (Raw)');
    expect(record!.accuracyTier).toBe(1);
    expect(record!.nutrientsPerBasis.calories).toBe(143);
    expect(record!.legacyIds).toContain('staple:171287');
    expect(record!.legacyIds).toContain('usda:171287');
    expect(record!.aliases).toContain('Egg, whole, raw, fresh');
    expect(record!.aliases).toContain('itlog');
    const units = (record!.servingOptions ?? []).map((o) => o.unit);
    expect(units).toContain('large');
    expect(units).toContain('medium');
    expect(units).toContain('cup');
    expect(units).toContain('g');
    expect(units).toContain('oz');
  });

  it('parses OpenNutrition ODbL TSV rows (JSON-in-TSV and flat formats)', () => {
    const tsv = [
      'id\tname\talternate_names\ttype\tbrand\tean_13\tserving\tnutrition_100g',
      [
        'on_001',
        'Chicken Burrito Bowl',
        '["burrito bowl","chipotle style bowl"]',
        'restaurant',
        'Chipotle',
        '',
        '{"common":{"quantity":1,"unit":"bowl"},"metric":{"quantity":450,"unit":"g"}}',
        '{"calories":145,"protein":11.5,"carbohydrates":14.2,"total_fat":4.8,"dietary_fiber":2.5,"sodium":320}',
      ].join('\t'),
      [
        'on_002',
        'Zero Stub Item',
        '[]',
        'grocery',
        'BadBrand',
        '',
        '',
        '{"calories":0,"protein":0,"carbohydrates":0,"total_fat":0}',
      ].join('\t'),
    ].join('\n');

    const items = parseOpenNutritionTsv(tsv);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Chicken Burrito Bowl');
    expect(items[0].brand).toBe('Chipotle');
    expect(items[0].accuracyTier).toBe(3);
    expect(items[0].nutrientsPerBasis.calories).toBe(145);
    expect(items[0].servingOptions?.some((o) => o.unit === 'bowl' && o.grams === 450)).toBe(true);
  });

  it('parses National Food Composition Table rows (e.g. Japan MEXT & UK CoFID)', () => {
    const jpItems = parseNationalTableRows('mext', [
      {
        id: '01088',
        name: 'Rice, white, short-grain, cooked',
        category: 'Cereals',
        calories: 156,
        protein: 2.5,
        carbs: 37.1,
        fat: 0.3,
        fiber: 0.3,
        sodiumMg: 1,
      },
    ]);

    expect(jpItems).toHaveLength(1);
    expect(jpItems[0].region).toBe('JP');
    expect(jpItems[0].accuracyTier).toBe(1);
    expect(jpItems[0].sourceProvider).toBe('mext');
    expect(jpItems[0].name).toContain('Rice');
    expect(jpItems[0].aliases?.some((a) => a.toLowerCase().includes('gohan'))).toBe(true);
    expect(jpItems[0].servingOptions?.some((o) => o.unit === 'cup')).toBe(true);
  });

  it('parses national-table CSV with quoted comma-containing food names without shifting columns', () => {
    const csv = [
      'id,name,category,calories,protein,carbs,fat,fiber,sodium_mg',
      '01088,"Rice, white, cooked","Cereals, grains",156,2.5,37.1,0.3,0.3,1',
      '01089,"Chicken, breast, ""skinless"", raw",Poultry,120,22.5,0,2.6,0,45',
    ].join('\n');

    const rows = parseNationalTableCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('Rice, white, cooked');
    expect(rows[0].calories).toBe('156');
    expect(rows[0].protein).toBe('2.5');
    expect(rows[0].carbs).toBe('37.1');

    const items = parseNationalTableRows('mext', rows);
    expect(items).toHaveLength(2);
    expect(items[0].nutrientsPerBasis).toEqual({
      calories: 156,
      protein: 2.5,
      carbs: 37.1,
      fat: 0.3,
      fiber: 0.3,
    });
    expect(items[0].micronutrientsPerBasis.sodiumMg).toBe(1);
    expect(items[1].nutrientsPerBasis.protein).toBe(22.5);
    expect(items[1].micronutrientsPerBasis.sodiumMg).toBe(45);
  });

  it('streams multiple barcode-less OFF JSONL records in the same region with unique IDs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macroai-off-stream-test-'));
    try {
      const jsonlPath = path.join(tmpDir, 'off-sample.jsonl');
      const lines = [
        JSON.stringify({
          code: '',
          product_name: 'Taho Sweet Silken Tofu',
          countries_tags: ['en:philippines'],
          nutriments: { 'energy-kcal_100g': 90, proteins_100g: 4.5, carbohydrates_100g: 15, fat_100g: 1.5, fiber_100g: 0.5 },
        }),
        JSON.stringify({
          code: '',
          product_name: 'Pandesal Bread Roll',
          countries_tags: ['en:philippines'],
          nutriments: { 'energy-kcal_100g': 290, proteins_100g: 9, carbohydrates_100g: 54, fat_100g: 4, fiber_100g: 2 },
        }),
        JSON.stringify({
          code: '',
          product_name: 'Ensaymada Sweet Bun',
          countries_tags: ['en:philippines'],
          nutriments: { 'energy-kcal_100g': 380, proteins_100g: 8, carbohydrates_100g: 50, fat_100g: 16, fiber_100g: 1.5 },
        }),
      ];
      fs.writeFileSync(jsonlPath, `${lines.join('\n')}\n`, 'utf8');

      const streamed = await streamOffJsonlFile(jsonlPath, 'core', { PH: 2 });
      expect(streamed).toHaveLength(2);
      const ids = streamed.map((i) => i.id);
      expect(new Set(ids).size).toBe(2);
      expect(ids).toEqual(['off:ph-1', 'off:ph-2']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parses MenuStat CSV and OpenNosh JSON fixtures', () => {
    const menuStatCsv = [
      'Menu_Item_ID,Restaurant,Item_Name,Food_Category,Serving_Size,Serving_Size_Unit,Calories,Total_Fat,Protein,Carbohydrates,Dietary_Fiber,Sodium',
      'ms101,Subway,"6"" Oven Roasted Turkey Sub",Sandwiches,230,g,270,3.5,18,40,5,810',
      'ms102,Subway,"Empty Stub",Beverages,100,ml,0,0,0,0,0,0',
    ].join('\n');

    const menuItems = parseMenuStatCsv(menuStatCsv);
    expect(menuItems).toHaveLength(1);
    expect(menuItems[0].brand).toBe('Subway');
    expect(menuItems[0].basis).toBe('perServing');
    expect(menuItems[0].servingWeightGrams).toBe(230);
    expect(menuItems[0].nutrientsPerBasis.calories).toBe(270);

    const openNoshJson = JSON.stringify({
      foods: [
        {
          id: 'onosh-1',
          name: 'Matcha Green Tea Latte',
          brand: 'Community',
          region: 'JP',
          category: 'Beverages',
          calories: 62,
          protein: 2.8,
          carbs: 8.5,
          fat: 1.8,
          fiber: 0.3,
        },
      ],
    });

    const noshItems = parseOpenNoshJson(openNoshJson);
    expect(noshItems).toHaveLength(1);
    expect(noshItems[0].name).toBe('Matcha Green Tea Latte');
    expect(noshItems[0].region).toBe('JP');
  });

  it('parses OFF JSONL enforcing quality gate and non-US regional quotas, plus FoodRepo JSON', () => {
    const offLines = [
      // Valid PH product
      JSON.stringify({
        code: '4800016644801',
        product_name: 'Century Tuna Flakes in Oil',
        brands: 'Century',
        countries_tags: ['en:philippines'],
        categories_tags: ['en:canned-tuna'],
        serving_size: '1 can (155g)',
        nutriments: {
          'energy-kcal_100g': 185,
          proteins_100g: 16,
          carbohydrates_100g: 2,
          fat_100g: 12.5,
          fiber_100g: 0,
        },
      }),
      // Second PH product (exceeds quota of 1 in this test)
      JSON.stringify({
        code: '4800016644802',
        product_name: 'Lucky Me Pancit Canton',
        brands: 'Lucky Me',
        countries_tags: ['en:philippines'],
        nutriments: {
          'energy-kcal_100g': 460,
          proteins_100g: 9,
          carbohydrates_100g: 62,
          fat_100g: 19,
          fiber_100g: 2,
        },
      }),
      // Valid JP product
      JSON.stringify({
        code: '4901305123456',
        product_name: 'Calorie Mate Cheese',
        brands: 'Otsuka',
        countries_tags: ['en:japan'],
        nutriments: {
          'energy-kcal_100g': 500,
          proteins_100g: 10.5,
          carbohydrates_100g: 52.5,
          fat_100g: 27.5,
          fiber_100g: 2.5,
        },
      }),
      // Bad Atwater-inconsistent OFF row (must be rejected)
      JSON.stringify({
        code: '3017620422003',
        product_name: 'Corrupted Snack',
        brands: 'BadCo',
        countries_tags: ['en:france'],
        nutriments: {
          'energy-kcal_100g': 600,
          proteins_100g: 2,
          carbohydrates_100g: 10,
          fat_100g: 1,
          fiber_100g: 0,
        },
      }),
    ];

    const offItems = parseOffJsonlLines(offLines, {
      tier: 'core',
      regionQuotas: { PH: 1, JP: 1, FR: 1 },
    });
    expect(offItems).toHaveLength(2);
    expect(offItems.map((i) => i.region)).toEqual(['PH', 'JP']);
    expect(offItems[0].barcode).toBe('4800016644801');

    const foodRepoJson = JSON.stringify({
      data: [
        {
          id: 9001,
          barcode: '7613035000011',
          display_name_translations: { en: 'Swiss Dark Chocolate 70%' },
          country: 'CH',
          portion_quantity: 25,
          portion_unit: 'g',
          nutrients: {
            energy_calories_kcal: { per_hundred: 560 },
            protein: { per_hundred: 8.5 },
            carbohydrates: { per_hundred: 34 },
            fat: { per_hundred: 42 },
            fiber: { per_hundred: 10 },
          },
        },
      ],
    });

    const repoItems = parseFoodRepoJson(foodRepoJson);
    expect(repoItems).toHaveLength(1);
    expect(repoItems[0].name).toBe('Swiss Dark Chocolate 70%');
    expect(repoItems[0].region).toBe('CH');
    expect(repoItems[0].barcode).toBe('7613035000011');
  });

  it('loads curated JSON packs and optional CSV preserving legacy IDs', () => {
    const jsonContent = JSON.stringify([
      {
        id: 'staple:ph-jollibee-chickenjoy',
        source: 'staple',
        accuracyTier: 3,
        name: 'Chickenjoy 1-pc',
        brand: 'Jollibee',
        region: 'PH',
        basis: 'perServing',
        servingSize: 1,
        servingUnit: 'pc',
        servingWeightGrams: 130,
        nutrientsPerBasis: { calories: 320, protein: 24, carbs: 14, fat: 18, fiber: 0.5 },
        micronutrientsPerBasis: { sodiumMg: 680 },
        updatedAt: 1700000000000,
      },
    ]);

    const csvContent = [
      'name,brand,region,calories,protein,carbs,fat,fiber,basis,servingSize,servingUnit,servingWeightGrams',
      'Koshihikari Steamed Rice,,JP,156,2.5,37.1,0.3,0.3,per100g,100,g,100',
    ].join('\n');

    const curated = loadCuratedFromFiles(
      [{ filename: 'ph-foods.json', content: jsonContent }],
      csvContent
    );
    expect(curated).toHaveLength(2);
    expect(curated[0].id).toBe('staple:ph-jollibee-chickenjoy');
    expect(curated[1].name).toBe('Koshihikari Steamed Rice');
  });
});

describe('Compiler Pipeline — compileCatalogToSqlite End-to-End', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // On Windows, libsql native file handles may release asynchronously after close()
      }
    }
    tempDirs.length = 0;
  });

  it('compiles deduplicated records to SQLite FTS5, writes .db.gz & manifest with matching SHA-256, and supports FTS5 prefix queries & alias lookups', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macroai-catalog-test-'));
    tempDirs.push(tmpDir);

    const dbPath = path.join(tmpDir, 'food-catalog.db');
    const gzPath = path.join(tmpDir, 'food-catalog.db.gz');
    const manifestPath = path.join(tmpDir, 'catalog-manifest.json');

    const eggRecord = parseUsdaFoodRecord(
      {
        fdcId: 171287,
        description: 'Egg, whole, raw, fresh',
        dataType: 'SR Legacy',
        foodCategory: { description: 'Dairy and Egg Products' },
        foodNutrients: [
          { nutrient: { id: 1008, number: '208', unitName: 'kcal' }, amount: 143 },
          { nutrient: { id: 1003, number: '203', unitName: 'g' }, amount: 12.6 },
          { nutrient: { id: 1005, number: '205', unitName: 'g' }, amount: 0.7 },
          { nutrient: { id: 1004, number: '204', unitName: 'g' }, amount: 9.5 },
        ],
        foodPortions: [{ amount: 1, modifier: 'large', gramWeight: 50 }],
      },
      'sr_legacy'
    )!;

    const riceRecord: CatalogFoodInput = {
      id: 'mext:01088',
      source: 'catalog',
      sourceProvider: 'mext',
      accuracyTier: 1,
      region: 'JP',
      category: 'Cereals',
      name: 'Japanese White Rice (Cooked)',
      aliases: ['japanese rice', 'sushi rice', 'gohan', 'steamed rice'],
      basis: 'per100g',
      servingSize: 100,
      servingUnit: 'g',
      servingOptions: [
        { id: 'cup', label: 'cup (158g)', unit: 'cup', grams: 158, defaultAmount: 1 },
        { id: 'bowl', label: 'bowl (200g)', unit: 'bowl', grams: 200, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
      nutrientsPerBasis: { calories: 156, protein: 2.5, carbs: 37.1, fat: 0.3, fiber: 0.3 },
      micronutrientsPerBasis: { sodiumMg: 1 },
      updatedAt: 1700000000000,
      legacyIds: ['staple:jp-white-rice'],
    };

    const manifest = await compileCatalogToSqlite([eggRecord, riceRecord], dbPath, {
      tier: 'core',
      version: '2026.11.test',
      gzipOutPath: gzPath,
      manifestOutPath: manifestPath,
    });

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(gzPath)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);

    // Verify SHA-256 matches uncompressed .db bytes
    const rawBytes = fs.readFileSync(dbPath);
    const expectedSha = crypto.createHash('sha256').update(rawBytes).digest('hex');
    expect(manifest.sha256).toBe(expectedSha);
    expect(manifest.rawBytes).toBe(rawBytes.byteLength);
    expect(manifest.foodCount).toBe(2);
    expect(manifest.license).toBe('ODbL-1.0');

    // Verify .db.gz decompresses back to exact rawBytes
    const gunzipped = zlib.gunzipSync(fs.readFileSync(gzPath));
    expect(gunzipped.equals(rawBytes)).toBe(true);

    // Verify manifest file matches returned object
    const manifestOnDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifestOnDisk).toEqual(manifest);

    // Open compiled SQLite DB with @libsql/client and verify FTS5 queries + alias lookup
    const dbUrl = `file:${dbPath.replace(/\\/g, '/')}`;
    const client = createClient({ url: dbUrl });
    try {
      const eggRes = await client.execute({
        sql: `SELECT f.* FROM foods f JOIN foods_fts fts ON fts.rowid = f.rowid WHERE foods_fts MATCH ? ORDER BY bm25(foods_fts)`,
        args: ['egg*'],
      });
      expect(eggRes.rows).toHaveLength(1);
      const eggItem = catalogRowToFoodItem(eggRes.rows[0] as unknown as CatalogFoodRow);
      expect(eggItem.name).toBe('Whole Egg (Raw)');
      expect(eggItem.servingOptions?.some((o) => o.unit === 'large' && o.grams === 50)).toBe(true);

      const riceRes = await client.execute({
        sql: `SELECT f.* FROM foods f JOIN foods_fts fts ON fts.rowid = f.rowid WHERE foods_fts MATCH ? ORDER BY bm25(foods_fts)`,
        args: ['japanese* white* rice*'],
      });
      expect(riceRes.rows).toHaveLength(1);
      const riceItem = catalogRowToFoodItem(riceRes.rows[0] as unknown as CatalogFoodRow);
      expect(riceItem.name).toBe('Japanese White Rice (Cooked)');
      expect(riceItem.servingOptions?.some((o) => o.unit === 'bowl')).toBe(true);

      // Verify food_id_aliases lookup
      const aliasRes = await client.execute({
        sql: `SELECT canonical_id FROM food_id_aliases WHERE legacy_id = ?`,
        args: ['staple:171287'],
      });
      expect(aliasRes.rows).toHaveLength(1);
      expect(aliasRes.rows[0].canonical_id).toBe(eggRecord.id);

      const riceAliasRes = await client.execute({
        sql: `SELECT canonical_id FROM food_id_aliases WHERE legacy_id = ?`,
        args: ['staple:jp-white-rice'],
      });
      expect(riceAliasRes.rows).toHaveLength(1);
      expect(riceAliasRes.rows[0].canonical_id).toBe('mext:01088');
    } finally {
      client.close();
    }
  });
});
