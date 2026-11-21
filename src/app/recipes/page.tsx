'use client';

import React, { useState, useMemo } from 'react';
import { motion } from 'motion/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, generateId } from '@/lib/db/opencalory-db';
import { AppShell } from '@/components/shell/app-shell';
import { SettingsHeaderLink } from '@/components/shell/settings-header-link';
import { RecipeBuilderModal } from '@/components/recipes/recipe-builder-modal';
import { RecipePortionPickerModal } from '@/components/recipes/recipe-portion-picker-modal';
import { CustomFoodModal } from '@/components/recipes/custom-food-modal';
import { RecipeCardSkeleton } from '@/components/ui/skeleton';
import { togglePinEntry } from '@/lib/foods/search-history';
import {
  getServingOptionsForFood,
  scaleFoodByOption,
} from '@/lib/nutrition/scaling';
import {
  SPRING_PILL,
  isTestEnvironment,
  triggerHaptic,
} from '@/lib/motion';
import { PageStagger, StaggerItem } from '@/components/motion/motion-primitives';
import { useLoggerStore } from '@/stores/logger-store';
import type { CustomRecipe, FoodItem, FoodLogEntry } from '@/types/nutrition';
import {
  Plus,
  Search,
  Trash2,
  Edit,
  Utensils,
  Check,
  X,
  Pin,
  Barcode,
  Package,
} from 'lucide-react';

type LibraryTab = 'recipes' | 'custom-foods';

