import {
  formatPortionUnit,
  getServingOptionsForFood,
} from '@/lib/nutrition/scaling';
import type {
  CustomRecipe,
  FoodItem,
  FoodServingOption,
} from '@/types/nutrition';

export interface FoodSourceBadge {
  label: 'Verified' | 'Regional' | 'Branded' | 'Custom';
  toneClass: string;
  showGlobe?: boolean;
}

export function getFoodSourceBadge(food: FoodItem): FoodSourceBadge {
  if (food.source === 'custom_food' || food.source === 'custom_barcode') {
    return {
      label: 'Custom',
      toneClass: 'bg-purple-500/15 text-purple-500',
    };
  }
  if (food.accuracyTier === 1 || food.accuracyTier === 2) {
    return {
      label: 'Verified',
      toneClass: 'bg-emerald-500/15 text-emerald-500',
    };
  }
  if (
    food.accuracyTier === 3 ||
    (food.region && food.region !== 'GLOBAL' && food.source !== 'off')
  ) {
    return {
      label: 'Regional',
      toneClass: 'bg-sky-500/15 text-sky-500',
    };
  }
  if (
    food.accuracyTier === 4 ||
    food.source === 'off' ||
    food.source === 'fatsecret' ||
    food.source === 'edamam' ||
    food.source === 'nutritionix' ||
    Boolean(food.brand)
  ) {
    return {
      label: 'Branded',
      toneClass: 'bg-[var(--macro-calories)]/15 text-[var(--macro-calories)]',
      showGlobe:
        food.source === 'off' ||
        food.source === 'fatsecret' ||
        food.source === 'edamam' ||
        food.source === 'nutritionix',
    };
  }
  return {
    label: 'Verified',
    toneClass: 'bg-emerald-500/15 text-emerald-500',
  };
}

export function formatFoodBasisLabel(item: FoodItem): string {
  const firstOpt = item.servingOptions?.find((o) => o.unit !== 'g' && o.unit !== 'ml');
  if (item.basis === 'perServing') {
    const count = item.servingSize > 0 ? item.servingSize : 1;
    const unitLabel = formatPortionUnit(count, item.servingUnit || 'serving');
    const gramNote = item.servingWeightGrams ? ` · ${item.servingWeightGrams}g` : '';
    return `(per ${count} ${unitLabel}${gramNote})`;
  }
  if (item.basis === 'per100ml') {
    return firstOpt ? `(per 100ml · 1 ${firstOpt.unit} = ${firstOpt.grams}ml)` : '(per 100ml)';
  }
  return firstOpt ? `(per 100g · 1 ${firstOpt.unit} = ${firstOpt.grams}g)` : '(per 100g)';
}

export function formatRecipeBasisLabel(recipe: CustomRecipe): string {
  const effectiveGrams =
    typeof recipe.cookedWeightGrams === 'number' && recipe.cookedWeightGrams > 0
      ? recipe.cookedWeightGrams
      : recipe.totalGrams;
  const defaultServings = Math.max(1, recipe.defaultServings || 1);
  const perServingGrams =
    effectiveGrams > 0 ? Math.round(effectiveGrams / defaultServings) : 0;

  if (recipe.basis === 'perServing') {
    return perServingGrams > 0
      ? `(per 1 serving · ${perServingGrams}g)`
      : '(per 1 serving)';
  }
  return perServingGrams > 0
    ? `(per 100g · 1 serving = ${perServingGrams}g)`
    : '(per 100g)';
}

const COUNTABLE_UNIT_PRIORITY = [
  'large',
  'pc',
  'piece',
  'medium',
  'slice',
  'fillet',
  'breast',
  'thigh',
  'patty',
  'pack',
  'can',
  'bottle',
  'bar',
  'scoop',
  'order',
  'serving',
  'bowl',
  'cup',
];

export function resolveDefaultFoodSelection(
  food: FoodItem,
  lastAmount?: number,
  lastUnit?: string
): { option: FoodServingOption | undefined; amount: number; unit: string } {
  const options = getServingOptionsForFood(food);

  if (
    typeof lastAmount === 'number' &&
    Number.isFinite(lastAmount) &&
    lastAmount > 0 &&
    typeof lastUnit === 'string' &&
    lastUnit.trim().length > 0
  ) {
    const normLastUnit = formatPortionUnit(1, lastUnit).toLowerCase();
    const matchedOpt = options.find(
      (o) =>
        o.unit.toLowerCase() === lastUnit.trim().toLowerCase() ||
        formatPortionUnit(1, o.unit).toLowerCase() === normLastUnit
    );
    if (matchedOpt) {
      return {
        option: matchedOpt,
        amount: lastAmount,
        unit: formatPortionUnit(lastAmount, matchedOpt.unit),
      };
    }
  }

  const pickBestHouseholdOption = (): FoodServingOption | undefined => {
    for (const unitKey of COUNTABLE_UNIT_PRIORITY) {
      const found = options.find((o) => o.unit.toLowerCase() === unitKey);
      if (found) return found;
    }
    return options.find(
      (o) => o.unit !== 'g' && o.unit !== 'ml' && o.unit !== 'oz' && o.unit !== 'fl oz'
    );
  };

  const preferred =
    food.servingUnit !== 'g' && food.servingUnit !== 'ml'
      ? options.find((o) => o.unit === food.servingUnit) ??
        pickBestHouseholdOption() ??
        options[0]
      : pickBestHouseholdOption() ?? options[0];

  const initialAmount =
    preferred?.defaultAmount ??
    (preferred?.unit === 'g' || preferred?.unit === 'ml'
      ? food.servingSize || 100
      : food.servingSize || 1);
  const initialUnit = formatPortionUnit(
    initialAmount,
    preferred?.unit || food.servingUnit || 'g'
  );

  return {
    option: preferred,
    amount: initialAmount,
    unit: initialUnit,
  };
}
