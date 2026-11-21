'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Utensils, Check, Scale } from 'lucide-react';
import { db } from '@/lib/db/opencalory-db';
import { logCustomRecipe } from '@/lib/recipes/recipe-builder';
import { scaleNutrition } from '@/lib/nutrition/scaling';
import { useLoggerStore } from '@/stores/logger-store';
import { triggerHaptic } from '@/lib/motion';
import type { CustomRecipe, FoodLogEntry } from '@/types/nutrition';

export interface RecipePortionPickerModalProps {
  recipe: CustomRecipe | null;
  date: string;
  onClose: () => void;
  onLogged?: (entry?: FoodLogEntry) => void;
}

const SERVING_PRESETS = [0.5, 1, 1.5, 2] as const;
const GRAM_PRESETS = [50, 100, 150, 200] as const;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function RecipePortionPickerModal({
  recipe,
  date,
  onClose,
  onLogged,
}: RecipePortionPickerModalProps) {
  const showUndoToast = useLoggerStore((s) => s.showUndoToast);
  const activeMealSlot = useLoggerStore((s) => s.activeMealSlot);

  const effectiveTotalGrams = useMemo(() => {
    if (!recipe) return 0;
    return typeof recipe.cookedWeightGrams === 'number' &&
      Number.isFinite(recipe.cookedWeightGrams) &&
      recipe.cookedWeightGrams > 0
      ? recipe.cookedWeightGrams
      : Number(recipe.totalGrams) || 0;
  }, [recipe]);

  const defaultServings = useMemo(
    () => (recipe ? Math.max(1, Number(recipe.defaultServings) || 1) : 1),
    [recipe]
  );

  const perServingGrams = useMemo(
    () => (effectiveTotalGrams > 0 ? round2(effectiveTotalGrams / defaultServings) : 100),
    [effectiveTotalGrams, defaultServings]
  );

  const roundedPerServingGrams = Math.max(1, Math.round(perServingGrams));

  const [mode, setMode] = useState<'servings' | 'grams'>('servings');
  const [amountInput, setAmountInput] = useState<string>('1');
  const [note, setNote] = useState<string>('');
  const [isLogging, setIsLogging] = useState<boolean>(false);

  const recipeKey = recipe ? `${recipe.id}:${recipe.basis}:${effectiveTotalGrams}:${defaultServings}` : '';
  const [prevRecipeKey, setPrevRecipeKey] = useState<string>('');

  if (recipeKey !== prevRecipeKey) {
    setPrevRecipeKey(recipeKey);
    if (recipe) {
      if (recipe.basis === 'per100g') {
        setMode('grams');
        setAmountInput(String(roundedPerServingGrams));
      } else {
        setMode('servings');
        setAmountInput('1');
      }
      setNote('');
      setIsLogging(false);
    }
  }

  useEffect(() => {
    if (!recipe) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [recipe, onClose]);

  const parsedAmount = parseFloat(amountInput);
  const safeAmount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 0;

  const liveScaled = useMemo(() => {
    if (!recipe) {
      return {
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
        fiber: 0,
      };
    }
    if (mode === 'servings') {
      if (recipe.basis === 'perServing') {
        return scaleNutrition(
          recipe.nutrientsPerBasis,
          recipe.micronutrientsPerBasis,
          'perServing',
          safeAmount
        ).macros;
      }
      return scaleNutrition(
        recipe.nutrientsPerBasis,
        recipe.micronutrientsPerBasis,
        'per100g',
        safeAmount * perServingGrams
      ).macros;
    }

    // mode === 'grams'
    if (recipe.basis === 'per100g') {
      return scaleNutrition(
        recipe.nutrientsPerBasis,
        recipe.micronutrientsPerBasis,
        'per100g',
        safeAmount
      ).macros;
    }
    const equivServings = perServingGrams > 0 ? safeAmount / perServingGrams : safeAmount / 100;
    return scaleNutrition(
      recipe.nutrientsPerBasis,
      recipe.micronutrientsPerBasis,
      'perServing',
      equivServings
    ).macros;
  }, [recipe, mode, safeAmount, perServingGrams]);

  if (!recipe) return null;

  const handleSwitchMode = (nextMode: 'servings' | 'grams') => {
    if (nextMode === mode) return;
    setMode(nextMode);
    if (nextMode === 'servings') {
      setAmountInput('1');
    } else {
      setAmountInput(String(roundedPerServingGrams));
    }
  };

  const handleSelectServingPreset = (mult: number) => {
    setMode('servings');
    setAmountInput(String(mult));
  };

  const handleSelectGramPreset = (grams: number) => {
    setMode('grams');
    setAmountInput(String(grams));
  };

  const handleLog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLogging || safeAmount <= 0) return;
    setIsLogging(true);

    try {
      const entry = await logCustomRecipe(
        recipe,
        mode === 'servings'
          ? {
              date,
              mealSlot: activeMealSlot || 'log',
              servings: safeAmount,
              unit: safeAmount === 1 ? 'serving' : 'servings',
              note,
            }
          : {
              date,
              mealSlot: activeMealSlot || 'log',
              grams: safeAmount,
              unit: 'g',
              note,
            }
      );

      triggerHaptic(10);
      showUndoToast({
        message: `Logged ${recipe.name}`,
        onUndo: async () => {
          await db.foodLogs.delete(entry.id);
        },
      });
      onLogged?.(entry);
      onClose();
    } catch (err) {
      console.error('Failed to log recipe portion:', err);
    } finally {
      setIsLogging(false);
    }
  };

  const modal = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Log ${recipe.name}`}
      className="fixed inset-0 z-50 flex flex-col justify-end sm:items-center sm:justify-center sm:p-4 pt-[max(1rem,env(safe-area-inset-top))] bg-black/70 backdrop-blur-xs animate-backdrop-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md surface-elevated-sheet rounded-t-3xl sm:rounded-3xl flex flex-col overflow-hidden animate-sheet-in sm:animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="w-9 h-1 rounded-full bg-border mx-auto mt-3 mb-1 shrink-0 sm:hidden"
          aria-hidden="true"
        />

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div className="min-w-0 pr-2">
            <h2 className="text-sm font-bold text-foreground truncate">
              Log {recipe.name}
            </h2>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {recipe.basis === 'perServing' ? 'Per serving' : 'Per 100g'} Â·{' '}
              {recipe.cookedWeightGrams && recipe.cookedWeightGrams > 0
                ? `${recipe.cookedWeightGrams}g cooked (${recipe.totalGrams}g raw)`
                : `${recipe.totalGrams}g batch`}{' '}
              Â· {defaultServings} serving{defaultServings > 1 ? 's' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close portion picker"
            className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleLog} className="p-5 space-y-4 text-xs">
          {/* Portion Mode Toggle */}
          <div className="space-y-1.5">
            <span className="font-semibold text-foreground block">Portion Mode</span>
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-surface-sub rounded-full">
              <button
                type="button"
                aria-pressed={mode === 'servings'}
                onClick={() => handleSwitchMode('servings')}
                className={`tactile-press py-1.5 px-3 rounded-full text-xs font-semibold transition-colors ${
                  mode === 'servings'
                    ? 'bg-foreground text-background shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Servings
              </button>
              <button
                type="button"
                aria-pressed={mode === 'grams'}
                onClick={() => handleSwitchMode('grams')}
                className={`tactile-press py-1.5 px-3 rounded-full text-xs font-semibold transition-colors ${
                  mode === 'grams'
                    ? 'bg-foreground text-background shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Grams (g)
              </button>
            </div>
          </div>

          {/* Quick Presets */}
          <div className="space-y-2">
            <div className="space-y-1">
              <span className="text-[11px] text-muted-foreground font-medium block">
                Servings Presets
              </span>
              <div className="flex flex-wrap gap-1.5">
                {SERVING_PRESETS.map((mult) => {
                  const isActive = mode === 'servings' && safeAmount === mult;
                  return (
                    <button
                      key={mult}
                      type="button"
                      onClick={() => handleSelectServingPreset(mult)}
                      className={`tactile-press px-3 py-1.5 rounded-full text-xs font-semibold tabular-nums transition-colors ${
                        isActive
                          ? 'bg-foreground text-background'
                          : 'bg-surface-sub text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {mult}x
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-[11px] text-muted-foreground font-medium block">
                Gram Presets
              </span>
              <div className="flex flex-wrap gap-1.5">
                {GRAM_PRESETS.map((g) => {
                  const isActive = mode === 'grams' && safeAmount === g;
                  return (
                    <button
                      key={g}
                      type="button"
                      onClick={() => handleSelectGramPreset(g)}
                      className={`tactile-press px-2.5 py-1.5 rounded-full text-xs font-semibold tabular-nums transition-colors ${
                        isActive
                          ? 'bg-foreground text-background'
                          : 'bg-surface-sub text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {g}g
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => handleSelectGramPreset(roundedPerServingGrams)}
                  className={`tactile-press px-2.5 py-1.5 rounded-full text-xs font-semibold tabular-nums transition-colors ${
                    mode === 'grams' && safeAmount === roundedPerServingGrams
                      ? 'bg-foreground text-background'
                      : 'bg-surface-sub text-muted-foreground hover:text-foreground'
                  }`}
                >
                  1 serving ({roundedPerServingGrams}g)
                </button>
              </div>
            </div>
          </div>

          {/* Custom Amount Input */}
          <div className="space-y-1">
            <label
              htmlFor="recipe-portion-amount"
              className="font-semibold text-foreground flex items-center justify-between"
            >
              <span>
                Custom {mode === 'servings' ? 'Servings' : 'Weight (g)'}
              </span>
              <span className="text-[11px] font-normal text-muted-foreground tabular-nums">
                1 serving â‰ˆ {roundedPerServingGrams}g
              </span>
            </label>
            <div className="relative">
              <Scale
                className="w-3.5 h-3.5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="recipe-portion-amount"
                aria-label="Portion amount"
                type="number"
                min="0.01"
                step="any"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className="w-full bg-surface-sub rounded-xl pl-8 pr-16 py-2 text-base sm:text-xs text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring tabular-nums"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground font-medium">
                {mode === 'servings'
                  ? safeAmount === 1
                    ? 'serving'
                    : 'servings'
                  : 'g'}
              </span>
            </div>
          </div>

          {/* Live Scaled Macros Readout */}
          <div className="bg-surface-sub rounded-2xl p-3.5 flex items-center justify-between">
            <div>
              <span className="text-[11px] text-muted-foreground font-medium tabular-nums">
                Scaled Portion (
                {mode === 'servings'
                  ? `${safeAmount} ${safeAmount === 1 ? 'serving' : 'servings'}`
                  : `${safeAmount}g`}
                )
              </span>
              <div className="text-base font-bold text-[var(--macro-calories)] tabular-nums mt-0.5">
                {Math.round(liveScaled.calories)}{' '}
                <span className="text-xs font-normal text-muted-foreground">kcal</span>
              </div>
            </div>
            <div className="flex gap-2.5 text-right text-xs tabular-nums">
              <div>
                <div className="text-[var(--macro-protein)] font-semibold">
                  {liveScaled.protein}g
                </div>
                <div className="text-[10px] text-muted-foreground">Pro</div>
              </div>
              <div>
                <div className="text-[var(--macro-carbs)] font-semibold">
                  {liveScaled.carbs}g
                </div>
                <div className="text-[10px] text-muted-foreground">Carb</div>
              </div>
              <div>
                <div className="text-[var(--macro-fat)] font-semibold">
                  {liveScaled.fat}g
                </div>
                <div className="text-[10px] text-muted-foreground">Fat</div>
              </div>
              <div>
                <div className="text-[var(--macro-fiber)] font-semibold">
                  {liveScaled.fiber}g
                </div>
                <div className="text-[10px] text-muted-foreground">Fib</div>
              </div>
            </div>
          </div>

          {/* Optional Note Input */}
          <div className="space-y-1">
            <label htmlFor="recipe-portion-note" className="font-semibold text-foreground">
              Note (optional)
            </label>
            <input
              id="recipe-portion-note"
              aria-label="Note"
              type="text"
              placeholder="Add a note (optional)..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full bg-surface-sub rounded-xl px-3 py-2 text-base sm:text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
            <button
              type="button"
              onClick={onClose}
              className="tactile-press px-4 py-2 rounded-full text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-surface-sub"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLogging || safeAmount <= 0}
              className="tactile-press flex items-center gap-1.5 px-5 py-2 rounded-full bg-foreground hover:opacity-90 disabled:opacity-45 text-background text-xs font-semibold shadow-xs"
            >
              <Utensils className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Log Recipe</span>
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
}
