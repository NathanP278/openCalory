import 'fake-indexeddb/auto';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mapUsdaFoodToFoodItem, fetchAndCacheUsdaFood } from '../usda-adapter';
import { filterStaples, searchStaples, loadStaples, setStaplesCache, enrichMealItemsWithStaples, estimateMissingStapleMicros } from '../staples-search';
import { scaleNutrition } from '@/lib/nutrition/scaling';
import { GET as usdaRouteHandler } from '@/app/api/usda/[...path]/route';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db/opencalory-db';
import type { FoodItem, Micronutrients } from '@/types/nutrition';

describe('USDA adapter and Staples search', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('normalizes USDA Foundation nutrients (energy kcal, macros, micros) to per100g', () => {
    const item = mapUsdaFoodToFoodItem({
      fdcId: 171705,
      description: 'Avocados, raw, all commercial varieties',
      dataType: 'SR Legacy',
      foodNutrients: [
        { nutrient: { id: 1008, name: 'Energy', unitName: 'kcal' }, amount: 160 },
        { nutrient: { id: 1003, name: 'Protein', unitName: 'g' }, amount: 2 },
        { nutrient: { id: 1005, name: 'Carbohydrate, by difference', unitName: 'g' }, amount: 8.53 },
        { nutrient: { id: 1004, name: 'Total lipid (fat)', unitName: 'g' }, amount: 14.66 },
        { nutrient: { id: 1079, name: 'Fiber, total dietary', unitName: 'g' }, amount: 6.7 },
        { nutrient: { id: 1092, name: 'Potassium, K', unitName: 'mg' }, amount: 485 },
      ],
    });
    expect(item.id).toBe('usda:171705');
    expect(item.basis).toBe('per100g');
    expect(item.nutrientsPerBasis.calories).toBe(160);
    expect(item.nutrientsPerBasis.protein).toBe(2);
    expect(item.nutrientsPerBasis.carbs).toBe(8.53);
    expect(item.nutrientsPerBasis.fat).toBe(14.66);
    expect(item.nutrientsPerBasis.fiber).toBe(6.7);
    expect(item.micronutrientsPerBasis.potassiumMg).toBe(485);
  });

  test('normalizes USDA /foods/search flat nutrient format and ignores kJ (1062)', () => {
    const item = mapUsdaFoodToFoodItem({
      fdcId: 234567,
      description: 'Egg, whole, raw, fresh',
      dataType: 'Foundation',
      foodNutrients: [
        { nutrientId: 1062, nutrientName: 'Energy', unitName: 'kJ', value: 600 },
        { nutrientId: 1008, nutrientName: 'Energy', unitName: 'kcal', value: 143 },
        { nutrientId: 1003, nutrientName: 'Protein', unitName: 'g', value: 12.56 },
        { nutrientId: 1004, nutrientName: 'Total lipid (fat)', unitName: 'g', value: 9.51 },
        { nutrientId: 1005, nutrientName: 'Carbohydrate, by difference', unitName: 'g', value: 0.72 },
        { nutrientId: 1079, nutrientName: 'Fiber, total dietary', unitName: 'g', value: 0 },
        { nutrientId: 1093, nutrientName: 'Sodium, Na', unitName: 'mg', value: 142 },
        { nutrientId: 1087, nutrientName: 'Calcium, Ca', unitName: 'mg', value: 56 },
        { nutrientId: 1089, nutrientName: 'Iron, Fe', unitName: 'mg', value: 1.75 },
        { nutrientId: 1090, nutrientName: 'Magnesium, Mg', unitName: 'mg', value: 12 },
        { nutrientId: 1095, nutrientName: 'Zinc, Zn', unitName: 'mg', value: 1.29 },
        { nutrientId: 1106, nutrientName: 'Vitamin A, RAE', unitName: 'Âµg', value: 160 },
        { nutrientId: 1162, nutrientName: 'Vitamin C, total ascorbic acid', unitName: 'mg', value: 0 },
        { nutrientId: 1114, nutrientName: 'Vitamin D (D2 + D3)', unitName: 'Âµg', value: 2 },
        { nutrientId: 1175, nutrientName: 'Vitamin B-6', unitName: 'mg', value: 0.17 },
        { nutrientId: 1178, nutrientName: 'Vitamin B-12', unitName: 'Âµg', value: 0.89 },
        { nutrientId: 1177, nutrientName: 'Folate, total', unitName: 'Âµg', value: 47 },
      ],
    });

    expect(item.id).toBe('usda:234567');
    expect(item.name).toBe('Egg, whole, raw, fresh');
    expect(item.basis).toBe('per100g');
    expect(item.servingSize).toBe(100);
    expect(item.servingUnit).toBe('g');
    expect(item.nutrientsPerBasis.calories).toBe(143);
    expect(item.nutrientsPerBasis.protein).toBe(12.56);
    expect(item.nutrientsPerBasis.fat).toBe(9.51);
    expect(item.nutrientsPerBasis.carbs).toBe(0.72);
    expect(item.nutrientsPerBasis.fiber).toBe(0);
    expect(item.micronutrientsPerBasis.sodiumMg).toBe(142);
    expect(item.micronutrientsPerBasis.calciumMg).toBe(56);
    expect(item.micronutrientsPerBasis.ironMg).toBe(1.75);
    expect(item.micronutrientsPerBasis.magnesiumMg).toBe(12);
    expect(item.micronutrientsPerBasis.zincMg).toBe(1.29);
    expect(item.micronutrientsPerBasis.vitaminAMcg).toBe(160);
    expect(item.micronutrientsPerBasis.vitaminCMg).toBe(0);
    expect(item.micronutrientsPerBasis.vitaminDMcg).toBe(2);
    expect(item.micronutrientsPerBasis.vitaminB6Mg).toBe(0.17);
    expect(item.micronutrientsPerBasis.vitaminB12Mcg).toBe(0.89);
    expect(item.micronutrientsPerBasis.folateMcg).toBe(47);
  });

  test('supports sourceOverride: staple', () => {
    const item = mapUsdaFoodToFoodItem(
      {
        fdcId: 99999,
        description: 'Rolled Oats',
        foodNutrients: [
          { nutrient: { id: 1008, name: 'Energy', unitName: 'kcal' }, amount: 389 },
          { nutrient: { id: 1003, name: 'Protein', unitName: 'g' }, amount: 16.89 },
          { nutrient: { id: 1004, name: 'Total lipid (fat)', unitName: 'g' }, amount: 6.9 },
          { nutrient: { id: 1005, name: 'Carbohydrate', unitName: 'g' }, amount: 66.27 },
        ],
      },
      'staple'
    );
    expect(item.id).toBe('staple:99999');
    expect(item.source).toBe('staple');
  });

  test('ranks exact/prefix token matches first across staples', () => {
    const sample = [
      { id: 'staple:1', name: 'Chicken breast, raw' },
      { id: 'staple:2', name: 'Soup, chicken broth' },
      { id: 'staple:3', name: 'Chicken breast, cooked, roasted' },
    ] as FoodItem[];

    const results = filterStaples(sample, 'chicken breast', 10);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe('staple:1');
    expect(results[1].id).toBe('staple:3');
  });

  test('handles empty or whitespace queries cleanly', () => {
    const sample = [
      { id: 'staple:1', name: 'Chicken breast, raw' },
      { id: 'staple:2', name: 'Apple, raw' },
    ] as FoodItem[];

    expect(filterStaples(sample, '', 10)).toHaveLength(2);
    expect(filterStaples(sample, '   ', 10)).toHaveLength(2);
  });

  test('loadStaples and searchStaples loads ~2500 staples from public/data/staples-2500.json', async () => {
    setStaplesCache(null);
    const loaded = await loadStaples();
    expect(loaded.length).toBeGreaterThanOrEqual(2500);
    expect(loaded[0].basis).toBe('per100g');
    expect(loaded[0].source).toBe('staple');

    const searchHits = await searchStaples('chicken', 5);
    expect(searchHits.length).toBeGreaterThan(0);
    expect(searchHits[0].name.toLowerCase()).toContain('chicken');
  });

  test('fetchAndCacheUsdaFood returns cached item without fetching if already in Dexie foodsCache', async () => {
    const mockItem: FoodItem = {
      id: 'usda:12345',
      source: 'usda',
      name: 'Cached Salmon',
      basis: 'per100g',
      servingSize: 100,
      servingUnit: 'g',
      nutrientsPerBasis: { calories: 200, protein: 20, carbs: 0, fat: 12, fiber: 0 },
      micronutrientsPerBasis: {},
      updatedAt: 123456,
    };
    await db.foodsCache.put(mockItem);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await fetchAndCacheUsdaFood(12345);
    expect(result.name).toBe('Cached Salmon');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('USDA route handler allows only foods/search and food/<numericId>, rejecting traversal', async () => {
    const req1 = new NextRequest('http://localhost:3000/api/usda/invalid/path');
    const res1 = await usdaRouteHandler(req1, { params: Promise.resolve({ path: ['invalid', 'path'] }) });
    expect(res1.status).toBe(400);

    const req2 = new NextRequest('http://localhost:3000/api/usda/foods/download');
    const res2 = await usdaRouteHandler(req2, { params: Promise.resolve({ path: ['foods', 'download'] }) });
    expect(res2.status).toBe(400);

    const req3 = new NextRequest('http://localhost:3000/api/usda/food/abc');
    const res3 = await usdaRouteHandler(req3, { params: Promise.resolve({ path: ['food', 'abc'] }) });
    expect(res3.status).toBe(400);
  });

  test('USDA route handler forwards foods/search with enforced dataType and Cache-Control', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      expect(urlStr).toContain('https://api.nal.usda.gov/fdc/v1/foods/search');
      expect(urlStr).toContain('dataType=Foundation%2CSR+Legacy');
      expect(urlStr).toContain('api_key=');
      return new Response(JSON.stringify({ totalHits: 1, foods: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const req = new NextRequest('http://localhost:3000/api/usda/foods/search?query=spinach');
    const res = await usdaRouteHandler(req, { params: Promise.resolve({ path: ['foods', 'search'] }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(fetchSpy).toHaveBeenCalled();
  });

  test('USDA route handler preserves allowed dataType param including Survey (FNDDS) and Branded', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get('dataType')).toBe('Foundation,SR Legacy,Survey (FNDDS),Branded');
      return new Response(JSON.stringify({ totalHits: 0, foods: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const req = new NextRequest(
      'http://localhost:3000/api/usda/foods/search?query=burger&dataType=Foundation,SR%20Legacy,Survey%20(FNDDS),Branded'
    );
    const res = await usdaRouteHandler(req, { params: Promise.resolve({ path: ['foods', 'search'] }) });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
  });

  test('loadStaples merges PH foods and filterStaples ranks brand + PH matches', async () => {
    setStaplesCache(null);
    const loaded = await loadStaples();

    expect(loaded.some((f) => f.name === 'Egg McMuffin' && f.brand === "McDonald's")).toBe(true);
    expect(loaded.some((f) => f.name.includes('Chickenjoy') && f.brand === 'Jollibee')).toBe(true);
    expect(loaded.some((f) => f.name.toLowerCase().includes('pandesal'))).toBe(true);
    expect(loaded.some((f) => f.brand?.includes('Lucky Me'))).toBe(true);

    const mcdoHits = filterStaples(loaded, 'McDonalds Egg McMuffin', 5);
    expect(mcdoHits.length).toBeGreaterThan(0);
    expect(mcdoHits[0].name).toBe('Egg McMuffin');

    const jollibeeHits = filterStaples(loaded, 'Jollibee Chickenjoy', 5);
    expect(jollibeeHits.length).toBeGreaterThan(0);
    expect(jollibeeHits[0].brand).toBe('Jollibee');
  });

  test('mapUsdaFoodToFoodItem extracts servingOptions only when portion metadata is present', () => {
    const brandedItem = mapUsdaFoodToFoodItem({
      fdcId: 9001,
      description: 'Egg McMuffin',
      dataType: 'Branded',
      brandOwner: "McDonald's",
      servingSize: 136,
      servingSizeUnit: 'g',
      householdServingFullText: '1 SANDWICH',
      foodNutrients: [
        { nutrient: { id: 1008, unitName: 'kcal' }, amount: 228 },
        { nutrient: { id: 1003, unitName: 'g' }, amount: 12.5 },
      ],
    });
    expect(brandedItem.servingWeightGrams).toBe(136);
    expect(brandedItem.servingOptions?.map((o) => o.unit)).toEqual(['pc', 'g']);

    const surveyItem = mapUsdaFoodToFoodItem({
      fdcId: 9002,
      description: 'White rice, cooked',
      dataType: 'Survey (FNDDS)',
      foodPortions: [
        { portionDescription: '1 cup', gramWeight: 158 },
      ],
      foodNutrients: [{ nutrient: { id: 1008, unitName: 'kcal' }, amount: 130 }],
    });
    expect(surveyItem.servingOptions?.[0]).toMatchObject({ unit: 'cup', grams: 158 });

    const plainItem = mapUsdaFoodToFoodItem({
      fdcId: 9003,
      description: 'Chicken breast, raw',
      dataType: 'Foundation',
      foodNutrients: [{ nutrient: { id: 1008, unitName: 'kcal' }, amount: 120 }],
    });
    expect(plainItem.servingOptions).toBeUndefined();
  });

  test('filterStaples suggests close matches for typos and missing spaces', async () => {
    setStaplesCache(null);
    const loaded = await loadStaples();

    const chikenHits = filterStaples(loaded, 'chiken', 10);
    expect(chikenHits.some((f) => f.name.toLowerCase().includes('chicken'))).toBe(true);

    const transposedHits = filterStaples(loaded, 'chciekn brest', 10);
    expect(transposedHits.some((f) => f.name.toLowerCase().includes('chicken breast'))).toBe(true);

    const typoMcMuffin = filterStaples(loaded, 'eg mcmufin', 5);
    expect(typoMcMuffin[0]?.name).toBe('Egg McMuffin');

    const compactMcMuffin = filterStaples(loaded, 'eggmcmuffin', 5);
    expect(compactMcMuffin[0]?.name).toBe('Egg McMuffin');

    const typoJollibee = filterStaples(loaded, 'jolibee chikenjoy', 5);
    expect(typoJollibee.some((f) => f.brand === 'Jollibee' && f.name.toLowerCase().includes('chickenjoy'))).toBe(true);

    const typoPandesal = filterStaples(loaded, 'pandesl', 5);
    expect(typoPandesal.some((f) => f.name.toLowerCase().includes('pandesal'))).toBe(true);

    const typoAvocado = filterStaples(loaded, 'avacado', 5);
    expect(typoAvocado.some((f) => f.name.toLowerCase().includes('avocado'))).toBe(true);
  });

  test('filterStaples matches prep-modifier queries and enrichMealItemsWithStaples backfills missing micros', async () => {
    const sample: FoodItem[] = [
      {
        id: 'staple:broccoli',
        source: 'usda',
        name: 'Broccoli, raw',
        basis: 'per100g',
        servingSize: 100,
        servingUnit: 'g',
        nutrientsPerBasis: { calories: 34, protein: 2.8, carbs: 6.6, fat: 0.4, fiber: 2.6 },
        micronutrientsPerBasis: {
          sodiumMg: 33,
          potassiumMg: 316,
          calciumMg: 47,
          ironMg: 0.73,
          magnesiumMg: 21,
          zincMg: 0.41,
          vitaminAMcg: 31,
          vitaminCMg: 89.2,
          vitaminDMcg: 0,
          vitaminB6Mg: 0.175,
          vitaminB12Mcg: 0,
          folateMcg: 63,
        },
        updatedAt: 1700000000000,
      },
      {
        id: 'staple:salmon',
        source: 'usda',
        name: 'Salmon, Atlantic, cooked',
        basis: 'per100g',
        servingSize: 100,
        servingUnit: 'g',
        nutrientsPerBasis: { calories: 206, protein: 22.1, carbs: 0, fat: 12.4, fiber: 0 },
        micronutrientsPerBasis: {
          sodiumMg: 59,
          potassiumMg: 384,
          calciumMg: 15,
          ironMg: 0.34,
          magnesiumMg: 27,
          zincMg: 0.43,
          vitaminAMcg: 12,
          vitaminCMg: 0,
          vitaminDMcg: 11,
          vitaminB6Mg: 0.65,
          vitaminB12Mcg: 2.8,
          folateMcg: 26,
        },
        updatedAt: 1700000000000,
      },
    ];

    const broccoliHits = filterStaples(sample, 'Steamed Broccoli', 5, { allowFuzzy: false });
    expect(broccoliHits[0]?.id).toBe('staple:broccoli');

    const salmonHits = filterStaples(sample, 'Grilled Salmon', 5, { allowFuzzy: false });
    expect(salmonHits[0]?.id).toBe('staple:salmon');

    setStaplesCache(sample);
    try {
      const itemsToEnrich: Array<{ name: string; microsPer100g?: Micronutrients }> = [
        {
          name: 'Steamed Broccoli',
          microsPer100g: {
            sodiumMg: 99, // Existing AI-provided value should be preserved
          },
        },
      ];
      const enriched = await enrichMealItemsWithStaples(itemsToEnrich);

      expect(enriched[0].microsPer100g?.sodiumMg).toBe(99);
      expect(enriched[0].microsPer100g?.vitaminCMg).toBe(89.2);
      expect(enriched[0].microsPer100g?.potassiumMg).toBe(316);
      expect(enriched[0].microsPer100g?.folateMcg).toBe(63);
    } finally {
      setStaplesCache(null);
    }
  });

  test('maps USDA sugar, added sugar, saturated fat, cholesterol, caffeine, and alcohol IDs and nutrient numbers', () => {
    const item = mapUsdaFoodToFoodItem({
      fdcId: 999,
      description: 'Iced Coffee Mocha',
      foodNutrients: [
        { nutrientId: 2000, value: 14 },
        { nutrientId: 1235, value: 10 },
        { nutrientId: 1258, value: 2.5 },
        { nutrientId: 1253, value: 15 },
        { nutrientId: 1057, value: 95 },
        { nutrientId: 1018, value: 0 },
      ],
    });
    expect(item.micronutrientsPerBasis).toMatchObject({
      sugarG: 14,
      addedSugarG: 10,
      saturatedFatG: 2.5,
      cholesterolMg: 15,
      caffeineMg: 95,
      alcoholG: 0,
    });

    const byNumber = mapUsdaFoodToFoodItem({
      fdcId: 1000,
      description: 'Espresso Tiramisu',
      foodNutrients: [
        { nutrientNumber: '269.3', value: 18.4 },
        { nutrientNumber: '539', value: 12.1 },
        { nutrientNumber: '606', value: 6.2 },
        { nutrientNumber: '601', value: 85 },
        { nutrientNumber: '262', value: 64 },
        { nutrientNumber: '221', value: 3.5 },
      ],
    });
    expect(byNumber.micronutrientsPerBasis).toMatchObject({
      sugarG: 18.4,
      addedSugarG: 12.1,
      saturatedFatG: 6.2,
      cholesterolMg: 85,
      caffeineMg: 64,
      alcoholG: 3.5,
    });
  });

  test('backfills extended nutrients on loaded staples and enriches meal items with extended nutrients', async () => {
    setStaplesCache(null);
    const loaded = await loadStaples();
    const eggMcMuffin = loaded.find((f) => f.name === 'Egg McMuffin');
    expect(eggMcMuffin).toBeDefined();
    expect(typeof eggMcMuffin?.micronutrientsPerBasis.saturatedFatG).toBe('number');
    expect(typeof eggMcMuffin?.micronutrientsPerBasis.cholesterolMg).toBe('number');
    expect((eggMcMuffin?.micronutrientsPerBasis.cholesterolMg ?? 0)).toBeGreaterThan(0);

    const enriched = await enrichMealItemsWithStaples<
      { name: string; microsPer100g?: Micronutrients }
    >([{ name: 'Egg McMuffin' }]);
    expect(typeof enriched[0].microsPer100g?.saturatedFatG).toBe('number');
    expect(typeof enriched[0].microsPer100g?.cholesterolMg).toBe('number');
    expect(typeof enriched[0].microsPer100g?.sugarG).toBe('number');
  });

  test('enrichMealItemsWithStaples normalizes perServing PH staple micros to per100g without double-scaling and skips weightless perServing items', async () => {
    const sample: FoodItem[] = [
      {
        id: 'staple:ph-mcdo-egg-mcmuffin',
        source: 'staple',
        name: 'Egg McMuffin',
        brand: "McDonald's",
        region: 'PH',
        basis: 'perServing',
        servingSize: 1,
        servingUnit: 'pc',
        servingWeightGrams: 136,
        nutrientsPerBasis: { calories: 310, protein: 17, carbs: 30, fat: 13, fiber: 2 },
        micronutrientsPerBasis: { sodiumMg: 770, calciumMg: 250, ironMg: 2.5, potassiumMg: 210 },
        updatedAt: 1700000000000,
      },
      {
        id: 'staple:ph-weightless-snack',
        source: 'staple',
        name: 'Mystery Street Snack',
        region: 'PH',
        basis: 'perServing',
        servingSize: 1,
        servingUnit: 'pc',
        nutrientsPerBasis: { calories: 150, protein: 4, carbs: 20, fat: 6, fiber: 1 },
        micronutrientsPerBasis: { sodiumMg: 400 },
        updatedAt: 1700000000000,
      },
    ];

    setStaplesCache(sample);
    try {
      const enriched = await enrichMealItemsWithStaples<{
        name: string;
        microsPer100g?: Micronutrients;
      }>([
        { name: 'Egg McMuffin' },
        { name: 'Mystery Street Snack' },
      ]);

      expect(enriched[0].microsPer100g?.sodiumMg).toBeCloseTo((770 * 100) / 136, 1);
      const scaled = scaleNutrition(
        { calories: 228, protein: 12.5, carbs: 22, fat: 9.6, fiber: 1.5 },
        enriched[0].microsPer100g!,
        'per100g',
        136
      );
      expect(scaled.micros.sodiumMg).toBeCloseTo(770, 0);
      expect(scaled.micros.calciumMg).toBeCloseTo(250, 0);
      expect(scaled.micros.ironMg).toBeCloseTo(2.5, 1);
      expect(scaled.micros.potassiumMg).toBeCloseTo(210, 0);

      // Weightless perServing item must not inject unscalable micros into microsPer100g
      expect(enriched[1].microsPer100g).toBeUndefined();
    } finally {
      setStaplesCache(null);
    }
  });

  test('estimateMissingStapleMicros scales caffeineMg and alcoholG by servingWeightGrams/100 for perServing items', () => {
    const espresso: FoodItem = {
      id: 'staple:espresso-shot',
      source: 'staple',
      name: 'Espresso Shot',
      basis: 'perServing',
      servingSize: 1,
      servingUnit: 'shot',
      servingWeightGrams: 30,
      nutrientsPerBasis: { calories: 3, protein: 0.1, carbs: 0.5, fat: 0, fiber: 0 },
      micronutrientsPerBasis: {},
      updatedAt: 1700000000000,
    };
    const brewedCoffee: FoodItem = {
      id: 'staple:coffee-cup',
      source: 'staple',
      name: 'Brewed Coffee',
      basis: 'perServing',
      servingSize: 240,
      servingUnit: 'ml',
      nutrientsPerBasis: { calories: 2, protein: 0.3, carbs: 0, fat: 0, fiber: 0 },
      micronutrientsPerBasis: {},
      updatedAt: 1700000000000,
    };
    const beerBottle: FoodItem = {
      id: 'staple:san-miguel-bottle',
      source: 'staple',
      name: 'San Miguel Pale Pilsen Beer',
      basis: 'perServing',
      servingSize: 1,
      servingUnit: 'bottle',
      servingWeightGrams: 330,
      nutrientsPerBasis: { calories: 142, protein: 1, carbs: 11, fat: 0, fiber: 0 },
      micronutrientsPerBasis: {},
      updatedAt: 1700000000000,
    };

    expect(estimateMissingStapleMicros(espresso).caffeineMg).toBeCloseTo(63.6, 1);
    expect(estimateMissingStapleMicros(brewedCoffee).caffeineMg).toBeCloseTo(108, 1);
    expect(estimateMissingStapleMicros(beerBottle).alcoholG).toBeCloseTo(13.2, 1);
  });
});
