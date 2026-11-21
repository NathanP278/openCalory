import { db } from '@/lib/db/opencalory-db';
import { formatPortionUnit } from '@/lib/nutrition/scaling';
import type {
  CustomRecipe,
  FoodItem,
  FoodLogEntry,
  FoodServingOption,
  MacroNutrients,
  Micronutrients,
  NutritionBasis,
  PinnedFood,
} from '@/types/nutrition';

export type SearchableEntry =
  | { kind: 'food'; food: FoodItem; lastAmount?: number; lastUnit?: string }
  | { kind: 'recipe'; recipe: CustomRecipe; lastAmount?: number; lastUnit?: string };

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function scaleMicros(micros: Micronutrients | undefined, factor: number): Micronutrients {
  const out: Micronutrients = {};
  if (!micros || typeof micros !== 'object') return out;
  for (const [k, v] of Object.entries(micros)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = round2(v * factor);
    }
  }
  return out;
}

function synthesizeFoodFromLog(log: FoodLogEntry): FoodItem {
  const safeAmount =
    typeof log.amount === 'number' && Number.isFinite(log.amount) && log.amount > 0
      ? log.amount
      : 100;
  const rawUnit = (log.unit || 'g').trim() || 'g';
  const unitLower = rawUnit.toLowerCase();
  const isMetric = unitLower === 'g' || unitLower === 'ml';

  const basis: NutritionBasis = isMetric
    ? unitLower === 'ml'
      ? 'per100ml'
      : 'per100g'
    : 'perServing';
  const servingSize = isMetric ? 100 : 1;
  const servingUnit = isMetric ? unitLower : formatPortionUnit(1, rawUnit);
  const factor = isMetric ? 100 / safeAmount : 1 / safeAmount;

  const snap = log.nutritionSnapshot;
  const nutrientsPerBasis: MacroNutrients = {
    calories: Math.round((Number(snap?.calories) || 0) * factor),
    protein: round2((Number(snap?.protein) || 0) * factor),
    carbs: round2((Number(snap?.carbs) || 0) * factor),
    fat: round2((Number(snap?.fat) || 0) * factor),
    fiber: round2((Number(snap?.fiber) || 0) * factor),
  };

  const validSource: FoodItem['source'] =
    log.source === 'staple' ||
    log.source === 'usda' ||
    log.source === 'off' ||
    log.source === 'custom_barcode' ||
    log.source === 'custom_food'
      ? log.source
      : 'custom_food';

  return {
    id: log.foodId || `log:${log.id}`,
    source: validSource,
    name: log.name,
    basis,
    servingSize,
    servingUnit,
    nutrientsPerBasis,
    micronutrientsPerBasis: scaleMicros(snap?.micros, factor),
    updatedAt: log.createdAt || Date.now(),
  };
}

function resolveLogToEntry(
  log: FoodLogEntry,
  foodsById: Map<string, FoodItem>,
  recipesById: Map<string, CustomRecipe>,
  foodsByName: Map<string, FoodItem>,
  recipesByName: Map<string, CustomRecipe>
): { key: string; entry: SearchableEntry } | null {
  if (!log || !log.name) return null;

  const rawFoodId = (log.foodId || '').trim();
  const isRecipeLog = log.source === 'recipe' || rawFoodId.startsWith('recipe:');

  if (isRecipeLog) {
    const recipeId = rawFoodId.startsWith('recipe:')
      ? rawFoodId.slice('recipe:'.length)
      : rawFoodId;
    const recipe =
      recipesById.get(recipeId) ??
      recipesById.get(rawFoodId) ??
      recipesByName.get(log.name.trim().toLowerCase());
    if (!recipe) return null;
    return {
      key: `recipe:${recipe.id}`,
      entry: {
        kind: 'recipe',
        recipe,
        lastAmount: log.amount,
        lastUnit: log.unit,
      },
    };
  }

  const resolvedFood =
    (rawFoodId ? foodsById.get(rawFoodId) : undefined) ??
    foodsByName.get(log.name.trim().toLowerCase()) ??
    synthesizeFoodFromLog(log);

  return {
    key: `food:${resolvedFood.id}`,
    entry: {
      kind: 'food',
      food: resolvedFood,
      lastAmount: log.amount,
      lastUnit: log.unit,
    },
  };
}

function buildNameLookups(
  foodsById: Map<string, FoodItem>,
  recipesById: Map<string, CustomRecipe>
): {
  foodsByName: Map<string, FoodItem>;
  recipesByName: Map<string, CustomRecipe>;
} {
  const foodsByName = new Map<string, FoodItem>();
  for (const food of foodsById.values()) {
    const key = (food.name || '').trim().toLowerCase();
    if (key && !foodsByName.has(key)) {
      foodsByName.set(key, food);
    }
  }
  const recipesByName = new Map<string, CustomRecipe>();
  for (const recipe of recipesById.values()) {
    const key = (recipe.name || '').trim().toLowerCase();
    if (key && !recipesByName.has(key)) {
      recipesByName.set(key, recipe);
    }
  }
  return { foodsByName, recipesByName };
}

