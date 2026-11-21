import { db, generateId } from '@/lib/db/opencalory-db';
import {
  formatPortionUnit,
  getServingOptionsForFood,
  scaleNutrition,
} from '@/lib/nutrition/scaling';
import { loadStaples } from '@/lib/foods/staples-search';
import type {
  CustomRecipe,
  CustomRecipeIngredient,
  FoodItem,
  FoodLogEntry,
  MacroNutrients,
  Micronutrients,
  NutritionBasis,
} from '@/types/nutrition';

/**
 * Pure local calendar date offset helper without UTC drift.
 * Format: YYYY-MM-DD.
 */
export function offsetIsoDate(isoDate: string, days: number): string {
  const parts = (isoDate || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const [y, m, d] = parts;
  const dateObj = new Date(y, m - 1, d + days);
  const outY = dateObj.getFullYear();
  const outM = String(dateObj.getMonth() + 1).padStart(2, '0');
  const outD = String(dateObj.getDate()).padStart(2, '0');
  return `${outY}-${outM}-${outD}`;
}

export interface RecipeTotals {
  totalGrams: number;
  macros: MacroNutrients;
  micros: Micronutrients;
}

/**
 * Computes raw cumulative totals across ingredients.
 * Respects explicit gramWeights, (ing as any).gramWeight, (ing as any).gramsPerUnit,
 * or (ing as any).servingSize for perServing ingredients so that per100g recipes
 * do not count 1 serving as 1 gram.
 */
export function calculateRecipeTotals(
  ingredients: CustomRecipeIngredient[],
  gramWeights?: number[]
): RecipeTotals {
  let totalGrams = 0;
  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  let fiber = 0;
  const micros: Micronutrients = {};

  for (let i = 0; i < (ingredients || []).length; i++) {
    const ing = ingredients[i];
    if (!ing) continue;

    let weight = 0;
    if (gramWeights && typeof gramWeights[i] === 'number' && Number.isFinite(gramWeights[i])) {
      weight = gramWeights[i];
    } else if (typeof ing.gramWeight === 'number' && Number.isFinite(ing.gramWeight)) {
      weight = ing.gramWeight;
    } else if (typeof ing.gramsPerUnit === 'number' && Number.isFinite(ing.gramsPerUnit)) {
      weight = ing.gramsPerUnit * (Number(ing.amount) || 0);
    } else if (
      typeof ing.servingSize === 'number' &&
      ing.servingSize > 0 &&
      (ing.unit === 'serving' || ing.unit === 'servings' || ing.unit === 'srv')
    ) {
      weight = ing.servingSize * (Number(ing.amount) || 0);
    } else {
      weight = Number(ing.amount) || 0;
    }

    totalGrams += weight;
    const snap = ing.nutritionSnapshot;
    if (snap) {
      calories += Number(snap.calories) || 0;
      protein += Number(snap.protein) || 0;
      carbs += Number(snap.carbs) || 0;
      fat += Number(snap.fat) || 0;
      fiber += Number(snap.fiber) || 0;

      if (snap.micros && typeof snap.micros === 'object') {
        for (const [k, v] of Object.entries(snap.micros)) {
          if (typeof v === 'number' && Number.isFinite(v)) {
            micros[k] = (micros[k] || 0) + v;
          }
        }
      }
    }
  }

  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  for (const k of Object.keys(micros)) {
    micros[k] = round2(micros[k]!);
  }

  return {
    totalGrams: Math.round(totalGrams),
    macros: {
      calories: Math.round(calories),
      protein: Math.round((protein + Number.EPSILON) * 10) / 10,
      carbs: Math.round((carbs + Number.EPSILON) * 10) / 10,
      fat: Math.round((fat + Number.EPSILON) * 10) / 10,
      fiber: Math.round((fiber + Number.EPSILON) * 10) / 10,
    },
    micros,
  };
}

export interface ComputeRecipeNutritionInput {
  ingredients: CustomRecipeIngredient[];
  basis?: 'per100g' | 'perServing';
  defaultServings?: number;
  gramWeights?: number[];
  cookedWeightGrams?: number | null;
}

export interface ComputedRecipeNutrition {
  totalGrams: number;
  cookedWeightGrams?: number;
  effectiveTotalGrams: number;
  nutrientsPerBasis: MacroNutrients;
  micronutrientsPerBasis: Micronutrients;
  totals: RecipeTotals;
}

export interface SaveCustomRecipeInput extends ComputeRecipeNutritionInput {
  id?: string;
  name: string;
}

/**
 * Pure helper computing raw totalGrams, optional cookedWeightGrams override,
 * and per-basis macronutrients & micronutrients.
 */
export function computeRecipeNutrition(
  input: ComputeRecipeNutritionInput
): ComputedRecipeNutrition {
  const basis = input.basis || 'perServing';
  const defaultServings = Math.max(1, Number(input.defaultServings) || 1);
  const totals = calculateRecipeTotals(input.ingredients || [], input.gramWeights);
  const totalGrams = totals.totalGrams;

  const validCookedWeight =
    typeof input.cookedWeightGrams === 'number' &&
    Number.isFinite(input.cookedWeightGrams) &&
    input.cookedWeightGrams > 0
      ? round2(input.cookedWeightGrams)
      : undefined;
  const effectiveTotalGrams = validCookedWeight ?? totalGrams;

  let nutrientsPerBasis: MacroNutrients;
  const micronutrientsPerBasis: Micronutrients = {};

  const roundMacro = (val: number) => Math.round(val);
  const roundMicro = (val: number) => Math.round((val + Number.EPSILON) * 100) / 100;

  if (basis === 'perServing') {
    nutrientsPerBasis = {
      calories: roundMacro(totals.macros.calories / defaultServings),
      protein: roundMacro(totals.macros.protein / defaultServings),
      carbs: roundMacro(totals.macros.carbs / defaultServings),
      fat: roundMacro(totals.macros.fat / defaultServings),
      fiber: roundMacro(totals.macros.fiber / defaultServings),
    };
    for (const [k, v] of Object.entries(totals.micros)) {
      if (typeof v === 'number') {
        micronutrientsPerBasis[k] = roundMicro(v / defaultServings);
      }
    }
  } else {
    // basis === 'per100g'
    const scale = effectiveTotalGrams > 0 ? 100 / effectiveTotalGrams : 1;
    nutrientsPerBasis = {
      calories: roundMacro(totals.macros.calories * scale),
      protein: roundMacro(totals.macros.protein * scale),
      carbs: roundMacro(totals.macros.carbs * scale),
      fat: roundMacro(totals.macros.fat * scale),
      fiber: roundMacro(totals.macros.fiber * scale),
    };
    for (const [k, v] of Object.entries(totals.micros)) {
      if (typeof v === 'number') {
        micronutrientsPerBasis[k] = roundMicro(v * scale);
      }
    }
  }

  return {
    totalGrams,
    ...(validCookedWeight !== undefined ? { cookedWeightGrams: validCookedWeight } : {}),
    effectiveTotalGrams,
    nutrientsPerBasis,
    micronutrientsPerBasis,
    totals,
  };
}

/**
 * Normalizes and saves a custom recipe to Dexie db.customRecipes.
 */
export async function saveCustomRecipe(input: SaveCustomRecipeInput): Promise<CustomRecipe> {
  const basis = input.basis || 'perServing';
  const defaultServings = Math.max(1, Number(input.defaultServings) || 1);
  const computed = computeRecipeNutrition(input);

  const recipe: CustomRecipe = {
    id: input.id || generateId(),
    name: input.name.trim(),
    ingredients: input.ingredients,
    basis,
    totalGrams: computed.totalGrams,
    ...(computed.cookedWeightGrams !== undefined
      ? { cookedWeightGrams: computed.cookedWeightGrams }
      : {}),
    nutrientsPerBasis: computed.nutrientsPerBasis,
    micronutrientsPerBasis: computed.micronutrientsPerBasis,
    defaultServings,
    createdAt: Date.now(),
  };

  await db.customRecipes.put(recipe);
  return recipe;
}

export interface LogCustomRecipeParams {
  date: string;
  mealSlot?: string;
  servings?: number;
  grams?: number;
  amount?: number;
  unit?: 'serving' | 'servings' | 'g';
  note?: string;
}

/**
 * Logs a custom recipe into db.foodLogs with scaled macronutrients and micronutrients.
 * Supports logging by servings or by grams regardless of recipe.basis, respecting cookedWeightGrams.
 */
export async function logCustomRecipe(
  recipe: CustomRecipe,
  params: LogCustomRecipeParams
): Promise<FoodLogEntry> {
  const effectiveTotalGrams =
    typeof recipe.cookedWeightGrams === 'number' &&
    Number.isFinite(recipe.cookedWeightGrams) &&
    recipe.cookedWeightGrams > 0
      ? recipe.cookedWeightGrams
      : Number(recipe.totalGrams) || 0;
  const defaultServings = Math.max(1, Number(recipe.defaultServings) || 1);
  const perServingGrams =
    effectiveTotalGrams > 0 ? round2(effectiveTotalGrams / defaultServings) : 100;

  const isGramsMode =
    params.unit === 'g' ||
    (typeof params.grams === 'number' && params.grams > 0) ||
    (recipe.basis === 'per100g' &&
      params.unit !== 'serving' &&
      params.unit !== 'servings' &&
      !(typeof params.servings === 'number' && params.servings > 0));

  let amount: number;
  let unit: string;
  let macros: MacroNutrients;
  let micros: Micronutrients;

  if (isGramsMode) {
    const rawGrams =
      typeof params.grams === 'number' && params.grams > 0
        ? params.grams
        : typeof params.amount === 'number' && params.amount > 0
          ? params.amount
          : effectiveTotalGrams > 0
            ? Math.round(effectiveTotalGrams / defaultServings)
            : 100;
    amount = round2(rawGrams);
    unit = 'g';

    if (recipe.basis === 'per100g') {
      ({ macros, micros } = scaleNutrition(
        recipe.nutrientsPerBasis,
        recipe.micronutrientsPerBasis,
        'per100g',
        amount
      ));
    } else {
      const servingsEquivalent = perServingGrams > 0 ? amount / perServingGrams : amount / 100;
      ({ macros, micros } = scaleNutrition(
        recipe.nutrientsPerBasis,
        recipe.micronutrientsPerBasis,
        'perServing',
        servingsEquivalent
      ));
    }
  } else {
    const rawServings =
      typeof params.servings === 'number' && params.servings > 0
        ? params.servings
        : typeof params.amount === 'number' && params.amount > 0
          ? params.amount
          : 1;
    amount = round2(rawServings);
    unit = amount === 1 ? 'serving' : 'servings';

    if (recipe.basis === 'perServing') {
      ({ macros, micros } = scaleNutrition(
        recipe.nutrientsPerBasis,
        recipe.micronutrientsPerBasis,
        'perServing',
        amount
      ));
    } else {
      const gramsEquivalent = amount * perServingGrams;
      ({ macros, micros } = scaleNutrition(
        recipe.nutrientsPerBasis,
        recipe.micronutrientsPerBasis,
        'per100g',
        gramsEquivalent
      ));
    }
  }

  const cleanNote =
    typeof params.note === 'string' && params.note.trim().length > 0
      ? params.note.trim()
      : undefined;

  const entry: FoodLogEntry = {
    id: generateId(),
    date: params.date,
    mealSlot: params.mealSlot ?? 'log',
    foodId: `recipe:${recipe.id}`,
    name: recipe.name,
    source: 'recipe',
    amount,
    unit,
    nutritionSnapshot: {
      ...macros,
      micros,
    },
    note: cleanNote,
    createdAt: Date.now(),
  };

  await db.foodLogs.put(entry);
  return entry;
}

/**
 * Clones all or selected food log entries from sourceDate into targetDate with fresh UUIDs.
 * Returns the count and IDs of inserted entries.
 */
export async function copyLogsFromDate(
  sourceDate: string,
  targetDate: string,
  entryIds?: string[]
): Promise<{ count: number; insertedIds: string[] }> {
  let entries = await db.foodLogs.where('date').equals(sourceDate).toArray();

  if (Array.isArray(entryIds)) {
    const allowedIds = new Set(entryIds);
    entries = entries.filter((entry) => allowedIds.has(entry.id));
  }

  if (entries.length === 0) {
    return { count: 0, insertedIds: [] };
  }

  const ordered = [...entries].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const now = Date.now();
  const clones: FoodLogEntry[] = ordered.map((entry, index) => ({
    id: generateId(),
    date: targetDate,
    mealSlot: entry.mealSlot || 'log',
    foodId: entry.foodId,
    name: entry.name,
    source: entry.source,
    amount: entry.amount,
    unit: entry.unit,
    nutritionSnapshot: JSON.parse(JSON.stringify(entry.nutritionSnapshot)),
    note: entry.note,
    createdAt: now + index,
  }));

  await db.transaction('rw', db.foodLogs, async () => {
    await db.foodLogs.bulkAdd(clones);
  });

  return {
    count: clones.length,
    insertedIds: clones.map((c) => c.id),
  };
}

/**
 * Clones all entries from yesterday into targetDate with fresh UUIDs.
 * Returns the count of entries copied (0 if none found).
 */
export async function copyYesterdayLogs(targetDate: string): Promise<number> {
  const yesterday = offsetIsoDate(targetDate, -1);
  const { count } = await copyLogsFromDate(yesterday, targetDate);
  return count;
}

const FALLBACK_UNIT_GRAMS: Record<string, number> = {
  g: 1,
  ml: 1,
  kg: 1000,
  l: 1000,
  oz: 28.35,
  lb: 453.6,
  tbsp: 15,
  tsp: 5,
  cup: 240,
  cups: 240,
};

function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

function scaleMicrosMap(micros: Micronutrients | undefined, factor: number): Micronutrients {
  const out: Micronutrients = {};
  if (!micros || typeof micros !== 'object') return out;
  for (const [key, val] of Object.entries(micros)) {
    if (typeof val === 'number' && Number.isFinite(val)) {
      out[key] = round2(val * factor);
    }
  }
  return out;
}

function resolveRecipeGramsPerUnit(recipe: CustomRecipe, unitLower: string): number {
  if (unitLower === 'g' || unitLower === 'ml') return 1;
  const effectiveTotal =
    typeof recipe.cookedWeightGrams === 'number' && recipe.cookedWeightGrams > 0
      ? recipe.cookedWeightGrams
      : Number(recipe.totalGrams) || 0;
  const defaultServings = Math.max(1, Number(recipe.defaultServings) || 1);
  const perServing = effectiveTotal > 0 ? round2(effectiveTotal / defaultServings) : 100;
  return perServing > 0 ? perServing : 100;
}

function resolveFoodGramsPerUnit(food: FoodItem, unit: string): number {
  const unitLower = unit.trim().toLowerCase();
  if (unitLower === 'g' || unitLower === 'ml') return 1;

  const options = getServingOptionsForFood(food);
  const canonical = formatPortionUnit(1, unitLower).toLowerCase();
  const matched = options.find((opt) => {
    const optUnit = opt.unit.trim().toLowerCase();
    return (
      opt.id.toLowerCase() === unitLower ||
      optUnit === unitLower ||
      formatPortionUnit(1, optUnit).toLowerCase() === canonical
    );
  });
  if (matched && matched.grams > 0) {
    return matched.grams;
  }

  if (typeof food.servingWeightGrams === 'number' && food.servingWeightGrams > 0) {
    const baseCount = food.servingSize > 0 ? food.servingSize : 1;
    const foodUnit = (food.servingUnit || '').trim().toLowerCase();
    if (!foodUnit || foodUnit === unitLower || formatPortionUnit(1, foodUnit).toLowerCase() === canonical) {
      return round2(food.servingWeightGrams / baseCount);
    }
    return food.servingWeightGrams;
  }

  return FALLBACK_UNIT_GRAMS[unitLower] ?? 100;
}

/**
 * Converts a FoodLogEntry into a CustomRecipeIngredient with normalized base nutrition
 * and accurate gram weight so saving as a recipe produces exact per-serving and per-100g totals.
 */
export function foodLogEntryToRecipeIngredient(
  entry: FoodLogEntry,
  resolved?: { food?: FoodItem | null; recipe?: CustomRecipe | null }
): CustomRecipeIngredient {
  const safeAmount =
    typeof entry.amount === 'number' && Number.isFinite(entry.amount) && entry.amount > 0
      ? entry.amount
      : 1;
  const unit = (entry.unit || 'g').trim() || 'g';
  const unitLower = unit.toLowerCase();
  const isMetric = unitLower === 'g' || unitLower === 'ml';

  const snap = entry.nutritionSnapshot;
  const snapCalories = Number(snap?.calories) || 0;
  const snapProtein = Number(snap?.protein) || 0;
  const snapCarbs = Number(snap?.carbs) || 0;
  const snapFat = Number(snap?.fat) || 0;
  const snapFiber = Number(snap?.fiber) || 0;
  const snapMicros = scaleMicrosMap(snap?.micros, 1);

  let gramsPerUnit: number;
  if (isMetric) {
    gramsPerUnit = 1;
  } else if (resolved?.recipe) {
    gramsPerUnit = resolveRecipeGramsPerUnit(resolved.recipe, unitLower);
  } else if (resolved?.food) {
    gramsPerUnit = resolveFoodGramsPerUnit(resolved.food, unit);
  } else {
    gramsPerUnit = FALLBACK_UNIT_GRAMS[unitLower] ?? 100;
  }

  const gramWeight = round2(safeAmount * gramsPerUnit);
  const baseBasis: NutritionBasis = isMetric
    ? unitLower === 'ml'
      ? 'per100ml'
      : 'per100g'
    : 'perServing';
  const baseFactor = isMetric ? 100 / safeAmount : 1 / safeAmount;

  const baseNutrients: MacroNutrients = {
    calories: round2(snapCalories * baseFactor),
    protein: round2(snapProtein * baseFactor),
    carbs: round2(snapCarbs * baseFactor),
    fat: round2(snapFat * baseFactor),
    fiber: round2(snapFiber * baseFactor),
  };
  const baseMicros = scaleMicrosMap(snapMicros, baseFactor);

  return {
    foodId: entry.foodId || `log:${entry.id}`,
    name: entry.name,
    amount: safeAmount,
    unit,
    gramWeight,
    gramsPerUnit,
    ...(isMetric ? {} : { servingSize: gramsPerUnit }),
    baseBasis,
    baseNutrients,
    baseMicros,
    nutritionSnapshot: {
      calories: snapCalories,
      protein: snapProtein,
      carbs: snapCarbs,
      fat: snapFat,
      fiber: snapFiber,
      micros: snapMicros,
    },
  };
}

/**
 * Resolves cached foods, custom recipes, and offline staples for a list of logged entries
 * and converts them into CustomRecipeIngredient[] suitable for RecipeBuilderModal.initialIngredients.
 */
export async function foodLogEntriesToRecipeIngredients(
  entries: FoodLogEntry[]
): Promise<CustomRecipeIngredient[]> {
  if (!entries || entries.length === 0) return [];

  let staplesById: Map<string, FoodItem> | null = null;
  const getStaplesMap = async (): Promise<Map<string, FoodItem>> => {
    if (staplesById) return staplesById;
    const staples = await loadStaples().catch(() => []);
    staplesById = new Map(staples.map((s) => [s.id, s]));
    return staplesById;
  };

  return Promise.all(
    entries.map(async (entry) => {
      const unitLower = (entry.unit || '').trim().toLowerCase();
      if (!entry.foodId || entry.source === 'quick_add' || unitLower === 'g' || unitLower === 'ml') {
        return foodLogEntryToRecipeIngredient(entry);
      }

      try {
        if (entry.source === 'recipe' || entry.foodId.startsWith('recipe:')) {
          const recipeId = entry.foodId.startsWith('recipe:')
            ? entry.foodId.slice('recipe:'.length)
            : entry.foodId;
          const recipe = await db.customRecipes.get(recipeId);
          if (recipe) {
            return foodLogEntryToRecipeIngredient(entry, { recipe });
          }
        }

        const cachedFood = await db.foodsCache.get(entry.foodId);
        if (cachedFood) {
          return foodLogEntryToRecipeIngredient(entry, { food: cachedFood });
        }

        const staplesMap = await getStaplesMap();
        const stapleFood = staplesMap.get(entry.foodId) ?? null;
        return foodLogEntryToRecipeIngredient(entry, { food: stapleFood });
      } catch {
        return foodLogEntryToRecipeIngredient(entry);
      }
    })
  );
}
