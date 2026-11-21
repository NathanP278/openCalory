import type {
  FoodItem,
  FoodServingOption,
  Micronutrients,
  MacroNutrients,
  NutritionBasis,
} from '@/types/nutrition';
import { parseHouseholdServingText } from '@/lib/nutrition/scaling';

export interface OffNutriments {
  energy?: number;
  'energy-kcal'?: number;
  'energy-kcal_100g'?: number;
  'energy-kcal_100ml'?: number;
  'energy-kcal_serving'?: number;
  proteins_100g?: number;
  proteins_100ml?: number;
  proteins_serving?: number;
  carbohydrates_100g?: number;
  carbohydrates_100ml?: number;
  carbohydrates_serving?: number;
  fat_100g?: number;
  fat_100ml?: number;
  fat_serving?: number;
  fiber_100g?: number;
  fiber_100ml?: number;
  fiber_serving?: number;
  sodium_100g?: number;
  sodium_100ml?: number;
  sodium_serving?: number;
  salt_100g?: number;
  salt_100ml?: number;
  salt_serving?: number;
  sugars_100g?: number;
  sugars_100ml?: number;
  sugars_serving?: number;
  'added-sugars_100g'?: number;
  'added-sugars_100ml'?: number;
  'added-sugars_serving'?: number;
  'saturated-fat_100g'?: number;
  'saturated-fat_100ml'?: number;
  'saturated-fat_serving'?: number;
  cholesterol_100g?: number;
  cholesterol_100ml?: number;
  cholesterol_serving?: number;
  caffeine_100g?: number;
  caffeine_100ml?: number;
  caffeine_serving?: number;
  alcohol?: number;
  alcohol_100g?: number;
  alcohol_100ml?: number;
  alcohol_serving?: number;
  [key: string]: unknown;
}

export interface OffProduct {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  generic_name?: string;
  brands?: string;
  brand_owner?: string;
  countries_tags?: string[];
  nutriments?: OffNutriments;
  product_quantity_unit?: string;
  serving_quantity_unit?: string;
  serving_quantity?: number | string;
  serving_size?: string;
  [key: string]: unknown;
}

export interface OffApiResponse {
  status?: number;
  status_verbose?: string;
  product?: OffProduct;
  code?: string;
  [key: string]: unknown;
}

const round2 = (val: number): number => Math.round((val + Number.EPSILON) * 100) / 100;

function parseNumeric(val: unknown): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function extractOffServingOption(
  product: OffProduct,
  basis: NutritionBasis
): { option?: FoodServingOption; servingWeightGrams?: number } {
  const baseUnit = basis === 'per100ml' ? 'ml' : 'g';
  const rawServingSize =
    typeof product.serving_size === 'string' ? product.serving_size.trim() : '';
  const servingQty = parseNumeric(product.serving_quantity);
  const servingQtyUnit =
    typeof product.serving_quantity_unit === 'string'
      ? product.serving_quantity_unit.toLowerCase().trim()
      : '';

  let metricWeight: number | undefined;
  const metricMatch = rawServingSize.match(/(\d+(?:\.\d+)?)\s*(g|gr|grams|ml)\b/i);
  if (metricMatch) {
    const val = Number(metricMatch[1]);
    if (Number.isFinite(val) && val > 0) metricWeight = val;
  } else if (
    servingQty &&
    servingQty > 0 &&
    (servingQtyUnit === 'g' || servingQtyUnit === 'ml' || servingQtyUnit === '')
  ) {
    metricWeight = servingQty;
  }

  if (!metricWeight || metricWeight <= 0) {
    return {};
  }

  const parsedText =
    parseHouseholdServingText(rawServingSize) ??
    (servingQtyUnit && servingQtyUnit !== 'g' && servingQtyUnit !== 'ml'
      ? parseHouseholdServingText(servingQtyUnit)
      : null);

  let count = 1;
  let unit = 'serving';
  if (parsedText) {
    count = parsedText.count;
    unit = parsedText.unit;
  } else if (!rawServingSize) {
    return { servingWeightGrams: round2(metricWeight) };
  } else if (round2(metricWeight) === 100) {
    return { servingWeightGrams: 100 };
  }

  const perUnitGrams = round2(metricWeight / count);
  if (perUnitGrams <= 0) return {};

  return {
    servingWeightGrams: round2(metricWeight),
    option: {
      id: unit,
      label: `${unit} (${perUnitGrams}${baseUnit})`,
      unit,
      grams: perUnitGrams,
      defaultAmount: 1,
    },
  };
}

