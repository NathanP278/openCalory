// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createClient } from '@libsql/client';
import {
  CATALOG_SCHEMA_SQL,
  catalogRowToFoodItem,
  foodItemToCatalogRow,
  type CatalogFoodInput,
  type CatalogFoodRow,
} from '../catalog-schema';
import { FoodItemSchema, FoodSourceSchema } from '@/lib/db/backup';

describe('catalog-schema', () => {
  it('executes CATALOG_SCHEMA_SQL on in-memory @libsql/client and supports FTS5 prefix search', async () => {
    const client = createClient({ url: ':memory:' });
    try {
      await client.executeMultiple(CATALOG_SCHEMA_SQL);

      const input: CatalogFoodInput = {
        id: 'catalog:usda:169756',
        barcode: null,
        source: 'usda',
        sourceProvider: 'usda',
        accuracyTier: 1,
        region: 'GLOBAL',
        category: 'Grains',
        name: 'Rice, white, long-grain, regular, cooked',
        brand: '',
        aliases: ['white rice', 'steamed rice', 'kanin'],
        basis: 'per100g',
        servingSize: 158,
        servingUnit: 'cup',
        servingWeightGrams: 158,
        servingOptions: [
          { id: 'cup', label: 'cup (158g)', unit: 'cup', grams: 158, defaultAmount: 1 },
          { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
        ],
        nutrientsPerBasis: {
          calories: 130,
          protein: 2.7,
          carbs: 28.2,
          fat: 0.3,
          fiber: 0.4,
        },
        micronutrientsPerBasis: {
          sodiumMg: 1,
          ironMg: 1.2,
        },
        searchRank: 95,
        updatedAt: 1700000000000,
      };

      const row = foodItemToCatalogRow(input);

      const insertRes = await client.execute({
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

      const insertedRowId = Number(insertRes.lastInsertRowid);
      await client.execute({
        sql: `INSERT INTO foods_fts (rowid, name, brand, aliases, category)
              VALUES (?, ?, ?, ?, ?)`,
        args: [insertedRowId, row.name, row.brand, row.aliases, row.category],
      });

      const result = await client.execute(
        `SELECT f.* FROM foods_fts JOIN foods f ON f.rowid = foods_fts.rowid WHERE foods_fts MATCH 'rice*'`
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe('catalog:usda:169756');
      expect(result.rows[0].name).toBe('Rice, white, long-grain, regular, cooked');
      expect(result.rows[0].accuracy_tier).toBe(1);

      // Verify catalog_meta and food_id_aliases tables exist and accept rows
      await client.execute({
        sql: `INSERT INTO catalog_meta (key, value) VALUES (?, ?)`,
        args: ['version', '1.0.0'],
      });
      await client.execute({
        sql: `INSERT INTO food_id_aliases (legacy_id, canonical_id) VALUES (?, ?)`,
        args: ['staple:white-rice', 'catalog:usda:169756'],
      });

      const aliasRes = await client.execute({
        sql: `SELECT canonical_id FROM food_id_aliases WHERE legacy_id = ?`,
        args: ['staple:white-rice'],
      });
      expect(aliasRes.rows[0].canonical_id).toBe('catalog:usda:169756');
    } finally {
      client.close();
    }
  });

  it('round-trips FoodItem fields accurately through foodItemToCatalogRow and catalogRowToFoodItem', () => {
    const input: CatalogFoodInput = {
      id: 'catalog:off:4800016644801',
      barcode: '4800016644801',
      source: 'catalog',
      sourceProvider: 'ciqual',
      accuracyTier: 2,
      region: 'JP',
      category: 'Noodles',
      name: 'Instant Ramen Chicken',
      brand: 'Nissin',
      aliases: ['cup noodles', 'ramen'],
      basis: 'perServing',
      servingSize: 1,
      servingUnit: 'pack',
      servingWeightGrams: 85,
      servingOptions: [
        { id: 'pack', label: 'pack (85g)', unit: 'pack', grams: 85, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
      nutrientsPerBasis: {
        calories: 380,
        protein: 9,
        carbs: 54,
        fat: 14,
        fiber: 2,
      },
      micronutrientsPerBasis: {
        sodiumMg: 1420,
        ironMg: 2.1,
        calciumMg: 30,
      },
      searchRank: 42.5,
      updatedAt: 1700000000000,
    };

    const dbRow: CatalogFoodRow = {
      rowid: 7,
      ...foodItemToCatalogRow(input),
    };

    expect(dbRow.source).toBe('ciqual');
    expect(dbRow.accuracy_tier).toBe(2);
    expect(dbRow.search_rank).toBe(42.5);
    expect(dbRow.barcode).toBe('4800016644801');

    const roundTripped = catalogRowToFoodItem(dbRow);

    expect(roundTripped.id).toBe(input.id);
    expect(roundTripped.barcode).toBe('4800016644801');
    expect(roundTripped.source).toBe('catalog');
    expect(roundTripped.accuracyTier).toBe(2);
    expect(roundTripped.region).toBe('JP');
    expect(roundTripped.category).toBe('Noodles');
    expect(roundTripped.name).toBe('Instant Ramen Chicken');
    expect(roundTripped.brand).toBe('Nissin');
    expect(roundTripped.aliases).toEqual(['cup noodles', 'ramen']);
    expect(roundTripped.basis).toBe('perServing');
    expect(roundTripped.servingSize).toBe(1);
    expect(roundTripped.servingUnit).toBe('pack');
    expect(roundTripped.servingWeightGrams).toBe(85);
    expect(roundTripped.servingOptions).toEqual(input.servingOptions);
    expect(roundTripped.nutrientsPerBasis).toEqual(input.nutrientsPerBasis);
    expect(roundTripped.micronutrientsPerBasis).toEqual(input.micronutrientsPerBasis);
  });

  it('validates both legacy and catalog-enriched FoodItem objects with FoodItemSchema', () => {
    const legacyFood = {
      id: 'staple:ph-rice',
      source: 'staple',
      name: 'Steamed White Rice',
      region: 'PH',
      basis: 'per100g',
      servingSize: 158,
      servingUnit: 'cup',
      nutrientsPerBasis: { calories: 130, protein: 2.7, carbs: 28, fat: 0.3, fiber: 0.4 },
      micronutrientsPerBasis: { sodiumMg: 1 },
      updatedAt: 1700000000000,
    };

    const parsedLegacy = FoodItemSchema.parse(legacyFood);
    expect(parsedLegacy.source).toBe('staple');
    expect(parsedLegacy.region).toBe('PH');

    const enrichedFood = {
      id: 'catalog:mext:01088',
      source: 'catalog',
      accuracyTier: 1,
      region: 'JP',
      category: 'Grains',
      aliases: ['gohan'],
      name: 'Japanese Short-Grain Rice, Cooked',
      basis: 'per100g',
      servingSize: 150,
      servingUnit: 'bowl',
      nutrientsPerBasis: { calories: 156, protein: 2.5, carbs: 37.1, fat: 0.3, fiber: 0.3 },
      micronutrientsPerBasis: { potassiumMg: 29 },
      updatedAt: 1700000000000,
    };

    const parsedEnriched = FoodItemSchema.parse(enrichedFood);
    expect(parsedEnriched.source).toBe('catalog');
    expect(parsedEnriched.accuracyTier).toBe(1);
    expect(parsedEnriched.region).toBe('JP');
    expect(parsedEnriched.category).toBe('Grains');
    expect(parsedEnriched.aliases).toEqual(['gohan']);

    // Verify new commercial/catalog sources are also accepted by FoodSourceSchema and FoodItemSchema
    for (const src of ['catalog', 'fatsecret', 'edamam', 'nutritionix'] as const) {
      expect(FoodSourceSchema.parse(src)).toBe(src);
      expect(FoodItemSchema.parse({ ...enrichedFood, source: src }).source).toBe(src);
    }

    // Reject out-of-range accuracyTier
    expect(() => FoodItemSchema.parse({ ...enrichedFood, accuracyTier: 5 })).toThrow();
    expect(() => FoodItemSchema.parse({ ...enrichedFood, accuracyTier: 0 })).toThrow();
  });
});
