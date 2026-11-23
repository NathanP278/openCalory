import { describe, expect, it } from 'vitest';
import {
  deduplicateCatalogRecords,
  deduplicateSearchResults,
  normalizeBarcode,
} from '@/lib/foods/dedup';
import type { CatalogFoodInput } from '@/lib/foods/catalog-schema';
import type { FoodItem } from '@/types/nutrition';

function makeCatalogFood(overrides: Partial<CatalogFoodInput> = {}): CatalogFoodInput {
  return {
    id: 'usda:1',
    barcode: null,
    source: 'usda',
    sourceProvider: 'usda_foundation',
    accuracyTier: 1,
    region: 'GLOBAL',
    category: 'Dairy and Egg Products',
    name: 'Whole Egg (Raw)',
    brand: undefined,
    aliases: [],
    basis: 'per100g',
    servingSize: 100,
    servingUnit: 'g',
    servingWeightGrams: 100,
    servingOptions: [
      { id: 'large', label: 'large (50g)', unit: 'large', grams: 50, defaultAmount: 1 },
      { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      { id: 'oz', label: 'oz', unit: 'oz', grams: 28.35, defaultAmount: 1 },
    ],
    nutrientsPerBasis: {
      calories: 143,
      protein: 12.56,
      carbs: 0.72,
      fat: 9.51,
      fiber: 0,
    },
    micronutrientsPerBasis: {
      sodiumMg: 142,
      potassiumMg: 138,
      calciumMg: 56,
      ironMg: 1.75,
      vitaminDMcg: 2,
    },
    updatedAt: 1700000000000,
    ...overrides,
  };
}

function makeSearchFood(overrides: Partial<FoodItem> = {}): FoodItem {
  return {
    id: 'usda:323604',
    barcode: null,
    source: 'usda',
    accuracyTier: 1,
    region: 'GLOBAL',
    category: 'Dairy and Egg Products',
    name: 'Whole Egg (Raw)',
    basis: 'per100g',
    servingSize: 100,
    servingUnit: 'g',
    servingWeightGrams: 100,
    servingOptions: [
      { id: 'large', label: 'large (50g)', unit: 'large', grams: 50, defaultAmount: 1 },
      { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      { id: 'oz', label: 'oz', unit: 'oz', grams: 28.35, defaultAmount: 1 },
    ],
    nutrientsPerBasis: {
      calories: 143,
      protein: 12.56,
      carbs: 0.72,
      fat: 9.51,
      fiber: 0,
    },
    micronutrientsPerBasis: {
      sodiumMg: 142,
      calciumMg: 56,
    },
    updatedAt: 1700000000000,
    ...overrides,
  };
}

describe('normalizeBarcode', () => {
  it('normalizes 12-digit UPC-A to 13-digit leading-zero EAN-13', () => {
    expect(normalizeBarcode('012345678905')).toBe('0012345678905');
    expect(normalizeBarcode('0012345678905')).toBe('0012345678905');
    expect(normalizeBarcode(' 012-345 678-905 ')).toBe('0012345678905');
  });

  it('returns null for empty, too-short (<8), or too-long (>14) barcodes', () => {
    expect(normalizeBarcode(null)).toBeNull();
    expect(normalizeBarcode(undefined)).toBeNull();
    expect(normalizeBarcode('')).toBeNull();
    expect(normalizeBarcode('   ')).toBeNull();
    expect(normalizeBarcode('1234567')).toBeNull();
    expect(normalizeBarcode('123456789012345')).toBeNull();
  });

  it('preserves valid 8-digit EAN-8 and 14-digit GTIN-14 barcodes', () => {
    expect(normalizeBarcode('12345678')).toBe('12345678');
    expect(normalizeBarcode('10012345678902')).toBe('10012345678902');
  });
});

describe('deduplicateCatalogRecords', () => {
  it('merges Tier 1 USDA Foundation egg, Tier 1 SR Legacy egg, and Tier 4 OFF Eggs into one canonical egg', () => {
    const foundationEgg = makeCatalogFood({
      id: 'usda:foundation:748967',
      sourceProvider: 'usda_foundation',
      accuracyTier: 1,
      name: 'Whole Egg (Raw)',
      aliases: ['itlog'],
      legacyIds: ['staple:egg-raw'],
      servingOptions: [
        { id: 'large', label: 'large (50g)', unit: 'large', grams: 50, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
        { id: 'oz', label: 'oz', unit: 'oz', grams: 28.35, defaultAmount: 1 },
      ],
      micronutrientsPerBasis: {
        sodiumMg: 142,
        potassiumMg: 138,
        calciumMg: 56,
        ironMg: 1.75,
        vitaminDMcg: 2,
        vitaminB12Mcg: 0.89,
      },
    });

    const srLegacyEgg = makeCatalogFood({
      id: 'usda:sr:171287',
      sourceProvider: 'usda_sr_legacy',
      accuracyTier: 1,
      name: 'Eggs, Grade A, Large, Whole, Raw',
      aliases: ['tamago'],
      legacyIds: ['staple:usda-171287'],
      servingOptions: [
        { id: 'large', label: 'large (52g)', unit: 'large', grams: 52, defaultAmount: 1 },
        { id: 'medium', label: 'medium (44g)', unit: 'medium', grams: 44, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
      micronutrientsPerBasis: {
        sodiumMg: 142,
        calciumMg: 56,
      },
    });

    const offEgg = makeCatalogFood({
      id: 'off:generic-eggs',
      source: 'off',
      sourceProvider: 'openfoodfacts',
      accuracyTier: 4,
      category: 'Eggs',
      name: 'Eggs',
      aliases: ['huevo'],
      servingOptions: [
        { id: 'pc', label: 'pc (50g)', unit: 'pc', grams: 50, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
      nutrientsPerBasis: {
        calories: 145,
        protein: 12.5,
        carbs: 1.0,
        fat: 9.8,
        fiber: 0,
      },
      micronutrientsPerBasis: {
        sodiumMg: 140,
      },
    });

    const result = deduplicateCatalogRecords([offEgg, srLegacyEgg, foundationEgg]);

    expect(result.foods).toHaveLength(1);
    const winner = result.foods[0];
    expect(winner.id).toBe('usda:foundation:748967');
    expect(winner.accuracyTier).toBe(1);

    // Serving options: winner's 'large' (50g) wins over SR Legacy's 52g, medium + pc added, g + oz at the end
    const optionIds = (winner.servingOptions ?? []).map((o) => o.id);
    expect(optionIds).toEqual(['large', 'medium', 'pc', 'g', 'oz']);
    expect(winner.servingOptions?.find((o) => o.id === 'large')?.grams).toBe(50);

    // Aliases unioned including dropped items' names & aliases
    expect(winner.aliases).toEqual(
      expect.arrayContaining(['itlog', 'tamago', 'huevo', 'Eggs, Grade A, Large, Whole, Raw', 'Eggs'])
    );

    // Legacy IDs & legacyAliases map all dropped IDs, dropped legacyIds, and winner's own legacyIds
    expect(result.legacyAliases.get('usda:sr:171287')).toBe('usda:foundation:748967');
    expect(result.legacyAliases.get('staple:usda-171287')).toBe('usda:foundation:748967');
    expect(result.legacyAliases.get('off:generic-eggs')).toBe('usda:foundation:748967');
    expect(result.legacyAliases.get('staple:egg-raw')).toBe('usda:foundation:748967');
    expect(winner.legacyIds).toEqual(
      expect.arrayContaining(['staple:egg-raw', 'usda:sr:171287', 'staple:usda-171287', 'off:generic-eggs'])
    );
  });

  it('collapses UPC-A 012345678905 and EAN-13 0012345678905 into one record', () => {
    const usdaBranded = makeCatalogFood({
      id: 'usda:branded:1001',
      barcode: '012345678905',
      source: 'usda',
      sourceProvider: 'usda_branded',
      accuracyTier: 3,
      name: 'Greek Yogurt Plain',
      brand: 'Chobani',
      servingOptions: [
        { id: 'container', label: 'container (150g)', unit: 'container', grams: 150, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
      micronutrientsPerBasis: { calciumMg: 150, sodiumMg: 55 },
    });

    const offProduct = makeCatalogFood({
      id: 'off:0012345678905',
      barcode: '0012345678905',
      source: 'off',
      sourceProvider: 'openfoodfacts',
      accuracyTier: 4,
      name: 'Chobani Plain Greek Yogurt',
      brand: 'Chobani',
      servingOptions: [
        { id: 'cup', label: 'cup (227g)', unit: 'cup', grams: 227, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
      micronutrientsPerBasis: { sodiumMg: 55 },
    });

    const result = deduplicateCatalogRecords([offProduct, usdaBranded]);
    expect(result.foods).toHaveLength(1);
    expect(result.foods[0].id).toBe('usda:branded:1001');
    expect(result.foods[0].servingOptions?.map((o) => o.id)).toEqual(['container', 'cup', 'g']);
    expect(result.legacyAliases.get('off:0012345678905')).toBe('usda:branded:1001');
  });

  it('does NOT merge raw and cooked foods (White Rice Raw vs White Rice Cooked)', () => {
    const rawRice = makeCatalogFood({
      id: 'usda:rice-raw',
      name: 'White Rice (Raw)',
      category: 'Cereal Grains and Pasta',
      nutrientsPerBasis: { calories: 365, protein: 7.1, carbs: 80, fat: 0.7, fiber: 1.3 },
    });
    const cookedRice = makeCatalogFood({
      id: 'usda:rice-cooked',
      name: 'White Rice (Cooked)',
      category: 'Cereal Grains and Pasta',
      nutrientsPerBasis: { calories: 130, protein: 2.7, carbs: 28.2, fat: 0.3, fiber: 0.4 },
    });

    const result = deduplicateCatalogRecords([rawRice, cookedRice]);
    expect(result.foods).toHaveLength(2);
    expect(result.foods.map((f) => f.id)).toEqual(['usda:rice-raw', 'usda:rice-cooked']);
  });

  it('does NOT merge distinct brands with the same product name', () => {
    const chobani = makeCatalogFood({
      id: 'usda:chobani',
      name: 'Greek Yogurt',
      brand: 'Chobani',
      accuracyTier: 3,
      nutrientsPerBasis: { calories: 59, protein: 10, carbs: 3.6, fat: 0.4, fiber: 0 },
    });
    const fage = makeCatalogFood({
      id: 'usda:fage',
      name: 'Greek Yogurt',
      brand: 'Fage',
      accuracyTier: 3,
      nutrientsPerBasis: { calories: 54, protein: 10.3, carbs: 3.0, fat: 0, fiber: 0 },
    });

    const result = deduplicateCatalogRecords([chobani, fage]);
    expect(result.foods).toHaveLength(2);
  });

  it('breaks ties by accuracyTier -> micronutrient count -> servingOptions count -> shorter name', () => {
    const longerName = makeCatalogFood({
      id: 'usda:long',
      name: 'Chicken Breast Raw Unprepared',
      accuracyTier: 1,
      micronutrientsPerBasis: { sodiumMg: 74, potassiumMg: 256 },
      servingOptions: [
        { id: 'breast', label: 'breast (174g)', unit: 'breast', grams: 174, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
      nutrientsPerBasis: { calories: 120, protein: 22.5, carbs: 0, fat: 2.6, fiber: 0 },
    });
    const shorterName = makeCatalogFood({
      id: 'usda:short',
      name: 'Chicken Breast (Raw)',
      accuracyTier: 1,
      micronutrientsPerBasis: { sodiumMg: 74, potassiumMg: 256 },
      servingOptions: [
        { id: 'breast', label: 'breast (174g)', unit: 'breast', grams: 174, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
      nutrientsPerBasis: { calories: 120, protein: 22.5, carbs: 0, fat: 2.6, fiber: 0 },
    });

    const result = deduplicateCatalogRecords([longerName, shorterName]);
    expect(result.foods).toHaveLength(1);
    expect(result.foods[0].id).toBe('usda:short');
  });
});

describe('deduplicateSearchResults', () => {
  it('collapses legacy ID staple:323604 and canonical usda:323604 via aliasMap', () => {
    const stapleItem = makeSearchFood({
      id: 'staple:323604',
      source: 'staple',
      accuracyTier: 1,
      name: 'Whole Egg (Raw)',
      servingOptions: [
        { id: 'pc', label: 'pc (50g)', unit: 'pc', grams: 50, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
      micronutrientsPerBasis: { sodiumMg: 142 },
    });
    const usdaItem = makeSearchFood({
      id: 'usda:323604',
      source: 'usda',
      accuracyTier: 1,
      name: 'Whole Egg (Raw)',
      servingOptions: [
        { id: 'large', label: 'large (50g)', unit: 'large', grams: 50, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
        { id: 'oz', label: 'oz', unit: 'oz', grams: 28.35, defaultAmount: 1 },
      ],
      micronutrientsPerBasis: { sodiumMg: 142, potassiumMg: 138, calciumMg: 56 },
    });

    const aliasMap = new Map<string, string>([['staple:323604', 'usda:323604']]);
    const result = deduplicateSearchResults([stapleItem, usdaItem], aliasMap);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('usda:323604');
    expect(result[0].servingOptions?.map((o) => o.id)).toEqual(['large', 'pc', 'g', 'oz']);
  });

  it('collapses UPC-A 012345678905 and EAN-13 0012345678905 in search results', () => {
    const upcItem = makeSearchFood({
      id: 'usda:branded:1',
      barcode: '012345678905',
      source: 'usda',
      accuracyTier: 3,
      name: 'Oat Milk',
      brand: 'Oatly',
    });
    const eanItem = makeSearchFood({
      id: 'off:0012345678905',
      barcode: '0012345678905',
      source: 'off',
      accuracyTier: 4,
      name: 'Oatly Oat Milk',
      brand: 'Oatly',
      servingOptions: [
        { id: 'cup', label: 'cup (240ml)', unit: 'cup', grams: 240, defaultAmount: 1 },
        { id: 'ml', label: 'ml', unit: 'ml', grams: 1, defaultAmount: 100 },
      ],
    });

    const result = deduplicateSearchResults([upcItem, eanItem]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('usda:branded:1');
    expect(result[0].servingOptions?.some((o) => o.id === 'cup')).toBe(true);
  });

  it('merges missing serving options from a dropped live OFF hit onto a Tier 1 catalog hit', () => {
    const catalogHit = makeSearchFood({
      id: 'catalog:usda:171287',
      source: 'catalog',
      accuracyTier: 1,
      name: 'Whole Egg (Raw)',
      servingOptions: [
        { id: 'large', label: 'large (50g)', unit: 'large', grams: 50, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
        { id: 'oz', label: 'oz', unit: 'oz', grams: 28.35, defaultAmount: 1 },
      ],
    });
    const liveOffHit = makeSearchFood({
      id: 'off:live-egg',
      source: 'off',
      accuracyTier: 4,
      name: 'Eggs',
      brand: undefined,
      servingOptions: [
        { id: 'large', label: 'large (55g)', unit: 'large', grams: 55, defaultAmount: 1 },
        { id: 'pc', label: 'pc (50g)', unit: 'pc', grams: 50, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
    });

    const result = deduplicateSearchResults([catalogHit, liveOffHit]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('catalog:usda:171287');
    expect(result[0].servingOptions?.map((o) => o.id)).toEqual(['large', 'pc', 'g', 'oz']);
    expect(result[0].servingOptions?.find((o) => o.id === 'large')?.grams).toBe(50);
  });

  it('preserves custom_food items with distinct brands and maintains input ranking order', () => {
    const customItem = makeSearchFood({
      id: 'custom:egg-prep',
      source: 'custom_food',
      accuracyTier: undefined,
      name: 'Whole Egg (Raw)',
      brand: 'My Farm',
      barcode: '012345678905',
    });
    const catalogEgg = makeSearchFood({
      id: 'catalog:usda:171287',
      source: 'catalog',
      accuracyTier: 1,
      name: 'Whole Egg (Raw)',
      brand: undefined,
      barcode: '0012345678905',
    });
    const banana = makeSearchFood({
      id: 'catalog:usda:173944',
      source: 'catalog',
      accuracyTier: 1,
      name: 'Banana (Raw)',
      nutrientsPerBasis: { calories: 89, protein: 1.1, carbs: 22.8, fat: 0.3, fiber: 2.6 },
    });

    const result = deduplicateSearchResults([customItem, banana, catalogEgg]);
    expect(result).toHaveLength(3);
    expect(result.map((f) => f.id)).toEqual([
      'custom:egg-prep',
      'catalog:usda:173944',
      'catalog:usda:171287',
    ]);
  });

  it('does not collapse raw vs cooked foods in search results', () => {
    const rawRice = makeSearchFood({
      id: 'catalog:rice-raw',
      name: 'White Rice (Raw)',
      nutrientsPerBasis: { calories: 365, protein: 7.1, carbs: 80, fat: 0.7, fiber: 1.3 },
    });
    const cookedRice = makeSearchFood({
      id: 'catalog:rice-cooked',
      name: 'White Rice (Cooked)',
      nutrientsPerBasis: { calories: 130, protein: 2.7, carbs: 28.2, fat: 0.3, fiber: 0.4 },
    });

    const result = deduplicateSearchResults([rawRice, cookedRice]);
    expect(result).toHaveLength(2);
  });
});
