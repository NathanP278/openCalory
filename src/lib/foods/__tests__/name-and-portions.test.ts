import { describe, expect, it } from 'vitest';
import {
  buildCanonicalFoodKey,
  cleanFoodDisplayName,
  generateFoodAliases,
} from '@/lib/foods/name-normalizer';
import {
  enrichServingOptions,
  extractUsdaPortions,
} from '@/lib/foods/portion-enrichment';
import {
  formatPortionUnit,
  parseHouseholdServingText,
  scaleFoodByOption,
} from '@/lib/nutrition/scaling';
import type { FoodItem, FoodServingOption } from '@/types/nutrition';
import type { UsdaFoodPayload } from '@/lib/foods/usda-adapter';

describe('cleanFoodDisplayName', () => {
  it('rewrites inverted USDA comma names into clean human-readable display names', () => {
    expect(cleanFoodDisplayName('Egg, whole, raw')).toBe('Whole Egg (Raw)');
    expect(cleanFoodDisplayName('Rice, white, short-grain, cooked')).toBe(
      'White Rice, Short-Grain (Cooked)'
    );
    expect(
      cleanFoodDisplayName('Chicken, broilers or fryers, breast, meat only, raw')
    ).toBe('Chicken Breast (Raw)');
    expect(cleanFoodDisplayName('Egg, white, raw')).toBe('Egg White (Raw)');
    expect(cleanFoodDisplayName('Oil, olive, salad or cooking')).toBe('Olive Oil');
  });

  it('preserves already-clean names and proper casing', () => {
    expect(cleanFoodDisplayName('Jollibee Chickenjoy', 'Jollibee')).toBe(
      'Jollibee Chickenjoy'
    );
    expect(cleanFoodDisplayName('Salmon Fillet')).toBe('Salmon Fillet');
    expect(cleanFoodDisplayName('CHICKEN BREAST')).toBe('Chicken Breast');
  });
});

describe('buildCanonicalFoodKey', () => {
  it('produces deterministic, punctuation-stripped, plural-normalized, brand-deduped keys', () => {
    expect(buildCanonicalFoodKey('Jollibee Chickenjoy', 'Jollibee')).toBe(
      buildCanonicalFoodKey('Chickenjoy', 'Jollibee')
    );
    expect(buildCanonicalFoodKey('Whole Eggs (Raw)')).toBe(
      buildCanonicalFoodKey('whole egg, raw')
    );
    expect(buildCanonicalFoodKey('Blueberries, raw')).toBe(
      buildCanonicalFoodKey('Blueberry raw')
    );
  });
});

describe('generateFoodAliases', () => {
  it('preserves rawName and adds multilingual/regional aliases without duplicates', () => {
    const riceAliases = generateFoodAliases(
      'Rice, white, short-grain, cooked',
      'White Rice, Short-Grain (Cooked)'
    );
    expect(riceAliases).toContain('Rice, white, short-grain, cooked');
    expect(riceAliases).toContain('japanese rice');
    expect(riceAliases).toContain('sushi rice');
    expect(riceAliases).toContain('gohan');
    expect(riceAliases).toContain('kanin');
    expect(riceAliases).toContain('bap');

    const eggAliases = generateFoodAliases('Egg, whole, raw', 'Whole Egg (Raw)');
    expect(eggAliases).toContain('Egg, whole, raw');
    expect(eggAliases).toContain('itlog');
    expect(eggAliases).toContain('tamago');

    const chickenAliases = generateFoodAliases(
      'Chicken, broilers or fryers, breast, meat only, raw',
      'Chicken Breast (Raw)'
    );
    expect(chickenAliases).toContain('manok');
  });

  it('deduplicates existing aliases and excludes cleanName itself', () => {
    const aliases = generateFoodAliases('Salmon Fillet', 'Salmon Fillet', [
      'sake',
      'SAKE',
      'Salmon Fillet',
    ]);
    expect(aliases.filter((a) => a.toLowerCase() === 'sake')).toHaveLength(1);
    expect(aliases).not.toContain('Salmon Fillet');
  });
});

describe('extractUsdaPortions', () => {
  it('extracts size qualifiers, volume units, and countable units from foodPortions and foodMeasures', () => {
    const eggPayload: UsdaFoodPayload = {
      fdcId: 171287,
      description: 'Egg, whole, raw, fresh',
      foodPortions: [
        {
          amount: 1,
          gramWeight: 50,
          modifier: 'large',
          measureUnit: { name: 'undetermined', abbreviation: 'undetermined' },
        },
        {
          amount: 1,
          gramWeight: 44,
          modifier: 'medium',
          measureUnit: { name: 'undetermined', abbreviation: 'undetermined' },
        },
        {
          amount: 1,
          gramWeight: 56,
          modifier: 'extra large',
          measureUnit: { name: 'undetermined', abbreviation: 'undetermined' },
        },
      ],
      foodMeasures: [
        {
          disseminationText: '1 large',
          gramWeight: 50,
          measureUnitName: 'undetermined',
        },
      ],
    };

    const eggPortions = extractUsdaPortions(eggPayload);
    expect(eggPortions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'large', unit: 'large', grams: 50, label: 'large (50g)' }),
        expect.objectContaining({ id: 'medium', unit: 'medium', grams: 44, label: 'medium (44g)' }),
        expect.objectContaining({
          id: 'extra large',
          unit: 'extra large',
          grams: 56,
          label: 'extra large (56g)',
        }),
      ])
    );
    // Deduplicated across foodPortions and foodMeasures
    expect(eggPortions.filter((p) => p.id === 'large')).toHaveLength(1);

    const ricePayload: UsdaFoodPayload = {
      fdcId: 169757,
      description: 'Rice, white, short-grain, cooked',
      foodPortions: [
        {
          amount: 1,
          gramWeight: 158,
          measureUnit: { name: 'cup', abbreviation: 'cup' },
        },
      ],
    };

    const ricePortions = extractUsdaPortions(ricePayload);
    expect(ricePortions).toEqual([
      expect.objectContaining({ id: 'cup', unit: 'cup', grams: 158, label: 'cup (158g)' }),
    ]);
  });
});