/**
 * Parses Open Food Facts API product payload into openCalory's FoodItem model.
 * - Returns null when product not found (status === 0) or payload/product is invalid.
 * - NEVER reads nutriments.energy (which is in kJ); strictly reads energy-kcal_* fields.
 * - Determines basis: 'per100g', 'per100ml', or 'perServing'.
 * - Converts sodium (in g) to sodiumMg (* 1000) or falls back to salt * 400.
 */
export function parseOffProduct(barcode: string, payload: unknown): FoodItem | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const data = payload as OffApiResponse;
  if (data.status === 0 || !data.product || typeof data.product !== 'object') {
    return null;
  }

  const product = data.product;
  const cleanBarcode = barcode.trim();
  const nutriments = (product.nutriments && typeof product.nutriments === 'object' ? product.nutriments : {}) as OffNutriments;

  const rawName = product.product_name || product.product_name_en || product.generic_name;
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : 'Unknown Food';

  const rawBrand = product.brands || product.brand_owner;
  const brand = typeof rawBrand === 'string' && rawBrand.trim() ? rawBrand.trim() : undefined;

  const has100g =
    parseNumeric(nutriments['energy-kcal_100g']) !== undefined ||
    parseNumeric(nutriments.proteins_100g) !== undefined ||
    parseNumeric(nutriments.carbohydrates_100g) !== undefined ||
    parseNumeric(nutriments.fat_100g) !== undefined ||
    parseNumeric(nutriments.fiber_100g) !== undefined;

  const has100ml =
    parseNumeric(nutriments['energy-kcal_100ml']) !== undefined ||
    parseNumeric(nutriments.proteins_100ml) !== undefined ||
    parseNumeric(nutriments.carbohydrates_100ml) !== undefined ||
    parseNumeric(nutriments.fat_100ml) !== undefined ||
    parseNumeric(nutriments.fiber_100ml) !== undefined;

  const hasServing =
    parseNumeric(nutriments['energy-kcal_serving']) !== undefined ||
    parseNumeric(nutriments.proteins_serving) !== undefined ||
    parseNumeric(nutriments.carbohydrates_serving) !== undefined ||
    parseNumeric(nutriments.fat_serving) !== undefined ||
    parseNumeric(nutriments.fiber_serving) !== undefined;

  const productUnit =
    typeof product.product_quantity_unit === 'string'
      ? product.product_quantity_unit.toLowerCase().trim()
      : '';
  const servingUnitStr =
    typeof product.serving_quantity_unit === 'string'
      ? product.serving_quantity_unit.toLowerCase().trim()
      : '';

  const isLiquid = productUnit === 'ml' || servingUnitStr === 'ml';

  let basis: NutritionBasis;
  if (isLiquid && (has100ml || has100g)) {
    basis = 'per100ml';
  } else if (has100g) {
    basis = 'per100g';
  } else if (has100ml) {
    basis = 'per100ml';
  } else if (hasServing) {
    basis = 'perServing';
  } else {
    basis = 'per100g';
  }

  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  let fiber = 0;
  let servingSize = 100;
  let servingUnit = 'g';

  if (basis === 'per100ml') {
    calories =
      parseNumeric(nutriments['energy-kcal_100ml']) ??
      parseNumeric(nutriments['energy-kcal_100g']) ??
      0;
    protein =
      parseNumeric(nutriments.proteins_100ml) ??
      parseNumeric(nutriments.proteins_100g) ??
      0;
    carbs =
      parseNumeric(nutriments.carbohydrates_100ml) ??
      parseNumeric(nutriments.carbohydrates_100g) ??
      0;
    fat =
      parseNumeric(nutriments.fat_100ml) ??
      parseNumeric(nutriments.fat_100g) ??
      0;
    fiber =
      parseNumeric(nutriments.fiber_100ml) ??
      parseNumeric(nutriments.fiber_100g) ??
      0;
    servingSize = 100;
    servingUnit = 'ml';
  } else if (basis === 'perServing') {
    calories = parseNumeric(nutriments['energy-kcal_serving']) ?? 0;
    protein = parseNumeric(nutriments.proteins_serving) ?? 0;
    carbs = parseNumeric(nutriments.carbohydrates_serving) ?? 0;
    fat = parseNumeric(nutriments.fat_serving) ?? 0;
    fiber = parseNumeric(nutriments.fiber_serving) ?? 0;
    servingSize = parseNumeric(product.serving_quantity) ?? 1;
    servingUnit =
      typeof product.serving_quantity_unit === 'string' && product.serving_quantity_unit.trim()
        ? product.serving_quantity_unit.trim()
        : typeof product.serving_size === 'string' && product.serving_size.trim()
          ? product.serving_size.trim()
          : 'serving';
  } else {
    // 'per100g'
    calories = parseNumeric(nutriments['energy-kcal_100g']) ?? 0;
    protein = parseNumeric(nutriments.proteins_100g) ?? 0;
    carbs = parseNumeric(nutriments.carbohydrates_100g) ?? 0;
    fat = parseNumeric(nutriments.fat_100g) ?? 0;
    fiber = parseNumeric(nutriments.fiber_100g) ?? 0;
    servingSize = 100;
    servingUnit = 'g';
  }

  const micros: Micronutrients = {};
  let rawSodium: number | undefined;
  let rawSalt: number | undefined;

  if (basis === 'perServing') {
    rawSodium = parseNumeric(nutriments.sodium_serving);
    rawSalt = parseNumeric(nutriments.salt_serving);
  } else if (basis === 'per100ml') {
    rawSodium = parseNumeric(nutriments.sodium_100ml) ?? parseNumeric(nutriments.sodium_100g);
    rawSalt = parseNumeric(nutriments.salt_100ml) ?? parseNumeric(nutriments.salt_100g);
  } else {
    rawSodium = parseNumeric(nutriments.sodium_100g);
    rawSalt = parseNumeric(nutriments.salt_100g);
  }

  if (rawSodium !== undefined) {
    micros.sodiumMg = round2(rawSodium * 1000);
  } else if (rawSalt !== undefined) {
    micros.sodiumMg = round2(rawSalt * 400);
  }

  const pickBasisNutriment = (
    baseKey: string,
    fallbackBareKey = false
  ): number | undefined => {
    if (basis === 'perServing') {
      return parseNumeric(nutriments[`${baseKey}_serving`]);
    }
    if (basis === 'per100ml') {
      return (
        parseNumeric(nutriments[`${baseKey}_100ml`]) ??
        parseNumeric(nutriments[`${baseKey}_100g`]) ??
        (fallbackBareKey ? parseNumeric(nutriments[baseKey]) : undefined)
      );
    }
    return (
      parseNumeric(nutriments[`${baseKey}_100g`]) ??
      (fallbackBareKey ? parseNumeric(nutriments[baseKey]) : undefined)
    );
  };

  const rawSugar = pickBasisNutriment('sugars');
  if (rawSugar !== undefined) {
    micros.sugarG = round2(Math.max(0, rawSugar));
  }

  const rawAddedSugar = pickBasisNutriment('added-sugars');
  if (rawAddedSugar !== undefined) {
    micros.addedSugarG = round2(Math.max(0, rawAddedSugar));
  }

  const rawSaturatedFat = pickBasisNutriment('saturated-fat');
  if (rawSaturatedFat !== undefined) {
    micros.saturatedFatG = round2(Math.max(0, rawSaturatedFat));
  }

  const rawCholesterol = pickBasisNutriment('cholesterol');
  if (rawCholesterol !== undefined) {
    micros.cholesterolMg = round2(Math.max(0, rawCholesterol) * 1000);
  }

  const rawCaffeine = pickBasisNutriment('caffeine');
  if (rawCaffeine !== undefined) {
    micros.caffeineMg = round2(Math.max(0, rawCaffeine) * 1000);
  }

  const rawAlcohol = pickBasisNutriment('alcohol', true);
  if (rawAlcohol !== undefined) {
    micros.alcoholG = round2(Math.max(0, rawAlcohol));
  }

  const nutrientsPerBasis: MacroNutrients = {
    calories: round2(Math.max(0, calories)),
    protein: round2(Math.max(0, protein)),
    carbs: round2(Math.max(0, carbs)),
    fat: round2(Math.max(0, fat)),
    fiber: round2(Math.max(0, fiber)),
  };

  const region =
    Array.isArray(product.countries_tags) &&
    product.countries_tags.some(
      (tag) => typeof tag === 'string' && tag.toLowerCase().includes('philippines')
    )
      ? 'PH'
      : undefined;

  const { option: offOption, servingWeightGrams } = extractOffServingOption(product, basis);
  const metricUnit = basis === 'per100ml' ? 'ml' : 'g';
  const servingOptions: FoodServingOption[] | undefined =
    offOption && (basis === 'per100g' || basis === 'per100ml')
      ? [
          offOption,
          {
            id: metricUnit,
            label: metricUnit,
            unit: metricUnit,
            grams: 1,
            defaultAmount: 100,
          },
        ]
      : undefined;

  return {
    id: `off:${cleanBarcode}`,
    barcode: cleanBarcode,
    source: 'off',
    name,
    brand,
    ...(region ? { region } : {}),
    basis,
    servingSize,
    servingUnit,
    ...(servingWeightGrams ? { servingWeightGrams } : {}),
    ...(servingOptions ? { servingOptions } : {}),
    nutrientsPerBasis,
    micronutrientsPerBasis: micros,
    updatedAt: Date.now(),
  };
}

