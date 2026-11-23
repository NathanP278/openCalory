import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FoodItemSchema } from '@/lib/db/backup';
import { parseFoodCsv, parseFoodJson } from '@/lib/foods/csv-food-parser';
import type { FoodItem } from '@/types/nutrition';

const CURATED_DIR = path.resolve(process.cwd(), 'data/curated');
const LEGACY_PH_FILE = path.resolve(process.cwd(), 'public/data/ph-foods.json');

describe('curated food packs in data/curated/', () => {
  it('contains at least the 4 required curated pack files and keeps legacy ph-foods.json intact', () => {
    expect(fs.existsSync(LEGACY_PH_FILE)).toBe(true);
    expect(fs.existsSync(CURATED_DIR)).toBe(true);

    const files = fs
      .readdirSync(CURATED_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toContain('ph-foods.json');
    expect(files).toContain('asian-dishes.json');
    expect(files).toContain('global-dishes.json');
    expect(files).toContain('restaurant-chains.json');
  });

  it('preserves all existing IDs from public/data/ph-foods.json in data/curated/ph-foods.json', () => {
    const legacy: FoodItem[] = JSON.parse(fs.readFileSync(LEGACY_PH_FILE, 'utf8'));
    const curatedPh: FoodItem[] = JSON.parse(
      fs.readFileSync(path.join(CURATED_DIR, 'ph-foods.json'), 'utf8')
    );
    const curatedIds = new Set(curatedPh.map((item) => item.id));
    for (const item of legacy) {
      expect(curatedIds.has(item.id)).toBe(true);
    }
  });

  it('validates every item across all curated packs for schema, unique IDs, servingOptions, region, accuracyTier, and Atwater sanity', () => {
    const files = fs
      .readdirSync(CURATED_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const seenIds = new Set<string>();
    const countsByFile: Record<string, number> = {};

    for (const file of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(CURATED_DIR, file), 'utf8'));
      expect(Array.isArray(raw)).toBe(true);
      countsByFile[file] = raw.length;

      for (const entry of raw) {
        const parsed = FoodItemSchema.parse(entry);

        expect(seenIds.has(parsed.id), `Duplicate id ${parsed.id} in ${file}`).toBe(false);
        seenIds.add(parsed.id);

        expect(
          parsed.servingOptions && parsed.servingOptions.length >= 1,
          `Missing servingOptions for ${parsed.id} in ${file}`
        ).toBe(true);

        expect(
          typeof parsed.region === 'string' && parsed.region.trim().length > 0,
          `Missing region for ${parsed.id} in ${file}`
        ).toBe(true);

        expect(parsed.accuracyTier, `Expected accuracyTier 3 for ${parsed.id} in ${file}`).toBe(3);

        const { calories, protein, carbs, fat, fiber } = parsed.nutrientsPerBasis;
        expect(calories).toBeGreaterThanOrEqual(0);
        expect(protein).toBeGreaterThanOrEqual(0);
        expect(carbs).toBeGreaterThanOrEqual(0);
        expect(fat).toBeGreaterThanOrEqual(0);
        expect(fiber).toBeGreaterThanOrEqual(0);

        if (calories > 20) {
          const atwater = 4 * protein + 4 * carbs + 9 * fat;
          const tolerance = Math.max(85, calories * 0.3);
          expect(
            Math.abs(calories - atwater),
            `Atwater mismatch for ${parsed.id} (${parsed.name}): cal=${calories}, est=${atwater}`
          ).toBeLessThanOrEqual(tolerance);
        }
      }
    }

    expect(countsByFile['asian-dishes.json']).toBeGreaterThanOrEqual(30);
    expect(countsByFile['global-dishes.json']).toBeGreaterThanOrEqual(20);
    expect(countsByFile['restaurant-chains.json']).toBeGreaterThanOrEqual(35);
    expect(countsByFile['ph-foods.json']).toBeGreaterThanOrEqual(220);
  });
});

