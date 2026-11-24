'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  saveCustomRecipe,
  computeRecipeNutrition,
  foodLogEntryToRecipeIngredient,
  foodLogEntriesToRecipeIngredients,
} from '@/lib/recipes/recipe-builder';

export { foodLogEntryToRecipeIngredient, foodLogEntriesToRecipeIngredients };
import { db } from '@/lib/db/opencalory-db';
import { scaleNutrition } from '@/lib/nutrition/scaling';
import { searchStaples, filterStaples } from '@/lib/foods/staples-search';
import { searchUsdaFoods } from '@/lib/foods/usda-adapter';
import { searchOffFoods } from '@/lib/foods/off-adapter';
import { triggerHaptic } from '@/lib/motion';
import type {
  CustomRecipe,
  CustomRecipeIngredient,
  FoodItem,
  MacroNutrients,
  Micronutrients,
  NutritionBasis,
} from '@/types/nutrition';
import {
  X,
  Plus,
  Trash2,
  ChefHat,
  Search,
  Check,
  Loader2,
  RotateCcw,
} from 'lucide-react';

const RECIPE_DRAFT_KEY = 'macro_recipe_draft_v1';

interface RecipeDraftPayload {
  name: string;
  basis?: 'perServing' | 'per100g';
  servings: number;
  ingredients: ModalIngredientRow[];
  overrideCookedWeight?: boolean;
  cookedWeightInput?: string;
}