export default function RecipesPage() {
  const [activeTab, setActiveTab] = useState<LibraryTab>('recipes');
  const [searchQuery, setSearchQuery] = useState('');
  const [customFoodSearchQuery, setCustomFoodSearchQuery] = useState('');

  // Recipe Builder & Portion Picker state
  const [isRecipeModalOpen, setIsRecipeModalOpen] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<CustomRecipe | null>(null);
  const [portionPickerRecipe, setPortionPickerRecipe] =
    useState<CustomRecipe | null>(null);

  // Custom Food Modal state
  const [isCustomFoodModalOpen, setIsCustomFoodModalOpen] = useState(false);
  const [editingCustomFood, setEditingCustomFood] = useState<FoodItem | null>(
    null
  );

  // Inline logged check feedback
  const [loggedFeedback, setLoggedFeedback] = useState<Record<string, string>>(
    {}
  );
  const feedbackTimersRef = React.useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});

  React.useEffect(() => {
    const timers = feedbackTimersRef.current;
    return () => {
      Object.values(timers).forEach((timer) => clearTimeout(timer));
    };
  }, []);

  const activeDate = useLoggerStore((s) => s.activeDate);
  const activeMealSlot = useLoggerStore((s) => s.activeMealSlot);
  const showUndoToast = useLoggerStore((s) => s.showUndoToast);
  const recipeSeedIngredients = useLoggerStore((s) => s.recipeSeedIngredients);
  const setRecipeSeedIngredients = useLoggerStore(
    (s) => s.setRecipeSeedIngredients
  );

  const hasSeedIngredients = Boolean(
    recipeSeedIngredients && recipeSeedIngredients.length > 0
  );

  // Live query for custom recipes
  const recipes = useLiveQuery(() => db.customRecipes.toArray(), []);

  // Live query for custom_food and custom_barcode items in foodsCache
  const customFoods = useLiveQuery(
    async () => {
      const all = await db.foodsCache.toArray();
      return all
        .filter(
          (f) => f.source === 'custom_food' || f.source === 'custom_barcode'
        )
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    },
    []
  );

  // Live query for pinned foods & recipes
  const pinnedFoods = useLiveQuery(() => db.pinnedFoods.toArray(), []);
  const pinnedIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const p of pinnedFoods ?? []) {
      set.add(p.id);
    }
    return set;
  }, [pinnedFoods]);

  // Filter recipes by live search query
  const filteredRecipes = useMemo(() => {
    if (!recipes) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return recipes;
    return recipes.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.ingredients || []).some((ing) =>
          (ing.name || '').toLowerCase().includes(q)
        )
    );
  }, [recipes, searchQuery]);

  // Filter custom foods & barcodes by live search query
  const filteredCustomFoods = useMemo(() => {
    if (!customFoods) return [];
    const q = customFoodSearchQuery.trim().toLowerCase();
    if (!q) return customFoods;
    return customFoods.filter(
      (item) =>
        (item.name || '').toLowerCase().includes(q) ||
        (item.brand || '').toLowerCase().includes(q) ||
        (item.barcode || '').toLowerCase().includes(q)
    );
  }, [customFoods, customFoodSearchQuery]);

  const markFeedback = (id: string, text = 'Logged!') => {
    setLoggedFeedback((prev) => ({
      ...prev,
      [id]: text,
    }));
    if (feedbackTimersRef.current[id]) {
      clearTimeout(feedbackTimersRef.current[id]);
    }
    feedbackTimersRef.current[id] = setTimeout(() => {
      setLoggedFeedback((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      delete feedbackTimersRef.current[id];
    }, 2500);
  };

  const handleOpenCreateRecipe = () => {
    setEditingRecipe(null);
    setIsRecipeModalOpen(true);
  };

  const handleOpenEditRecipe = (recipe: CustomRecipe) => {
    setEditingRecipe(recipe);
    setIsRecipeModalOpen(true);
  };

  const handleCloseRecipeModal = () => {
    setIsRecipeModalOpen(false);
    setEditingRecipe(null);
    if (hasSeedIngredients) {
      setRecipeSeedIngredients(null);
    }
  };

  const handleDeleteRecipe = async (recipe: CustomRecipe) => {
    const snapshot: CustomRecipe = {
      ...recipe,
      ingredients: recipe.ingredients ? [...recipe.ingredients] : [],
      nutrientsPerBasis: { ...recipe.nutrientsPerBasis },
      micronutrientsPerBasis: { ...(recipe.micronutrientsPerBasis ?? {}) },
    };
    try {
      await db.customRecipes.delete(recipe.id);
      triggerHaptic(12);
      showUndoToast({
        message: `Removed recipe "${recipe.name}"`,
        onUndo: async () => {
          await db.customRecipes.put(snapshot);
        },
      });
    } catch (err) {
      console.error('Failed to delete custom recipe:', err);
    }
  };

  const handleTogglePinRecipe = async (recipe: CustomRecipe) => {
    try {
      await togglePinEntry('recipe', recipe.id);
      triggerHaptic(8);
    } catch (err) {
      console.error('Failed to toggle pin recipe:', err);
    }
  };

  const handleOpenCreateCustomFood = () => {
    setEditingCustomFood(null);
    setIsCustomFoodModalOpen(true);
  };

  const handleOpenEditCustomFood = (food: FoodItem) => {
    setEditingCustomFood(food);
    setIsCustomFoodModalOpen(true);
  };

  const handleTogglePinCustomFood = async (food: FoodItem) => {
    try {
      await togglePinEntry('food', food.id);
      triggerHaptic(8);
    } catch (err) {
      console.error('Failed to toggle pin custom food:', err);
    }
  };

  const handleLogCustomFood = async (food: FoodItem) => {
    try {
      const options = getServingOptionsForFood(food);
      const firstOpt = options[0];
      const logAmount =
        firstOpt?.defaultAmount ??
        (food.basis === 'perServing' ? food.servingSize || 1 : 100);
      const logUnit = firstOpt?.unit || food.servingUnit || 'g';
      const scaled = scaleFoodByOption(food, logAmount, firstOpt);

      const entry: FoodLogEntry = {
        id: generateId(),
        date: activeDate,
        mealSlot: activeMealSlot || 'log',
        foodId: food.id,
        name: food.name,
        source: food.source,
        amount: logAmount,
        unit: logUnit,
        nutritionSnapshot: {
          calories: scaled.macros.calories,
          protein: scaled.macros.protein,
          carbs: scaled.macros.carbs,
          fat: scaled.macros.fat,
          fiber: scaled.macros.fiber,
          micros: scaled.micros,
        },
        createdAt: Date.now(),
      };

      await db.foodLogs.put(entry);
      triggerHaptic(10);
      markFeedback(food.id, 'Logged!');
      showUndoToast({
        message: `Logged "${food.name}"`,
        onUndo: async () => {
          await db.foodLogs.delete(entry.id);
        },
      });
    } catch (err) {
      console.error('Failed to log custom food:', err);
    }
  };

  const handleDeleteCustomFood = async (food: FoodItem) => {
    const snapshot: FoodItem = {
      ...food,
      nutrientsPerBasis: { ...food.nutrientsPerBasis },
      micronutrientsPerBasis: { ...(food.micronutrientsPerBasis ?? {}) },
      ...(food.servingOptions
        ? { servingOptions: food.servingOptions.map((o) => ({ ...o })) }
        : {}),
    };
    try {
      await db.foodsCache.delete(food.id);
      triggerHaptic(12);
      showUndoToast({
        message: `Removed "${food.name}"`,
        onUndo: async () => {
          await db.foodsCache.put(snapshot);
        },
      });
    } catch (err) {
      console.error('Failed to delete custom food:', err);
    }
  };

  return (
    <AppShell>
      <PageStagger className="flex flex-col gap-5 sm:gap-6 px-4 sm:px-6 lg:px-8 pt-3 sm:pt-6 pb-8">
        {/* Compact Header matching Dashboard & Trends */}
        <StaggerItem>
        <header className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground leading-tight truncate">
              Recipes
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              Saved recipes &amp; custom foods
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {activeTab === 'recipes' ? (
              <button
                type="button"
                onClick={handleOpenCreateRecipe}
                className="touch-target tactile-press shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-foreground hover:opacity-90 text-background text-xs font-semibold shadow-xs"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>New Recipe</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleOpenCreateCustomFood}
                className="touch-target tactile-press shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-foreground hover:opacity-90 text-background text-xs font-semibold shadow-xs"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Create Custom Food</span>
              </button>
            )}
            <SettingsHeaderLink />
          </div>
        </header>
        </StaggerItem>

        {/* Unified Toolbar Row: Segmented Tabs + Search (single horizontal row on md+) */}
        <StaggerItem className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div
            role="tablist"
            aria-label="Recipes and Custom Foods tabs"
            className="grid grid-cols-2 gap-1 p-1 bg-card border border-border/50 liquid-input-well rounded-full w-full md:w-auto md:min-w-[320px] shrink-0 overflow-hidden"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'recipes'}
              onClick={() => {
                triggerHaptic(6);
                setActiveTab('recipes');
              }}
              className={`relative tactile-press py-2 px-2.5 sm:px-4 rounded-full text-xs font-semibold transition-colors tabular-nums min-w-0 truncate ${
                activeTab === 'recipes'
                  ? 'text-background'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {activeTab === 'recipes' && (
                <motion.span
                  layoutId={isTestEnvironment() ? undefined : 'recipes-library-tab-pill'}
                  transition={SPRING_PILL}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-full bg-foreground liquid-glass-active-pill"
                />
              )}
              <span className="relative z-10 truncate">
                Recipes{recipes ? ` (${recipes.length})` : ''}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'custom-foods'}
              onClick={() => {
                triggerHaptic(6);
                setActiveTab('custom-foods');
              }}
              className={`relative tactile-press py-2 px-2.5 sm:px-4 rounded-full text-xs font-semibold transition-colors tabular-nums min-w-0 truncate ${
                activeTab === 'custom-foods'
                  ? 'text-background'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {activeTab === 'custom-foods' && (
                <motion.span
                  layoutId={isTestEnvironment() ? undefined : 'recipes-library-tab-pill'}
                  transition={SPRING_PILL}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-full bg-foreground liquid-glass-active-pill"
                />
              )}
              <span className="relative z-10 truncate">
                Custom Foods
                {customFoods ? ` (${customFoods.length})` : ''}
              </span>
            </button>
          </div>

          {/* Active Tab Search Input & Count Summary */}
          <div className="flex items-center gap-2.5 w-full md:w-auto md:flex-1 md:justify-end">
            <div className="relative flex-1 md:max-w-sm min-w-0">
              <Search
                className="w-4 h-4 text-muted-foreground absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              {activeTab === 'recipes' ? (
                <>
                  <input
                    type="text"
                    aria-label="Search saved recipes"
                    placeholder="Search saved recipes..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full h-11 bg-card border border-border/50 rounded-2xl pl-10 pr-10 text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring transition-shadow"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      aria-label="Clear recipe search"
                      className="touch-target tactile-press absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
                    >
                      <X className="w-4 h-4" aria-hidden="true" />
                    </button>
                  )}
                </>
              ) : (
                <>
                  <input
                    type="text"
                    aria-label="Search custom foods and barcodes"
                    placeholder="Search custom foods or barcodes..."
                    value={customFoodSearchQuery}
                    onChange={(e) => setCustomFoodSearchQuery(e.target.value)}
                    className="w-full h-11 bg-card border border-border/50 rounded-2xl pl-10 pr-10 text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring transition-shadow"
                  />
                  {customFoodSearchQuery && (
                    <button
                      type="button"
                      onClick={() => setCustomFoodSearchQuery('')}
                      aria-label="Clear custom food search"
                      className="touch-target tactile-press absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
                    >
                      <X className="w-4 h-4" aria-hidden="true" />
                    </button>
                  )}
                </>
              )}
            </div>
            {activeTab === 'recipes' && recipes && recipes.length > 0 && (
              <div className="hidden sm:flex items-center h-11 px-3.5 rounded-2xl bg-card border border-border/50 text-xs font-medium text-muted-foreground tabular-nums shrink-0">
                {filteredRecipes.length}{' '}
                {filteredRecipes.length === 1 ? 'recipe' : 'recipes'}
              </div>
            )}
          </div>
        </StaggerItem>

        {activeTab === 'recipes' ? (
          <>

            {/* Recipes Bento Grid */}
            {recipes === undefined ? (
              <RecipeCardSkeleton count={3} />
            ) : filteredRecipes.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
                {filteredRecipes.map((recipe, idx) => {
                  const feedback = loggedFeedback[recipe.id];
                  const isPinned = pinnedIdSet.has(`recipe:${recipe.id}`);
                  const hasCookedWeight =
                    typeof recipe.cookedWeightGrams === 'number' &&
                    recipe.cookedWeightGrams > 0;

                  return (
                    <motion.div
                      key={recipe.id}
                      layout={!isTestEnvironment()}
                      initial={isTestEnvironment() ? false : { opacity: 0, y: 20, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{
                        type: 'spring',
                        stiffness: 320,
                        damping: 26,
                        mass: 0.9,
                        delay: isTestEnvironment() ? 0 : Math.min(idx, 6) * 0.055,
                      }}
                      data-testid={`recipe-card-${recipe.id}`}
                      className="bg-card border border-border/50 macro-card-interactive rounded-2xl p-3.5 sm:p-4 flex flex-col justify-between gap-3"
                    >
                      {/* Card Title & Pin/Edit/Delete */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 space-y-1">
                          <h2 className="text-base font-bold text-foreground tracking-tight truncate">
                            {recipe.name}
                          </h2>
                          <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-1.5 tabular-nums">
                            <span>
                              {recipe.ingredients?.length || 0} ingredient
                              {recipe.ingredients?.length === 1 ? '' : 's'}
                            </span>
                            <span>Â·</span>
                            <span>
                              {recipe.basis === 'perServing'
                                ? `${recipe.defaultServings} serving${recipe.defaultServings > 1 ? 's' : ''}`
                                : 'per 100g'}
                            </span>
                            <span>Â·</span>
                            <span>{recipe.totalGrams}g raw</span>
                          </div>
                          {hasCookedWeight && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-surface-sub text-[10px] font-semibold text-foreground tabular-nums">
                              {recipe.cookedWeightGrams}g cooked yield (
                              {recipe.totalGrams > 0
                                ? Math.round(
                                    (recipe.cookedWeightGrams! /
                                      recipe.totalGrams) *
                                      100
                                  )
                                : 100}
                              %)
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            aria-pressed={isPinned}
                            aria-label={
                              isPinned
                                ? `Unpin ${recipe.name}`
                                : `Pin ${recipe.name}`
                            }
                            onClick={() => void handleTogglePinRecipe(recipe)}
                            className={`touch-target macro-spring active:scale-90 p-2 rounded-full transition-colors ${
                              isPinned
                                ? 'text-foreground bg-surface-sub'
                                : 'text-muted-foreground hover:text-foreground hover:bg-surface-sub'
                            }`}
                          >
                            <Pin className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenEditRecipe(recipe)}
                            aria-label={`Edit recipe ${recipe.name}`}
                            className="touch-target macro-spring active:scale-90 p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
                          >
                            <Edit className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <span className="h-4 w-px bg-border/50 mx-0.5" aria-hidden="true" />
                          <button
                            type="button"
                            onClick={() => void handleDeleteRecipe(recipe)}
                            aria-label={`Delete recipe ${recipe.name}`}
                            className="touch-target tactile-press p-2 rounded-full text-muted-foreground/75 hover:text-foreground hover:bg-surface-sub transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </div>

                      {/* Nutrition Summary Pill */}
                      <div className="bg-surface-sub rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-2 min-w-0">
                        <div className="min-w-0">
                          <span className="text-[11px] text-muted-foreground font-medium">
                            Per{' '}
                            {recipe.basis === 'perServing' ? 'Serving' : '100g'}
                          </span>
                          <div className="text-base font-bold text-[var(--macro-calories)] tabular-nums truncate">
                            {recipe.nutrientsPerBasis.calories} kcal
                          </div>
                        </div>
                        <div className="flex gap-2.5 sm:gap-3 text-xs tabular-nums shrink-0">
                          <div className="text-right">
                            <span className="text-[var(--macro-protein)] font-semibold">
                              {recipe.nutrientsPerBasis.protein}g
                            </span>
                            <span className="block text-[10px] text-muted-foreground">
                              Pro
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="text-[var(--macro-carbs)] font-semibold">
                              {recipe.nutrientsPerBasis.carbs}g
                            </span>
                            <span className="block text-[10px] text-muted-foreground">
                              Carb
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="text-[var(--macro-fat)] font-semibold">
                              {recipe.nutrientsPerBasis.fat}g
                            </span>
                            <span className="block text-[10px] text-muted-foreground">
                              Fat
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="text-[var(--macro-fiber)] font-semibold">
                              {recipe.nutrientsPerBasis.fiber ?? 0}g
                            </span>
                            <span className="block text-[10px] text-muted-foreground">
                              Fib
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Compact Footer: Ingredient Preview + Log Action */}
                      <div className="flex items-center justify-between pt-2.5 border-t border-border/50 gap-2.5 min-w-0">
                        <div className="min-w-0 flex-1 text-[11px] text-muted-foreground truncate">
                          {recipe.ingredients && recipe.ingredients.length > 0
                            ? recipe.ingredients
                                .map((ing) => ing.name)
                                .filter(Boolean)
                                .slice(0, 4)
                                .join(' Â· ') +
                              (recipe.ingredients.length > 4
                                ? ` +${recipe.ingredients.length - 4}`
                                : '')
                            : `${recipe.totalGrams}g total`}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {feedback && (
                            <span className="animate-check-pop text-[11px] text-[var(--macro-carbs)] flex items-center gap-1 font-semibold">
                              <Check className="w-3.5 h-3.5" aria-hidden="true" />
                              {feedback}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => setPortionPickerRecipe(recipe)}
                            aria-label={`Log ${recipe.name}`}
                            className="touch-target tactile-press flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-foreground hover:opacity-90 text-background text-xs font-semibold shadow-xs"
                          >
                            <Utensils className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Log</span>
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            ) : (
              /* Empty State */
              <div className="bg-card border border-border/50 rounded-2xl px-6 py-10 sm:p-14 text-center space-y-4 animate-card-enter">
                <svg
                  viewBox="0 0 64 64"
                  className="w-12 h-12 mx-auto text-muted-foreground/75"
                  aria-hidden="true"
                >
                  <rect
                    x="14"
                    y="16"
                    width="36"
                    height="34"
                    rx="8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <line
                    x1="22"
                    y1="27"
                    x2="42"
                    y2="27"
                    stroke="var(--macro-calories)"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <line
                    x1="22"
                    y1="35"
                    x2="38"
                    y2="35"
                    stroke="var(--macro-protein)"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <line
                    x1="22"
                    y1="43"
                    x2="33"
                    y2="43"
                    stroke="var(--macro-carbs)"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <div>
                  <h2 className="text-base sm:text-lg font-bold text-foreground">
                    {searchQuery ? 'No matching recipes' : 'Recipe Book Empty'}
                  </h2>
                  <p className="text-xs sm:text-sm text-muted-foreground max-w-md mx-auto mt-1.5 leading-relaxed">
                    {searchQuery
                      ? 'Try a different recipe name or create a new recipe with this title.'
                      : 'Build custom composite meals with calculated macro targets and serving portions. Stored 100% offline in IndexedDB.'}
                  </p>
                </div>
                <div>
                  <button
                    type="button"
                    onClick={handleOpenCreateRecipe}
                    className="tactile-press inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-foreground hover:opacity-90 text-background text-xs font-semibold shadow-xs"
                  >
                    <Plus className="w-4 h-4" aria-hidden="true" />
                    <span>New Recipe</span>
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          /* Custom Foods & Barcodes Tab */
          <>
            {customFoods === undefined ? (
              <RecipeCardSkeleton count={3} />
            ) : filteredCustomFoods.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
                {filteredCustomFoods.map((item, idx) => {
                  const isPinned = pinnedIdSet.has(`food:${item.id}`);
                  const feedback = loggedFeedback[item.id];
                  const isBarcode =
                    item.source === 'custom_barcode' || Boolean(item.barcode);
                  const basisLabel =
                    item.basis === 'perServing'
                      ? `${item.servingSize || 1} ${item.servingUnit || 'serving'}${
                          item.servingWeightGrams
                            ? ` (${item.servingWeightGrams}g)`
                            : ''
                        }`
                      : item.basis === 'per100ml'
                        ? '100ml'
                        : '100g';

                  return (
                    <div
                      key={item.id}
                      data-testid={`custom-food-card-${item.id}`}
                      style={{ '--stagger-index': idx } as React.CSSProperties}
                      className="stagger-item bg-card border border-border/50 macro-card-interactive rounded-2xl p-4 sm:p-5 flex flex-col justify-between gap-4"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 space-y-1">
                          <h2 className="text-base font-bold text-foreground tracking-tight truncate">
                            {item.name}
                          </h2>
                          {item.brand && (
                            <p className="text-xs text-muted-foreground truncate">
                              {item.brand}
                            </p>
                          )}
                          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-sub text-[10px] font-semibold text-foreground tabular-nums">
                              {isBarcode ? (
                                <>
                                  <Barcode
                                    className="w-3 h-3 text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                  <span>Barcode: {item.barcode}</span>
                                </>
                              ) : (
                                <>
                                  <Package
                                    className="w-3 h-3 text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                  <span>Custom Food</span>
                                </>
                              )}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            aria-pressed={isPinned}
                            aria-label={
                              isPinned
                                ? `Unpin ${item.name}`
                                : `Pin ${item.name}`
                            }
                            onClick={() =>
                              void handleTogglePinCustomFood(item)
                            }
                            className={`touch-target macro-spring active:scale-90 p-2 rounded-full transition-colors ${
                              isPinned
                                ? 'text-foreground bg-surface-sub'
                                : 'text-muted-foreground hover:text-foreground hover:bg-surface-sub'
                            }`}
                          >
                            <Pin className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenEditCustomFood(item)}
                            aria-label={`Edit ${item.name}`}
                            className="touch-target macro-spring active:scale-90 p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
                          >
                            <Edit className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteCustomFood(item)}
                            aria-label={`Delete ${item.name}`}
                            className="touch-target tactile-press p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </div>

                      {/* Nutrition Summary Pill */}
                      <div className="bg-surface-sub rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-2 min-w-0">
                        <div className="min-w-0">
                          <span className="text-[11px] text-muted-foreground font-medium tabular-nums">
                            Per {basisLabel}
                          </span>
                          <div className="text-base font-bold text-[var(--macro-calories)] tabular-nums truncate">
                            {item.nutrientsPerBasis.calories} kcal
                          </div>
                        </div>
                        <div className="flex gap-2.5 sm:gap-3 text-xs tabular-nums shrink-0">
                          <div className="text-right">
                            <span className="text-[var(--macro-protein)] font-semibold">
                              {item.nutrientsPerBasis.protein}g
                            </span>
                            <span className="block text-[10px] text-muted-foreground">
                              Pro
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="text-[var(--macro-carbs)] font-semibold">
                              {item.nutrientsPerBasis.carbs}g
                            </span>
                            <span className="block text-[10px] text-muted-foreground">
                              Carb
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="text-[var(--macro-fat)] font-semibold">
                              {item.nutrientsPerBasis.fat}g
                            </span>
                            <span className="block text-[10px] text-muted-foreground">
                              Fat
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="text-[var(--macro-fiber)] font-semibold">
                              {item.nutrientsPerBasis.fiber ?? 0}g
                            </span>
                            <span className="block text-[10px] text-muted-foreground">
                              Fib
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* 1-Tap Log Action Bar */}
                      <div className="flex items-center justify-end pt-2 border-t border-border/60 gap-2">
                        {feedback && (
                          <span className="animate-check-pop text-[11px] text-[var(--macro-carbs)] flex items-center gap-1 font-semibold">
                            <Check className="w-3.5 h-3.5" aria-hidden="true" />
                            {feedback}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleLogCustomFood(item)}
                          aria-label={`Log ${item.name}`}
                          className="touch-target tactile-press flex items-center gap-1.5 px-4 py-2 rounded-full bg-foreground hover:opacity-90 text-background text-xs font-semibold shadow-xs"
                        >
                          <Utensils className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Log</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="bg-card border border-border/50 rounded-2xl px-6 py-10 sm:p-14 text-center space-y-4 animate-card-enter">
                <div>
                  <h2 className="text-base sm:text-lg font-bold text-foreground">
                    {customFoodSearchQuery
                      ? 'No matching custom foods'
                      : 'No Custom Foods or Barcodes Yet'}
                  </h2>
                  <p className="text-xs sm:text-sm text-muted-foreground max-w-md mx-auto mt-1.5 leading-relaxed">
                    {customFoodSearchQuery
                      ? 'Try a different search term or create a new custom food.'
                      : 'Create standalone custom foods or barcode products with optional AI Nutrition Label OCR.'}
                  </p>
                </div>
                <div>
                  <button
                    type="button"
                    onClick={handleOpenCreateCustomFood}
                    className="tactile-press inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-foreground hover:opacity-90 text-background text-xs font-semibold shadow-xs"
                  >
                    <Plus className="w-4 h-4" aria-hidden="true" />
                    <span>Create Custom Food</span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Recipe Builder Modal (also auto-opens when recipeSeedIngredients is populated) */}
        <RecipeBuilderModal
          isOpen={isRecipeModalOpen || hasSeedIngredients}
          onClose={handleCloseRecipeModal}
          initialRecipe={hasSeedIngredients ? null : editingRecipe}
          initialIngredients={recipeSeedIngredients}
        />

        {/* Recipe Portion Picker Modal */}
        <RecipePortionPickerModal
          recipe={portionPickerRecipe}
          date={activeDate}
          onClose={() => setPortionPickerRecipe(null)}
          onLogged={() => {
            if (portionPickerRecipe) {
              markFeedback(portionPickerRecipe.id, 'Logged!');
            }
          }}
        />

        {/* Custom Food & Barcode Modal */}
        <CustomFoodModal
          open={isCustomFoodModalOpen}
          initialFood={editingCustomFood}
          date={activeDate}
          onClose={() => {
            setIsCustomFoodModalOpen(false);
            setEditingCustomFood(null);
          }}
        />
      </PageStagger>
    </AppShell>
  );
}