describe('parseFoodCsv', () => {
  it('parses RFC-4180 CSV with quoted commas, escaped quotes, CRLF, case-insensitive headers, micronutrients, and serving enrichment', () => {
    const csv = [
      'NAME,Calories,Protein,Carbs,Fat,Fiber,Brand,Region,Category,Barcode,Basis,ServingSize,ServingUnit,ServingWeightGrams,Aliases,SodiumMg,SugarG,SaturatedFatG,CholesterolMg,PotassiumMg,CalciumMg,IronMg',
      '"Ramen, Tonkotsu ""Rich""",520,24,58,21,3,Ichiran,JP,Noodles,4901234567890,perServing,1,bowl,550,"tonkotsu; pork ramen | hakata ramen",1650,4,7,65,380,80,2.4',
      '"Olive Oil, Extra Virgin",884,0,0,100,0,,IT,Oils,,per100g,100,g,,evoo;extra virgin olive oil,2,0,14,0,1,1,0.6',
    ].join('\r\n');

    const { items, errors } = parseFoodCsv(csv, {
      defaultRegion: 'GLOBAL',
      defaultSource: 'catalog',
    });

    expect(errors).toEqual([]);
    expect(items).toHaveLength(2);

    const ramen = items[0];
    expect(FoodItemSchema.parse(ramen)).toBeTruthy();
    expect(ramen.name).toBe('Ramen, Tonkotsu "Rich"');
    expect(ramen.brand).toBe('Ichiran');
    expect(ramen.region).toBe('JP');
    expect(ramen.category).toBe('Noodles');
    expect(ramen.barcode).toBe('4901234567890');
    expect(ramen.basis).toBe('perServing');
    expect(ramen.servingSize).toBe(1);
    expect(ramen.servingUnit).toBe('bowl');
    expect(ramen.servingWeightGrams).toBe(550);
    expect(ramen.source).toBe('catalog');
    expect(ramen.aliases).toEqual(['tonkotsu', 'pork ramen', 'hakata ramen']);
    expect(ramen.nutrientsPerBasis).toEqual({
      calories: 520,
      protein: 24,
      carbs: 58,
      fat: 21,
      fiber: 3,
    });
    expect(ramen.micronutrientsPerBasis).toEqual({
      sodiumMg: 1650,
      sugarG: 4,
      saturatedFatG: 7,
      cholesterolMg: 65,
      potassiumMg: 380,
      calciumMg: 80,
      ironMg: 2.4,
    });
    expect(ramen.servingOptions?.some((o) => o.unit === 'bowl' && o.grams === 550)).toBe(true);
    expect(ramen.servingOptions?.some((o) => o.unit === 'g')).toBe(true);

    const oil = items[1];
    expect(oil.name).toBe('Olive Oil, Extra Virgin');
    expect(oil.brand).toBeUndefined();
    expect(oil.servingOptions?.some((o) => o.unit === 'tbsp')).toBe(true);
  });

  it('rejects malformed rows with descriptive Row <N> errors without aborting valid rows', () => {
    const csv = [
      'name,calories,protein,carbs,fat',
      'Valid Chicken Breast,165,31,0,3.6',
      ',200,10,20,5',
      'Bad Calories,abc,10,20,5',
      'Negative Protein,200,-5,20,5',
      'Valid White Rice,130,2.7,28,0.3',
    ].join('\n');

    const { items, errors } = parseFoodCsv(csv, { defaultRegion: 'US' });

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.name)).toEqual(['Valid Chicken Breast', 'Valid White Rice']);
    expect(items[0].region).toBe('US');
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/^Row 3:/);
    expect(errors[1]).toMatch(/^Row 4:/);
    expect(errors[2]).toMatch(/^Row 5:/);
  });
});

describe('parseFoodJson', () => {
  it('accepts a JSON array, { items: [...] }, and { foods: [...] }, enriching defaults and servingOptions', () => {
    const arrayPayload = JSON.stringify([
      {
        name: 'Boiled Egg',
        nutrientsPerBasis: { calories: 155, protein: 13, carbs: 1.1, fat: 11, fiber: 0 },
      },
    ]);

    const resArray = parseFoodJson(arrayPayload, {
      defaultRegion: 'GLOBAL',
      defaultSource: 'custom_food',
    });
    expect(resArray.errors).toEqual([]);
    expect(resArray.items).toHaveLength(1);
    expect(FoodItemSchema.parse(resArray.items[0])).toBeTruthy();
    expect(resArray.items[0].source).toBe('custom_food');
    expect(resArray.items[0].region).toBe('GLOBAL');
    expect(resArray.items[0].servingOptions?.some((o) => o.unit === 'large')).toBe(true);

    const itemsPayload = JSON.stringify({
      items: [
        {
          id: 'custom:matcha-latte',
          name: 'Matcha Latte',
          basis: 'per100ml',
          servingSize: 100,
          servingUnit: 'ml',
          nutrientsPerBasis: { calories: 62, protein: 2.5, carbs: 8.5, fat: 2.0, fiber: 0.4 },
        },
      ],
    });
    const resItems = parseFoodJson(itemsPayload);
    expect(resItems.errors).toEqual([]);
    expect(resItems.items).toHaveLength(1);
    expect(resItems.items[0].id).toBe('custom:matcha-latte');
    expect(resItems.items[0].servingOptions?.some((o) => o.unit === 'ml')).toBe(true);

    const foodsPayload = JSON.stringify({
      foods: [
        {
          name: 'Plain Greek Yogurt',
          calories: 59,
          protein: 10,
          carbs: 3.6,
          fat: 0.4,
        },
      ],
    });
    const resFoods = parseFoodJson(foodsPayload);
    expect(resFoods.errors).toEqual([]);
    expect(resFoods.items).toHaveLength(1);
    expect(resFoods.items[0].nutrientsPerBasis.protein).toBe(10);
  });

  it('reports errors for invalid JSON and malformed entries while preserving valid entries', () => {
    const badJson = parseFoodJson('{ not valid json');
    expect(badJson.items).toEqual([]);
    expect(badJson.errors.length).toBe(1);

    const mixedPayload = JSON.stringify({
      items: [
        {
          name: 'Good Banana',
          nutrientsPerBasis: { calories: 89, protein: 1.1, carbs: 22.8, fat: 0.3, fiber: 2.6 },
        },
        {
          name: '',
          nutrientsPerBasis: { calories: 100, protein: 5, carbs: 10, fat: 2, fiber: 0 },
        },
        {
          name: 'Negative Fat Food',
          nutrientsPerBasis: { calories: 100, protein: 5, carbs: 10, fat: -2, fiber: 0 },
        },
      ],
    });

    const mixed = parseFoodJson(mixedPayload);
    expect(mixed.items).toHaveLength(1);
    expect(mixed.items[0].name).toBe('Good Banana');
    expect(mixed.errors).toHaveLength(2);
  });
});