function readRecipeDraft(): Partial<RecipeDraftPayload> | null {
  try {
    const raw =
      typeof window !== 'undefined'
        ? window.localStorage.getItem(RECIPE_DRAFT_KEY)
        : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RecipeDraftPayload>;
    if (
      parsed &&
      (typeof parsed.name === 'string' ||
        (Array.isArray(parsed.ingredients) && parsed.ingredients.length > 0))
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export interface ModalIngredientRow extends CustomRecipeIngredient {
  amountStr?: string;
  baseNutrients: MacroNutrients;
  baseMicros: Micronutrients;
  baseBasis: NutritionBasis;
  servingSize?: number;
  gramsPerUnit: number;
  gramWeight: number;
}

export interface RecipeBuilderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (recipe: CustomRecipe) => void;
  initialRecipe?: CustomRecipe | null;
  initialIngredients?: CustomRecipeIngredient[] | null;
}

function mapIngredientRows(items: CustomRecipeIngredient[]): ModalIngredientRow[] {
  return (items || []).map((ing) => {
    const unitLower = (ing.unit || '').trim().toLowerCase();
    const isGram = unitLower === 'g' || unitLower === 'ml';
    const gramsPerUnit =
      ing.gramsPerUnit ||
      (isGram
        ? 1
        : ing.servingSize ||
          (typeof ing.gramWeight === 'number' && ing.amount > 0
            ? ing.gramWeight / ing.amount
            : 1));
    const gramWeight = ing.gramWeight ?? gramsPerUnit * ing.amount;
    const baseBasis: NutritionBasis =
      ing.baseBasis || (isGram ? (unitLower === 'ml' ? 'per100ml' : 'per100g') : 'perServing');
    const baseFactor =
      baseBasis === 'per100g' || baseBasis === 'per100ml'
        ? ing.amount > 0
          ? 100 / ing.amount
          : 1
        : ing.amount > 0
          ? 1 / ing.amount
          : 1;

    const baseNutrients: MacroNutrients = ing.baseNutrients
      ? { ...ing.baseNutrients }
      : {
          calories: (ing.nutritionSnapshot.calories || 0) * baseFactor,
          protein: (ing.nutritionSnapshot.protein || 0) * baseFactor,
          carbs: (ing.nutritionSnapshot.carbs || 0) * baseFactor,
          fat: (ing.nutritionSnapshot.fat || 0) * baseFactor,
          fiber: (ing.nutritionSnapshot.fiber || 0) * baseFactor,
        };

    const baseMicros: Micronutrients = ing.baseMicros ? { ...ing.baseMicros } : {};
    if (!ing.baseMicros && ing.nutritionSnapshot.micros) {
      for (const [k, v] of Object.entries(ing.nutritionSnapshot.micros)) {
        if (typeof v === 'number') {
          baseMicros[k] = v * baseFactor;
        }
      }
    }

    return {
      ...ing,
      nutritionSnapshot: {
        ...ing.nutritionSnapshot,
        micros: { ...(ing.nutritionSnapshot.micros ?? {}) },
      },
      amountStr: String(ing.amount),
      baseNutrients,
      baseMicros,
      baseBasis,
      servingSize: ing.servingSize,
      gramsPerUnit,
      gramWeight,
    };
  });
}

export function RecipeBuilderModal({
  isOpen,
  onClose,
  onSaved,
  initialRecipe,
  initialIngredients,
}: RecipeBuilderModalProps) {
  const [name, setName] = useState('');
  const [basis, setBasis] = useState<'perServing' | 'per100g'>('perServing');
  const [servingsInput, setServingsInput] = useState('1');
  const [ingredients, setIngredients] = useState<ModalIngredientRow[]>([]);
  const [overrideCookedWeight, setOverrideCookedWeight] = useState(false);
  const [cookedWeightInput, setCookedWeightInput] = useState('');
  const [touchedName, setTouchedName] = useState(false);
  const [touchedServings, setTouchedServings] = useState(false);
  const [hasRestoredDraft, setHasRestoredDraft] = useState(false);

  const parsedServingsRaw = parseInt(servingsInput, 10);
  const defaultServings = Math.max(1, Number.isFinite(parsedServingsRaw) ? parsedServingsRaw : 1);

  // Manual ingredient form fields
  const [manualName, setManualName] = useState('');
  const [manualGrams, setManualGrams] = useState('');
  const [manualCals, setManualCals] = useState('');
  const [manualProtein, setManualProtein] = useState('');
  const [manualCarbs, setManualCarbs] = useState('');
  const [manualFat, setManualFat] = useState('');
  const [manualFiber, setManualFiber] = useState('');

  // Food search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FoodItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Initialize or reset state when modal opens, initialRecipe changes, or initialIngredients changes
  const hasSeedIngredients = Boolean(initialIngredients && initialIngredients.length > 0);
  const seedSignature = useMemo(() => {
    if (!initialIngredients || initialIngredients.length === 0) return null;
    return initialIngredients
      .map(
        (ing, idx) =>
          `${idx}:${ing.foodId}:${ing.name}:${ing.amount}:${ing.unit}:${ing.nutritionSnapshot?.calories ?? 0}`
      )
      .join('|');
  }, [initialIngredients]);

  const [prevModalKey, setPrevModalKey] = useState<{
    isOpen: boolean;
    recipeId: string | null;
    seedSignature: string | null;
  }>({
    isOpen: false,
    recipeId: null,
    seedSignature: null,
  });

  const currentRecipeId = initialRecipe?.id ?? null;
  if (
    isOpen !== prevModalKey.isOpen ||
    currentRecipeId !== prevModalKey.recipeId ||
    (isOpen && !currentRecipeId && seedSignature !== prevModalKey.seedSignature)
  ) {
    setPrevModalKey({ isOpen, recipeId: currentRecipeId, seedSignature });
    if (isOpen) {
      setTouchedName(false);
      setTouchedServings(false);
      if (initialRecipe) {
        const hasCookedOverride =
          typeof initialRecipe.cookedWeightGrams === 'number' &&
          Number.isFinite(initialRecipe.cookedWeightGrams) &&
          initialRecipe.cookedWeightGrams > 0;
        setName(initialRecipe.name || '');
        setBasis(initialRecipe.basis || 'perServing');
        setServingsInput(String(initialRecipe.defaultServings || 1));
        setIngredients(mapIngredientRows(initialRecipe.ingredients || []));
        setOverrideCookedWeight(hasCookedOverride);
        setCookedWeightInput(hasCookedOverride ? String(initialRecipe.cookedWeightGrams) : '');
        setHasRestoredDraft(false);
      } else if (initialIngredients && initialIngredients.length > 0) {
        setName('');
        setBasis('perServing');
        setServingsInput('1');
        setIngredients(mapIngredientRows(initialIngredients));
        setOverrideCookedWeight(false);
        setCookedWeightInput('');
        setHasRestoredDraft(false);
      } else {
        const draft = readRecipeDraft();
        const hasDraftContent = Boolean(
          draft && (draft.name?.trim() || (draft.ingredients && draft.ingredients.length > 0))
        );
        setName(draft?.name ?? '');
        setBasis(draft?.basis === 'per100g' ? 'per100g' : 'perServing');
        setServingsInput(
          draft?.servings && draft.servings >= 1 ? String(draft.servings) : '1'
        );
        setIngredients(Array.isArray(draft?.ingredients) ? draft.ingredients : []);
        setOverrideCookedWeight(Boolean(draft?.overrideCookedWeight));
        setCookedWeightInput(draft?.cookedWeightInput ?? '');
        setHasRestoredDraft(hasDraftContent);
      }
      setManualName('');
      setManualGrams('');
      setManualCals('');
      setManualProtein('');
      setManualCarbs('');
      setManualFat('');
      setManualFiber('');
      setSearchQuery('');
      setSearchResults([]);
    }
  }

  useEffect(() => {
    if (!isOpen || initialRecipe || hasSeedIngredients) return;
    try {
      const hasContent =
        name.trim().length > 0 ||
        ingredients.length > 0 ||
        basis !== 'perServing' ||
        defaultServings !== 1 ||
        overrideCookedWeight;
      if (hasContent) {
        const payload: RecipeDraftPayload = {
          name,
          basis,
          servings: defaultServings,
          ingredients,
          overrideCookedWeight,
          cookedWeightInput,
        };
        window.localStorage.setItem(RECIPE_DRAFT_KEY, JSON.stringify(payload));
      } else {
        window.localStorage.removeItem(RECIPE_DRAFT_KEY);
      }
    } catch {
      // Ignore storage errors
    }
  }, [
    isOpen,
    initialRecipe,
    hasSeedIngredients,
    name,
    basis,
    defaultServings,
    ingredients,
    overrideCookedWeight,
    cookedWeightInput,
  ]);

  const handleClearDraft = () => {
    setName('');
    setBasis('perServing');
    setServingsInput('1');
    setIngredients([]);
    setOverrideCookedWeight(false);
    setCookedWeightInput('');
    setTouchedName(false);
    setTouchedServings(false);
    setHasRestoredDraft(false);
    try {
      window.localStorage.removeItem(RECIPE_DRAFT_KEY);
    } catch {
      // Ignore storage errors
    }
  };

  const handleSearchQueryChange = (val: string) => {
    setSearchQuery(val);
    if (!val.trim()) {
      setSearchResults([]);
      setIsSearching(false);
    } else {
      setIsSearching(true);
    }
  };

  // Accessible Escape key listener
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Live full DB ingredient search: foodsCache + offline staples/PH + debounced USDA/OFF
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) return;
    let cancelled = false;
    const abortController = new AbortController();

    const mergeUniqueFoods = (lists: FoodItem[][], limit = 20): FoodItem[] => {
      const seenIds = new Set<string>();
      const seenNameBrand = new Set<string>();
      const out: FoodItem[] = [];
      for (const list of lists) {
        for (const item of list) {
          if (!item || seenIds.has(item.id)) continue;
          const nbKey = `${(item.name || '').trim().toLowerCase()}|${(item.brand || '').trim().toLowerCase()}`;
          if (nbKey !== '|' && seenNameBrand.has(nbKey) && item.source !== 'custom_food' && item.source !== 'custom_barcode') {
            continue;
          }
          seenIds.add(item.id);
          if (nbKey !== '|') seenNameBrand.add(nbKey);
          out.push(item);
          if (out.length >= limit) return out;
        }
      }
      return out;
    };

    let localBase: FoodItem[] = [];

    Promise.all([
      db.foodsCache.toArray().catch(() => [] as FoodItem[]),
      searchStaples(q, 12).catch(() => [] as FoodItem[]),
    ])
      .then(([cachedItems, stapleMatches]) => {
        if (cancelled) return;
        const cachedMatches = filterStaples(cachedItems, q, 12);
        localBase = mergeUniqueFoods([cachedMatches, stapleMatches], 20);
        setSearchResults(localBase);
        setIsSearching(false);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('Local ingredient search failed:', err);
          setIsSearching(false);
        }
      });

    const onlineTimer = setTimeout(() => {
      if (cancelled) return;
      const onlineMatches: FoodItem[] = [];
      const providers = [
        searchOffFoods(q, { country: 'ph', signal: abortController.signal }).catch(() => [] as FoodItem[]),
        searchUsdaFoods(q, { signal: abortController.signal, includeBranded: true }).catch(() => [] as FoodItem[]),
        searchOffFoods(q, { country: 'world', signal: abortController.signal }).catch(() => [] as FoodItem[]),
      ];

      Promise.all(providers)
        .then((results) => {
          if (cancelled || abortController.signal.aborted) return;
          for (const batch of results) {
            onlineMatches.push(...batch);
          }
          if (onlineMatches.length > 0) {
            setSearchResults(mergeUniqueFoods([localBase, onlineMatches], 25));
          }
        })
        .catch(() => {
          // Ignore online errors when offline
        });
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(onlineTimer);
      abortController.abort();
    };
  }, [searchQuery]);

  const parsedCookedWeight = parseFloat(cookedWeightInput);
  const effectiveCookedWeightGrams =
    overrideCookedWeight && Number.isFinite(parsedCookedWeight) && parsedCookedWeight > 0
      ? parsedCookedWeight
      : undefined;

  const computedNutrition = useMemo(
    () =>
      computeRecipeNutrition({
        ingredients,
        basis,
        defaultServings,
        cookedWeightGrams: effectiveCookedWeightGrams,
      }),
    [ingredients, basis, defaultServings, effectiveCookedWeightGrams]
  );

  const totals = computedNutrition.totals;
  const previewNutrients = computedNutrition.nutrientsPerBasis;

  if (!isOpen) return null;

  const handleAddManualIngredient = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = manualName.trim();
    if (!trimmedName) return;

    const grams = Number(manualGrams) || 100;
    const cals = Number(manualCals) || 0;
    const pro = Number(manualProtein) || 0;
    const carbs = Number(manualCarbs) || 0;
    const fat = Number(manualFat) || 0;
    const fiber = Number(manualFiber) || 0;

    // Normalizing base nutrients per 100g
    const factor = grams > 0 ? 100 / grams : 1;
    const baseNutrients: MacroNutrients = {
      calories: cals * factor,
      protein: pro * factor,
      carbs: carbs * factor,
      fat: fat * factor,
      fiber: fiber * factor,
    };
    const baseMicros: Micronutrients = {};

    const { macros, micros } = scaleNutrition(
      baseNutrients,
      baseMicros,
      'per100g',
      grams
    );

    const newRow: ModalIngredientRow = {
      foodId: `manual:${Date.now()}`,
      name: trimmedName,
      amount: grams,
      amountStr: String(grams),
      unit: 'g',
      baseNutrients,
      baseMicros,
      baseBasis: 'per100g',
      gramsPerUnit: 1,
      gramWeight: grams,
      nutritionSnapshot: {
        ...macros,
        micros,
      },
    };

    setIngredients((prev) => [...prev, newRow]);
    setManualName('');
    setManualGrams('');
    setManualCals('');
    setManualProtein('');
    setManualCarbs('');
    setManualFat('');
    setManualFiber('');
  };

  const handleAddFoodItem = (food: FoodItem) => {
    const isPerServing = food.basis === 'perServing';
    const isPer100ml = food.basis === 'per100ml';
    const unit = isPerServing
      ? food.servingUnit || 'serving'
      : isPer100ml
        ? 'ml'
        : 'g';

    const initialAmount = isPerServing ? 1 : food.servingSize || 100;
    // Calculate realistic gram weight per unit for perServing foods
    const gramsPerUnit = isPerServing
      ? typeof food.servingWeightGrams === 'number' && food.servingWeightGrams > 0
        ? food.servingWeightGrams / (food.servingSize > 0 ? food.servingSize : 1)
        : typeof food.servingSize === 'number' && food.servingSize > 0
          ? food.servingSize
          : 1
      : 1;

    // Direct use of scaleNutrition from @/lib/nutrition/scaling
    const { macros, micros } = scaleNutrition(
      food.nutrientsPerBasis,
      food.micronutrientsPerBasis || {},
      food.basis,
      initialAmount,
      food.servingSize
    );

    const newRow: ModalIngredientRow = {
      foodId: food.id,
      name: food.name,
      amount: initialAmount,
      amountStr: String(initialAmount),
      unit,
      baseNutrients: { ...food.nutrientsPerBasis },
      baseMicros: { ...(food.micronutrientsPerBasis || {}) },
      baseBasis: food.basis,
      servingSize: food.servingSize,
      gramsPerUnit,
      gramWeight: gramsPerUnit * initialAmount,
      nutritionSnapshot: {
        ...macros,
        micros,
      },
    };

    setIngredients((prev) => [...prev, newRow]);
    setSearchQuery('');
    setSearchResults([]);
  };

  const handleUpdateIngredientAmount = (index: number, newAmountStr: string) => {
    setIngredients((prev) => {
      const next = [...prev];
      const target = next[index];
      if (!target) return prev;

      const parsed = parseFloat(newAmountStr);
      const safeAmount = isNaN(parsed) || parsed < 0 ? 0 : parsed;

      // Direct calculation from immutable base profile using scaleNutrition - NO rounding drift!
      const { macros, micros } = scaleNutrition(
        target.baseNutrients,
        target.baseMicros,
        target.baseBasis,
        safeAmount,
        target.servingSize
      );

      const gramWeight = target.gramsPerUnit * safeAmount;

      next[index] = {
        ...target,
        amount: safeAmount,
        amountStr: newAmountStr,
        gramWeight,
        nutritionSnapshot: {
          ...macros,
          micros,
        },
      };
      return next;
    });
  };

  const handleRemoveIngredient = (index: number) => {
    setIngredients((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!name.trim()) return;

    try {
      const gramWeights = ingredients.map(
        (ing) => ing.gramWeight ?? (ing.gramsPerUnit ? ing.gramsPerUnit * ing.amount : ing.amount)
      );
      const saved = await saveCustomRecipe({
        id: initialRecipe?.id,
        name: name.trim(),
        ingredients,
        basis,
        defaultServings: Math.max(1, defaultServings),
        gramWeights,
        cookedWeightGrams: effectiveCookedWeightGrams ?? null,
      });
      if (!initialRecipe && !hasSeedIngredients) {
        try {
          window.localStorage.removeItem(RECIPE_DRAFT_KEY);
        } catch {
          // Ignore storage errors
        }
      }
      triggerHaptic(10);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      console.error('Failed to save recipe:', err);
    }
  };

  const isServingsInvalid =
    touchedServings && (!servingsInput.trim() || !Number.isFinite(parsedServingsRaw) || parsedServingsRaw < 1);

  const modal = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="recipe-builder-title"
      className="modal-viewport-overlay z-50 flex flex-col justify-end sm:items-center sm:justify-center sm:p-4 pt-[max(1rem,env(safe-area-inset-top))] bg-black/70 backdrop-blur-xs animate-backdrop-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-full sm:max-h-[90dvh] surface-elevated-sheet rounded-t-3xl sm:rounded-3xl flex flex-col overflow-hidden animate-sheet-in sm:animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-9 h-1 rounded-full bg-border mx-auto mt-3 mb-1 shrink-0 sm:hidden" aria-hidden="true" />
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5 sm:py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-[var(--macro-calories)]/15 flex items-center justify-center text-[var(--macro-calories)]">
              <ChefHat className="w-4 h-4" aria-hidden="true" />
            </div>
            <div>
              <h2 id="recipe-builder-title" className="text-sm font-bold text-foreground">
                {initialRecipe ? 'Edit Recipe' : 'New Custom Recipe'}
              </h2>
              <p className="text-[11px] text-muted-foreground">
                Composite meal with calculated offline nutrition
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {!initialRecipe && hasRestoredDraft && (
              <button
                type="button"
                onClick={handleClearDraft}
                className="tactile-press inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-full bg-surface-sub border border-border text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="w-3 h-3" aria-hidden="true" />
                <span>Clear draft</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Modal Content Scrollable Area */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5 space-y-4 text-xs">
          {/* Recipe Name & Servings */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2 space-y-1">
              <label htmlFor="recipe-title" className="font-semibold text-foreground">
                Recipe Name
              </label>
              <input
                id="recipe-title"
                type="text"
                autoFocus
                placeholder="Recipe title (e.g. Avocado Toast)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouchedName(true)}
                className="w-full bg-surface-sub rounded-xl px-3 py-2 text-base sm:text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              {touchedName && !name.trim() && (
                <p className="text-[11px] text-[var(--neutral-over)]">
                  Enter a recipe name to enable saving.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <label htmlFor="recipe-servings" className="font-semibold text-foreground">
                Servings
              </label>
              <input
                id="recipe-servings"
                type="number"
                min="1"
                step="1"
                value={servingsInput}
                onChange={(e) => setServingsInput(e.target.value)}
                onBlur={() => setTouchedServings(true)}
                className="w-full bg-surface-sub rounded-xl px-3 py-2 text-base sm:text-xs text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring tabular-nums"
              />
              {isServingsInvalid && (
                <p className="text-[11px] text-[var(--neutral-over)]">
                  Minimum 1 serving (defaults to 1).
                </p>
              )}
            </div>
          </div>

          {/* Basis Toggle */}
          <div className="space-y-1.5">
            <span className="font-semibold text-foreground">Nutrition Basis</span>
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-surface-sub rounded-full">
              <button
                type="button"
                onClick={() => setBasis('perServing')}
                className={`tactile-press flex items-center justify-center py-1.5 px-3 rounded-full text-xs text-center leading-tight ${
                  basis === 'perServing'
                    ? 'bg-foreground text-background font-semibold shadow-xs'
                    : 'text-muted-foreground hover:text-foreground font-medium'
                }`}
              >
                Per Serving ({defaultServings} serving{defaultServings > 1 ? 's' : ''})
              </button>
              <button
                type="button"
                onClick={() => setBasis('per100g')}
                className={`tactile-press flex items-center justify-center py-1.5 px-3 rounded-full text-xs text-center leading-tight ${
                  basis === 'per100g'
                    ? 'bg-foreground text-background font-semibold shadow-xs'
                    : 'text-muted-foreground hover:text-foreground font-medium'
                }`}
              >
                Per 100g (
                {effectiveCookedWeightGrams
                  ? `${effectiveCookedWeightGrams}g cooked`
                  : `${totals.totalGrams}g total`}
                )
              </button>
            </div>
          </div>

          {/* Separate Optional Toggle: Override Cooked Weight (meal prep yield) */}
          <div className="bg-surface-sub rounded-2xl p-3.5 space-y-2.5 border border-border/50">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span
                  onClick={() => setOverrideCookedWeight((prev) => !prev)}
                  className="font-semibold text-foreground block cursor-pointer"
                >
                  Override Cooked Weight (meal prep yield)
                </span>
                <span className="text-[11px] text-muted-foreground block">
                  Scale per-100g macros by final cooked batch weight
                </span>
              </div>
              <button
                id="override-cooked-weight-switch"
                type="button"
                role="switch"
                aria-checked={overrideCookedWeight}
                aria-label="Override Cooked Weight (meal prep yield)"
                onClick={() => setOverrideCookedWeight((prev) => !prev)}
                className={`tactile-press relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  overrideCookedWeight ? 'bg-foreground' : 'bg-card border border-border'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full transition-transform ${
                    overrideCookedWeight
                      ? 'translate-x-6 bg-background'
                      : 'translate-x-1 bg-muted-foreground'
                  }`}
                />
              </button>
            </div>

            {overrideCookedWeight && (
              <div className="pt-2 border-t border-border/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <div className="flex items-center gap-2">
                  <label
                    htmlFor="recipe-cooked-weight"
                    className="font-semibold text-foreground shrink-0"
                  >
                    Cooked Weight (g)
                  </label>
                  <input
                    id="recipe-cooked-weight"
                    aria-label="Cooked Weight (g)"
                    type="number"
                    min="1"
                    step="any"
                    placeholder="e.g. 750"
                    value={cookedWeightInput}
                    onChange={(e) => setCookedWeightInput(e.target.value)}
                    className="w-28 bg-card rounded-xl px-2.5 py-1.5 text-base sm:text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring tabular-nums"
                  />
                </div>
                <div className="text-[11px] text-muted-foreground tabular-nums font-medium">
                  {effectiveCookedWeightGrams && totals.totalGrams > 0 ? (
                    <span>
                      {effectiveCookedWeightGrams}g cooked / {totals.totalGrams}g raw Â·{' '}
                      {Math.round((effectiveCookedWeightGrams / totals.totalGrams) * 100)}% yield
                    </span>
                  ) : (
                    <span>Raw batch weight: {totals.totalGrams}g</span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Live Nutrition Preview Pill */}
          <div className="bg-surface-sub rounded-2xl p-3.5 flex items-center justify-between">
            <div>
              <span className="text-[11px] text-muted-foreground font-medium">
                Preview ({basis === 'perServing' ? '1 serving' : '100g'})
              </span>
              <div className="text-base font-bold text-[var(--macro-calories)] tabular-nums mt-0.5">
                {previewNutrients.calories}{' '}
                <span className="text-xs font-normal text-muted-foreground">kcal</span>
              </div>
            </div>
            <div className="flex gap-3 text-right text-xs tabular-nums">
              <div>
                <div className="text-[var(--macro-protein)] font-semibold">
                  {previewNutrients.protein}g
                </div>
                <div className="text-[10px] text-muted-foreground">Pro</div>
              </div>
              <div>
                <div className="text-[var(--macro-carbs)] font-semibold">
                  {previewNutrients.carbs}g
                </div>
                <div className="text-[10px] text-muted-foreground">Carb</div>
              </div>
              <div>
                <div className="text-[var(--macro-fat)] font-semibold">
                  {previewNutrients.fat}g
                </div>
                <div className="text-[10px] text-muted-foreground">Fat</div>
              </div>
              <div>
                <div className="text-[var(--macro-fiber)] font-semibold">
                  {previewNutrients.fiber}g
                </div>
                <div className="text-[10px] text-muted-foreground">Fib</div>
              </div>
            </div>
          </div>

          {/* Ingredients Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground">
                Ingredients ({ingredients.length})
              </span>
              <span className="text-muted-foreground tabular-nums text-[11px]">
                {totals.totalGrams}g total weight
              </span>
            </div>

            {ingredients.length > 0 ? (
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {ingredients.map((ing, idx) => (
                  <div
                    key={`${ing.foodId}-${idx}`}
                    className="flex items-center justify-between bg-surface-sub rounded-xl px-3 py-2"
                  >
                    <div className="min-w-0 flex-1 pr-2">
                      <div className="font-medium text-foreground truncate">{ing.name}</div>
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {Math.round(ing.nutritionSnapshot.calories)} kcal Â·{' '}
                        {Math.round(ing.nutritionSnapshot.protein)}P Â·{' '}
                        {Math.round(ing.nutritionSnapshot.carbs)}C Â·{' '}
                        {Math.round(ing.nutritionSnapshot.fat)}F
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={ing.amountStr !== undefined ? ing.amountStr : ing.amount}
                        onChange={(e) => handleUpdateIngredientAmount(idx, e.target.value)}
                        className="w-16 bg-card rounded-lg px-2 py-1 text-center tabular-nums text-base sm:text-xs text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                      <span className="text-muted-foreground text-[11px]">
                        {ing.unit}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveIngredient(idx)}
                        aria-label={`Remove ${ing.name}`}
                        className="touch-target macro-spring active:scale-90 p-1 rounded-full text-muted-foreground hover:text-foreground"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-surface-sub/50 border border-dashed border-border rounded-xl p-3 text-center text-muted-foreground text-[11px]">
                No ingredients added yet. Search foods or enter manual values below.
              </div>
            )}
          </div>

          {/* Search Full Food Database to Add */}
          <div className="space-y-2 pt-2 border-t border-border/60">
            <span className="font-semibold text-foreground">
              Add from Food Database (Custom, Staples, USDA & OFF)
            </span>
            <div className="relative">
              <Search
                className="w-3.5 h-3.5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2"
                aria-hidden="true"
              />
              <input
                type="text"
                placeholder="Search foods to add as ingredient..."
                value={searchQuery}
                onChange={(e) => handleSearchQueryChange(e.target.value)}
                className="w-full bg-surface-sub rounded-xl pl-8 pr-8 py-2 text-base sm:text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              {isSearching && (
                <Loader2
                  className="w-3.5 h-3.5 text-[var(--macro-calories)] animate-spin absolute right-3 top-1/2 -translate-y-1/2"
                  aria-hidden="true"
                />
              )}
            </div>

            {searchResults.length > 0 && (
              <div className="max-h-36 overflow-y-auto space-y-1 bg-surface-sub/90 rounded-xl p-1.5">
                {searchResults.map((food) => (
                  <button
                    key={food.id}
                    type="button"
                    onClick={() => handleAddFoodItem(food)}
                    className="macro-spring active:scale-[0.98] w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-card flex items-center justify-between text-xs"
                  >
                    <div className="min-w-0 pr-2 flex items-center gap-1.5">
                      <span className="truncate text-foreground font-medium">
                        {food.name}
                      </span>
                      {food.brand && (
                        <span className="truncate text-[10px] text-muted-foreground">
                          Â· {food.brand}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                      {food.nutrientsPerBasis.calories} kcal /{' '}
                      {food.basis === 'perServing' ? 'srv' : '100g'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Manual Ingredient Quick Form */}
          <form
            onSubmit={handleAddManualIngredient}
            className="space-y-2 pt-2 border-t border-border/60"
          >
            <span className="font-semibold text-foreground">Or Add Manual Ingredient</span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="text"
                placeholder="Ingredient name (e.g. Olive Oil)"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                className="sm:col-span-2 bg-surface-sub rounded-xl px-2.5 py-2 text-base sm:text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <input
                type="number"
                placeholder="Weight (g)"
                value={manualGrams}
                onChange={(e) => setManualGrams(e.target.value)}
                className="bg-surface-sub rounded-xl px-2.5 py-2 text-base sm:text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring tabular-nums"
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <input
                type="number"
                placeholder="Calories"
                value={manualCals}
                onChange={(e) => setManualCals(e.target.value)}
                className="bg-surface-sub rounded-xl px-2.5 py-2 text-base sm:text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring tabular-nums"
              />
              <input
                type="number"
                placeholder="Protein"
                value={manualProtein}
                onChange={(e) => setManualProtein(e.target.value)}
                className="bg-surface-sub rounded-xl px-2.5 py-2 text-base sm:text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring tabular-nums"
              />
              <input
                type="number"
                placeholder="Carbs"
                value={manualCarbs}
                onChange={(e) => setManualCarbs(e.target.value)}
                className="bg-surface-sub rounded-xl px-2.5 py-2 text-base sm:text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring tabular-nums"
              />
              <input
                type="number"
                placeholder="Fat"
                value={manualFat}
                onChange={(e) => setManualFat(e.target.value)}
                className="bg-surface-sub rounded-xl px-2.5 py-2 text-base sm:text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring tabular-nums"
              />
              <input
                type="number"
                aria-label="Fiber (g)"
                placeholder="Fiber (g)"
                value={manualFiber}
                onChange={(e) => setManualFiber(e.target.value)}
                className="col-span-2 sm:col-span-1 bg-surface-sub rounded-xl px-2.5 py-2 text-base sm:text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring tabular-nums"
              />
            </div>
            <button
              type="submit"
              className="tactile-press w-full flex items-center justify-center gap-1.5 py-2 rounded-full bg-surface-sub hover:bg-surface-elevated text-foreground font-semibold"
            >
              <Plus className="w-3.5 h-3.5 text-[var(--macro-calories)]" aria-hidden="true" />
              <span>Add Ingredient</span>
            </button>
          </form>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-end gap-2 px-5 pt-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] border-t border-border bg-card/50">
          <button
            type="button"
            onClick={onClose}
            className="tactile-press px-4 py-2 rounded-full text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-surface-sub"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!name.trim()}
            className="tactile-press flex items-center gap-1.5 px-5 py-2 rounded-full bg-foreground hover:opacity-90 disabled:opacity-45 text-background text-xs font-semibold shadow-xs"
          >
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Save Recipe</span>
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
}