/**
 * Deduplicates food and recipe log history by (kind, id) in reverse-chronological order
 * (createdAt DESC), preserving lastAmount and lastUnit from the most recent log.
 */
export function computeRecentEntries(
  logs: FoodLogEntry[],
  foodsById: Map<string, FoodItem>,
  recipesById: Map<string, CustomRecipe>,
  limit = 25
): SearchableEntry[] {
  if (!Array.isArray(logs) || logs.length === 0 || limit <= 0) {
    return [];
  }

  const { foodsByName, recipesByName } = buildNameLookups(foodsById, recipesById);
  const sorted = [...logs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const seenKeys = new Set<string>();
  const results: SearchableEntry[] = [];

  for (const log of sorted) {
    const resolved = resolveLogToEntry(log, foodsById, recipesById, foodsByName, recipesByName);
    if (!resolved || seenKeys.has(resolved.key)) continue;
    seenKeys.add(resolved.key);
    results.push(resolved.entry);
    if (results.length >= limit) break;
  }

  return results;
}

function parseIsoDateMs(isoDate: string | undefined): number | null {
  if (!isoDate || typeof isoDate !== 'string') return null;
  const parts = isoDate.split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

/**
 * Ranks logged foods and recipes by frequency (count DESC) within the trailing windowDays,
 * tie-broken by most recent createdAt DESC, preserving lastAmount and lastUnit from the latest log.
 */
export function computeFrequentEntries(
  logs: FoodLogEntry[],
  foodsById: Map<string, FoodItem>,
  recipesById: Map<string, CustomRecipe>,
  windowDays = 60,
  limit = 25
): SearchableEntry[] {
  if (!Array.isArray(logs) || logs.length === 0 || limit <= 0) {
    return [];
  }

  const windowMs = Math.max(1, windowDays) * 86_400_000;
  let maxCreatedAt = 0;
  let maxDateMs = 0;
  for (const l of logs) {
    if (typeof l.createdAt === 'number' && l.createdAt > maxCreatedAt) {
      maxCreatedAt = l.createdAt;
    }
    const dMs = parseIsoDateMs(l.date);
    if (dMs !== null && dMs > maxDateMs) {
      maxDateMs = dMs;
    }
  }
  const anchorCreatedAt = Math.max(Date.now(), maxCreatedAt);
  const createdCutoff = anchorCreatedAt - windowMs;
  const dateCutoff = maxDateMs > 0 ? maxDateMs - windowMs : 0;

  const { foodsByName, recipesByName } = buildNameLookups(foodsById, recipesById);
  const sorted = [...logs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  const groups = new Map<
    string,
    { count: number; latestCreatedAt: number; entry: SearchableEntry }
  >();

  for (const log of sorted) {
    const createdAt = log.createdAt ?? 0;
    // Apply timestamp cutoff for real epoch timestamps (post-2001)
    if (createdAt >= 1_000_000_000_000 && createdAt < createdCutoff) {
      continue;
    }
    const dMs = parseIsoDateMs(log.date);
    if (dMs !== null && dateCutoff > 0 && dMs < dateCutoff) {
      continue;
    }

    const resolved = resolveLogToEntry(log, foodsById, recipesById, foodsByName, recipesByName);
    if (!resolved) continue;

    const existing = groups.get(resolved.key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(resolved.key, {
        count: 1,
        latestCreatedAt: createdAt,
        entry: resolved.entry,
      });
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.latestCreatedAt - a.latestCreatedAt;
    })
    .slice(0, limit)
    .map((g) => g.entry);
}

/**
 * Resolves PinnedFood records in reverse-chronological order (pinnedAt DESC) against foodsById and recipesById,
 * attaching lastAmount/lastUnit if previously logged.
 */
export function computePinnedEntries(
  pins: PinnedFood[],
  foodsById: Map<string, FoodItem>,
  recipesById: Map<string, CustomRecipe>,
  logs: FoodLogEntry[] = []
): SearchableEntry[] {
  if (!Array.isArray(pins) || pins.length === 0) return [];

  const lastPortionByKey = new Map<string, { lastAmount: number; lastUnit: string }>();
  if (logs.length > 0) {
    const recents = computeRecentEntries(logs, foodsById, recipesById, 200);
    for (const r of recents) {
      const key = r.kind === 'food' ? `food:${r.food.id}` : `recipe:${r.recipe.id}`;
      if (r.lastAmount !== undefined && r.lastUnit !== undefined) {
        lastPortionByKey.set(key, { lastAmount: r.lastAmount, lastUnit: r.lastUnit });
      }
    }
  }

  const sortedPins = [...pins].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  const results: SearchableEntry[] = [];

  for (const pin of sortedPins) {
    if (pin.kind === 'recipe') {
      const cleanId = pin.refId.startsWith('recipe:')
        ? pin.refId.slice('recipe:'.length)
        : pin.refId;
      const recipe = recipesById.get(cleanId) ?? recipesById.get(pin.refId);
      if (!recipe) continue;
      const last = lastPortionByKey.get(`recipe:${recipe.id}`);
      results.push({
        kind: 'recipe',
        recipe,
        ...(last ?? {}),
      });
    } else {
      const food = foodsById.get(pin.refId);
      if (!food) continue;
      const last = lastPortionByKey.get(`food:${food.id}`);
      results.push({
        kind: 'food',
        food,
        ...(last ?? {}),
      });
    }
  }

  return results;
}

/**
 * Toggles a pinned food or custom recipe in db.pinnedFoods.
 * Returns true if pinned, false if unpinned.
 */
export async function togglePinEntry(
  kind: 'food' | 'recipe',
  refId: string
): Promise<boolean> {
  const cleanRefId =
    kind === 'recipe' && refId.startsWith('recipe:')
      ? refId.slice('recipe:'.length)
      : refId;
  const id = `${kind}:${cleanRefId}`;
  const existing = await db.pinnedFoods.get(id);
  if (existing) {
    await db.pinnedFoods.delete(id);
    return false;
  }
  await db.pinnedFoods.put({
    id,
    kind,
    refId: cleanRefId,
    pinnedAt: Date.now(),
  });
  return true;
}

/**
 * Searches CustomRecipe records by recipe name and ingredient names.
 */
export function searchCustomRecipes(
  recipes: CustomRecipe[],
  query: string,
  limit = 20
): CustomRecipe[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed || !Array.isArray(recipes) || recipes.length === 0) {
    return [];
  }

  const tokens = trimmed
    .replace(/['â€™.,()-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return [];

  const scored: Array<{ recipe: CustomRecipe; score: number }> = [];

  for (const recipe of recipes) {
    const nameLower = (recipe.name || '').toLowerCase();
    const ingText = (recipe.ingredients || [])
      .map((i) => (i.name || '').toLowerCase())
      .join(' ');
    const combined = `${nameLower} ${ingText}`;

    let allMatched = true;
    let score = 0;

    if (nameLower === trimmed) {
      score += 1000;
    } else if (nameLower.startsWith(trimmed)) {
      score += 800;
    } else if (nameLower.includes(trimmed)) {
      score += 600;
    }

    for (const token of tokens) {
      if (nameLower.includes(token)) {
        score += 150;
      } else if (ingText.includes(token)) {
        score += 75;
      } else if (combined.includes(token)) {
        score += 40;
      } else {
        allMatched = false;
        break;
      }
    }

    if (allMatched && score > 0) {
      scored.push({ recipe, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.recipe);
}

/**
 * Converts a CustomRecipe into a virtual FoodItem adapter for portion selection and scaling,
 * respecting cookedWeightGrams when present.
 */
export function recipeToFoodItem(recipe: CustomRecipe): FoodItem {
  const effectiveTotalGrams =
    typeof recipe.cookedWeightGrams === 'number' && recipe.cookedWeightGrams > 0
      ? recipe.cookedWeightGrams
      : Number(recipe.totalGrams) || 0;
  const defaultServings = Math.max(1, Number(recipe.defaultServings) || 1);
  const perServingGrams =
    effectiveTotalGrams > 0 ? round2(effectiveTotalGrams / defaultServings) : 0;

  const servingOptions: FoodServingOption[] = [];
  if (recipe.basis === 'perServing') {
    servingOptions.push({
      id: 'serving',
      label: perServingGrams > 0 ? `serving (${perServingGrams}g)` : 'serving',
      unit: 'serving',
      grams: perServingGrams,
      defaultAmount: 1,
    });
    if (perServingGrams > 0) {
      servingOptions.push({
        id: 'g',
        label: 'g',
        unit: 'g',
        grams: 1,
        defaultAmount: Math.round(perServingGrams),
      });
    }
  } else {
    // per100g
    if (perServingGrams > 0) {
      servingOptions.push({
        id: 'serving',
        label: `serving (${perServingGrams}g)`,
        unit: 'serving',
        grams: perServingGrams,
        defaultAmount: 1,
      });
    }
    servingOptions.push({
      id: 'g',
      label: 'g',
      unit: 'g',
      grams: 1,
      defaultAmount: perServingGrams > 0 ? Math.round(perServingGrams) : 100,
    });
  }

  return {
    id: `recipe:${recipe.id}`,
    source: 'custom_food',
    name: recipe.name,
    basis: recipe.basis,
    servingSize: recipe.basis === 'perServing' ? 1 : 100,
    servingUnit: recipe.basis === 'perServing' ? 'serving' : 'g',
    servingWeightGrams: perServingGrams > 0 ? perServingGrams : undefined,
    servingOptions,
    nutrientsPerBasis: recipe.nutrientsPerBasis,
    micronutrientsPerBasis: recipe.micronutrientsPerBasis || {},
    updatedAt: recipe.createdAt,
  };
}