/**
 * Searches Open Food Facts crowd-sourced database via openCalory's proxy route (/api/off/search).
 * Filters out unpopulated stubs and tags PH catalog products with region: 'PH'.
 */
export async function searchOffFoods(
  query: string,
  options?: { country?: 'ph' | 'world'; signal?: AbortSignal }
): Promise<FoodItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const country = options?.country ?? 'world';
  const url = `/api/off/search?query=${encodeURIComponent(trimmed)}&country=${country}`;
  const res = await fetch(url, { signal: options?.signal });
  if (!res.ok) {
    throw new Error(`Open Food Facts search failed with status ${res.status}`);
  }

  const data = await res.json();
  const rawProducts: unknown[] = Array.isArray(data?.products) ? data.products : [];
  const results: FoodItem[] = [];
  const seenIds = new Set<string>();

  for (const raw of rawProducts) {
    if (!raw || typeof raw !== 'object') continue;
    const prod = raw as OffProduct & { code?: string };
    const code = typeof prod.code === 'string' ? prod.code.trim() : '';
    if (!code) continue;

    const item = parseOffProduct(code, { status: 1, product: prod });
    if (!item || item.name === 'Unknown Food') continue;

    const { calories, protein, carbs, fat } = item.nutrientsPerBasis;
    if (calories === 0 && protein === 0 && carbs === 0 && fat === 0) continue;

    if (country === 'ph' && !item.region) {
      item.region = 'PH';
    }
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      results.push(item);
    }
  }

  return results;
}