describe('enrichServingOptions', () => {
  it('enriches whole egg with large, medium, pc, g, and oz', () => {
    const options = enrichServingOptions({
      name: 'Whole Egg (Raw)',
      basis: 'per100g',
      existingOptions: [],
    });

    const ids = options.map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining(['large', 'medium', 'pc', 'g', 'oz']));
    expect(options.find((o) => o.id === 'large')).toMatchObject({
      label: 'large (50g)',
      unit: 'large',
      grams: 50,
    });
    expect(options.find((o) => o.id === 'medium')).toMatchObject({
      label: 'medium (44g)',
      unit: 'medium',
      grams: 44,
    });
    expect(options.find((o) => o.id === 'pc')).toMatchObject({
      label: 'pc (50g)',
      unit: 'pc',
      grams: 50,
    });
    expect(options.find((o) => o.id === 'oz')).toMatchObject({
      unit: 'oz',
      grams: 28.35,
      defaultAmount: 1,
    });
  });

  it('enriches cooked white rice with cup (158g), bowl (200g), g, and oz', () => {
    const options = enrichServingOptions({
      name: 'White Rice, Short-Grain (Cooked)',
      basis: 'per100g',
      existingOptions: [],
    });

    expect(options.find((o) => o.id === 'cup')).toMatchObject({
      label: 'cup (158g)',
      grams: 158,
    });
    expect(options.find((o) => o.id === 'bowl')).toMatchObject({
      label: 'bowl (200g)',
      grams: 200,
    });
    expect(options.find((o) => o.id === 'g')).toMatchObject({ grams: 1 });
    expect(options.find((o) => o.id === 'oz')).toMatchObject({ grams: 28.35 });
  });

  it('enriches olive oil with tbsp, tsp, g, and oz', () => {
    const options = enrichServingOptions({
      name: 'Olive Oil',
      basis: 'per100g',
      existingOptions: [],
    });

    expect(options.map((o) => o.id)).toEqual(
      expect.arrayContaining(['tbsp', 'tsp', 'g', 'oz'])
    );
  });

  it('uses ml and fl oz for per100ml liquids', () => {
    const options = enrichServingOptions({
      name: 'Whole Milk',
      basis: 'per100ml',
      existingOptions: [],
    });

    expect(options.map((o) => o.id)).toEqual(
      expect.arrayContaining(['cup', 'ml', 'fl oz'])
    );
    expect(options.find((o) => o.id === 'fl oz')).toMatchObject({
      unit: 'fl oz',
      grams: 29.57,
      defaultAmount: 1,
    });
  });
});

describe('scaling.ts oz, fl oz, and size-qualifier support', () => {
  const WHOLE_EGG: FoodItem = {
    id: 'usda:171287',
    source: 'usda',
    name: 'Whole Egg (Raw)',
    basis: 'per100g',
    servingSize: 100,
    servingUnit: 'g',
    nutrientsPerBasis: {
      calories: 143,
      protein: 12.56,
      carbs: 0.72,
      fat: 9.51,
      fiber: 0,
    },
    micronutrientsPerBasis: {},
    updatedAt: 1700000000000,
  };

  it('parses oz, fl oz, and size qualifiers in parseHouseholdServingText', () => {
    expect(parseHouseholdServingText('1 oz')).toEqual({ count: 1, unit: 'oz' });
    expect(parseHouseholdServingText('8 fl oz')).toEqual({ count: 8, unit: 'fl oz' });
    expect(parseHouseholdServingText('1 large')).toEqual({ count: 1, unit: 'large' });
    expect(parseHouseholdServingText('2 medium')).toEqual({ count: 2, unit: 'medium' });
    expect(parseHouseholdServingText('1 extra large')).toEqual({
      count: 1,
      unit: 'extra large',
    });
    expect(formatPortionUnit(2, 'oz')).toBe('oz');
    expect(formatPortionUnit(8, 'fl oz')).toBe('fl oz');
    expect(formatPortionUnit(2, 'large')).toBe('large');
  });

  it('scales 1 oz as 28.35g and 2 large eggs as 100g', () => {
    const ozOption: FoodServingOption = {
      id: 'oz',
      label: 'oz',
      unit: 'oz',
      grams: 28.35,
      defaultAmount: 1,
    };
    const largeOption: FoodServingOption = {
      id: 'large',
      label: 'large (50g)',
      unit: 'large',
      grams: 50,
      defaultAmount: 1,
    };

    const oneOz = scaleFoodByOption(WHOLE_EGG, 1, ozOption);
    expect(oneOz.effectiveGrams).toBe(28.35);
    expect(oneOz.macros.calories).toBeCloseTo(40.54, 1);

    const twoLarge = scaleFoodByOption(WHOLE_EGG, 2, largeOption);
    expect(twoLarge.effectiveGrams).toBe(100);
    expect(twoLarge.macros.calories).toBe(143);
    expect(twoLarge.macros.protein).toBe(12.56);
  });
});
