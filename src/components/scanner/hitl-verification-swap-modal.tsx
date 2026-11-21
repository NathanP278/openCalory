"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, Check, Plus, Loader2 } from 'lucide-react';
import { db, generateId } from '@/lib/db/opencalory-db';
import { loadStaples, searchStaples } from '@/lib/foods/staples-search';
import { searchUsdaFoods } from '@/lib/foods/usda-adapter';
import type { FoodItem, MacroNutrients, Micronutrients } from '@/types/nutrition';
import type { AiDraftItem } from '@/stores/logger-store';

export interface HitlVerificationSwapModalProps {
  open: boolean;
  targetItem: AiDraftItem | null; // null when adding a missing ingredient
  onClose: () => void;
  onSwapItem: (
    targetItemId: string,
    verifiedItem: {
      name: string;
      per100g: MacroNutrients;
      microsPer100g?: Micronutrients;
      verifiedSource: string;
      verifiedFoodId: string;
    }
  ) => void;
  onAddCustomItem: (newItem: AiDraftItem) => void;
}

export function HitlVerificationSwapModal({
  open,
  targetItem,
  onClose,
  onSwapItem,
  onAddCustomItem,
}: HitlVerificationSwapModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FoodItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Manual ingredient form state
  const [manualName, setManualName] = useState('');
  const [manualGrams, setManualGrams] = useState('100');
  const [manualCalories, setManualCalories] = useState('100');
  const [manualProtein, setManualProtein] = useState('0');
  const [manualCarbs, setManualCarbs] = useState('0');
  const [manualFat, setManualFat] = useState('0');

  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchRequestIdRef = useRef(0);

  const executeSearch = useCallback(async (searchTerm: string) => {
    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
      searchAbortRef.current = null;
    }

    const requestId = ++searchRequestIdRef.current;
    const q = searchTerm.trim();
    if (!q) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    const controller = new AbortController();
    searchAbortRef.current = controller;
    setIsSearching(true);

    const deduplicate = (lists: FoodItem[][]): FoodItem[] => {
      const seenIds = new Set<string>();
      const combined: FoodItem[] = [];
      for (const list of lists) {
        for (const item of list) {
          if (!seenIds.has(item.id)) {
            seenIds.add(item.id);
            combined.push(item);
          }
        }
      }
      return combined;
    };

    try {
      // Launch online USDA lookup, local IndexedDB cache, and offline staples concurrently
      const usdaPromise = searchUsdaFoods(q, { signal: controller.signal }).catch(
        () => [] as FoodItem[]
      );
      const cachePromise = db.foodsCache.toArray().catch(() => [] as FoodItem[]);
      const staplesPromise = searchStaples(q, 20).catch((err) => {
        console.warn('Staples search error:', err);
        return [] as FoodItem[];
      });

      const qLower = q.toLowerCase();
      let localMatches: FoodItem[] = [];
      let stapleMatches: FoodItem[] = [];

      const cached = await cachePromise;
      if (controller.signal.aborted || requestId !== searchRequestIdRef.current) {
        return;
      }

      localMatches = cached.filter(
        (item) =>
          item.name.toLowerCase().includes(qLower) ||
          (item.brand && item.brand.toLowerCase().includes(qLower))
      );

      if (localMatches.length > 0) {
        setResults(deduplicate([localMatches]));
      }

      stapleMatches = await staplesPromise;
      if (controller.signal.aborted || requestId !== searchRequestIdRef.current) {
        return;
      }

      setResults(deduplicate([localMatches, stapleMatches]));

      const usdaMatches = await usdaPromise;
      if (controller.signal.aborted || requestId !== searchRequestIdRef.current) {
        return;
      }

      if (usdaMatches.length > 0) {
        setResults(deduplicate([localMatches, stapleMatches, usdaMatches]));
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error('Error during food verification search:', err);
      }
    } finally {
      if (requestId === searchRequestIdRef.current) {
        setIsSearching(false);
      }
    }
  }, []);

  const [prevModalKey, setPrevModalKey] = useState<{ open: boolean; targetId: string | null }>({
    open: false,
    targetId: targetItem?.id ?? null,
  });

  if (open !== prevModalKey.open || (targetItem?.id ?? null) !== prevModalKey.targetId) {
    setPrevModalKey({ open, targetId: targetItem?.id ?? null });
    if (open) {
      setQuery(targetItem ? targetItem.name : '');
      setResults([]);
      setManualName('');
      setManualGrams('100');
      setManualCalories('100');
      setManualProtein('0');
      setManualCarbs('0');
      setManualFat('0');
    }
  }

  // Pre-warm offline staples and initialize search with target item name when opening
  useEffect(() => {
    if (!open) return;
    void loadStaples().catch(() => {});
    if (targetItem) {
      const timer = setTimeout(() => {
        executeSearch(targetItem.name);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [open, targetItem, executeSearch]);

  // Escape key handler
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Clean up search debounce timer and in-flight requests on unmount and when modal closes
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
      if (searchAbortRef.current) {
        searchAbortRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    if (!open) {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
      if (searchAbortRef.current) {
        searchAbortRef.current.abort();
      }
    }
  }, [open]);

  const handleQueryChange = (val: string) => {
    setQuery(val);
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }
    searchDebounceRef.current = setTimeout(() => {
      executeSearch(val);
    }, 80);
  };

  const handleSelectFood = (foodItem: FoodItem) => {
    let per100g: MacroNutrients = { ...foodItem.nutrientsPerBasis };
    let microsPer100g: Micronutrients = { ...(foodItem.micronutrientsPerBasis || {}) };

    // Convert perServing items with known gram/ml servingSize to true per100g density
    if (
      foodItem.basis === 'perServing' &&
      foodItem.servingSize > 0 &&
      (foodItem.servingUnit === 'g' || foodItem.servingUnit === 'ml')
    ) {
      const ratio = 100 / foodItem.servingSize;
      per100g = {
        calories: Math.round((foodItem.nutrientsPerBasis.calories * ratio + Number.EPSILON) * 100) / 100,
        protein: Math.round((foodItem.nutrientsPerBasis.protein * ratio + Number.EPSILON) * 100) / 100,
        carbs: Math.round((foodItem.nutrientsPerBasis.carbs * ratio + Number.EPSILON) * 100) / 100,
        fat: Math.round((foodItem.nutrientsPerBasis.fat * ratio + Number.EPSILON) * 100) / 100,
        fiber: Math.round((foodItem.nutrientsPerBasis.fiber * ratio + Number.EPSILON) * 100) / 100,
      };

      const convertedMicros: Micronutrients = {};
      for (const [k, v] of Object.entries(foodItem.micronutrientsPerBasis || {})) {
        if (typeof v === 'number') {
          convertedMicros[k] = Math.round((v * ratio + Number.EPSILON) * 100) / 100;
        }
      }
      microsPer100g = convertedMicros;
    }

    if (targetItem) {
      // SWAP mode: preserves target item's current grams
      onSwapItem(targetItem.id, {
        name: foodItem.name,
        per100g,
        microsPer100g,
        verifiedSource: foodItem.source,
        verifiedFoodId: foodItem.id,
      });
    } else {
      // ADD mode: add as a new item to the meal
      const grams = foodItem.servingSize > 0 ? foodItem.servingSize : 100;
      onAddCustomItem({
        id: generateId(),
        name: foodItem.name,
        grams,
        per100g,
        microsPer100g,
        verifiedSource: foodItem.source,
        verifiedFoodId: foodItem.id,
      });
    }

    onClose();
  };

  const handleAddManualIngredient = (e: React.FormEvent) => {
    e.preventDefault();
    const name = manualName.trim();
    if (!name) return;

    const grams = parseFloat(manualGrams) || 100;
    const calories = parseFloat(manualCalories) || 0;
    const protein = parseFloat(manualProtein) || 0;
    const carbs = parseFloat(manualCarbs) || 0;
    const fat = parseFloat(manualFat) || 0;

    const newItem: AiDraftItem = {
      id: generateId(),
      name,
      grams,
      per100g: {
        calories,
        protein,
        carbs,
        fat,
        fiber: 0,
      },
      verifiedSource: 'quick_add',
    };

    onAddCustomItem(newItem);
    onClose();
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={targetItem ? 'Verify or swap food' : 'Add ingredient'}
      className="fixed inset-0 z-50 flex flex-col justify-end sm:items-center sm:justify-center sm:p-6 bg-black/70 backdrop-blur-xs animate-backdrop-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg mx-auto surface-elevated-sheet rounded-t-3xl sm:rounded-3xl px-4 sm:px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-5 flex flex-col max-h-[88dvh] animate-sheet-in sm:animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-9 h-1 rounded-full bg-border mx-auto mb-3 shrink-0 sm:hidden" aria-hidden="true" />
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {targetItem ? `Verify or Swap "${targetItem.name}"` : 'Add Missing Ingredient'}
            </h2>
            <p className="text-[11px] text-muted-foreground">
              {targetItem
                ? 'Preserves current grams while updating nutrition facts'
                : 'Search verified database or enter manually'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="touch-target macro-spring active:scale-90 p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Modal Scrollable Content */}
        <div className="pt-3 flex-1 overflow-y-auto overscroll-contain space-y-4 pr-0.5 min-h-0">
          {/* Search Input */}
          <div className="relative">
            <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder="Search staples, USDA, or saved foods..."
              className="w-full pl-9 pr-9 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground placeholder:text-muted-foreground/60"
              autoFocus
            />
            {isSearching && (
              <Loader2 className="w-4 h-4 text-[var(--macro-calories)] animate-spin absolute right-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            )}
          </div>

          {/* Search Results List */}
          {results.length > 0 && (
            <div className="space-y-2">
              <span className="text-[11px] font-semibold text-muted-foreground block">
                Search Results:
              </span>
              {results.map((food) => (
                <button
                  key={food.id}
                  type="button"
                  onClick={() => handleSelectFood(food)}
                  className="macro-spring active:scale-[0.985] w-full text-left p-3 rounded-xl bg-surface-sub border border-border hover:border-border-focus hover:bg-accent flex items-center justify-between gap-3 group"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-xs text-foreground truncate">
                        {food.name}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-elevated border border-border text-muted-foreground uppercase font-medium">
                        {food.source}
                      </span>
                    </div>
                    {food.brand && (
                      <p className="text-[11px] text-muted-foreground truncate">{food.brand}</p>
                    )}
                    <p className="text-[11px] text-muted-foreground/80 mt-1 tabular-nums">
                      <span className="text-[var(--macro-calories)] font-semibold">
                        {Math.round(food.nutrientsPerBasis.calories)} kcal
                      </span>{' '}
                      &bull;{' '}
                      <span className="text-[var(--macro-protein)]">{food.nutrientsPerBasis.protein}g P</span>{' '}
                      &bull;{' '}
                      <span className="text-[var(--macro-carbs)]">{food.nutrientsPerBasis.carbs}g C</span>{' '}
                      &bull;{' '}
                      <span className="text-[var(--macro-fat)]">{food.nutrientsPerBasis.fat}g F</span>
                      <span className="text-[10px] ml-1 opacity-70">
                        ({food.basis === 'perServing' ? `${food.servingSize}${food.servingUnit}` : 'per 100g'})
                      </span>
                    </p>
                  </div>
                  <div className="shrink-0">
                    <span className="p-1.5 rounded-full bg-surface-elevated text-muted-foreground group-hover:bg-foreground group-hover:text-background transition-all flex items-center justify-center">
                      <Check className="w-3.5 h-3.5" aria-hidden="true" />
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {query.trim() && !isSearching && results.length === 0 && (
            <div className="py-2 text-center text-xs text-muted-foreground">
              No verified foods found matching &ldquo;{query}&rdquo;.
            </div>
          )}

          {/* Manual Entry Form (shown when adding a missing ingredient) */}
          {!targetItem && (
            <div className="pt-2 border-t border-border">
              <span className="text-[11px] font-semibold text-muted-foreground block mb-2">
                Or enter ingredient manually:
              </span>
              <form onSubmit={handleAddManualIngredient} className="space-y-3">
                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground block mb-1">
                    Ingredient Name
                  </label>
                  <input
                    type="text"
                    placeholder="Ingredient Name"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                    required
                    className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:outline-none focus:border-border-focus text-foreground"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[11px] font-semibold text-muted-foreground block mb-1">
                      Portion (grams)
                    </label>
                    <input
                      type="number"
                      placeholder="Grams"
                      value={manualGrams}
                      onChange={(e) => setManualGrams(e.target.value)}
                      min="1"
                      required
                      className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:outline-none focus:border-border-focus text-foreground tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-muted-foreground block mb-1">
                      Calories per 100g
                    </label>
                    <input
                      type="number"
                      placeholder="Calories per 100g"
                      value={manualCalories}
                      onChange={(e) => setManualCalories(e.target.value)}
                      min="0"
                      required
                      className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:outline-none focus:border-border-focus text-foreground tabular-nums"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground block mb-1">
                      Protein / 100g
                    </label>
                    <input
                      type="number"
                      placeholder="Protein"
                      value={manualProtein}
                      onChange={(e) => setManualProtein(e.target.value)}
                      step="0.1"
                      className="w-full px-2 py-1.5 text-base sm:text-xs rounded-lg bg-surface-sub border border-border text-foreground tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground block mb-1">
                      Carbs / 100g
                    </label>
                    <input
                      type="number"
                      placeholder="Carbs"
                      value={manualCarbs}
                      onChange={(e) => setManualCarbs(e.target.value)}
                      step="0.1"
                      className="w-full px-2 py-1.5 text-base sm:text-xs rounded-lg bg-surface-sub border border-border text-foreground tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground block mb-1">
                      Fat / 100g
                    </label>
                    <input
                      type="number"
                      placeholder="Fat"
                      value={manualFat}
                      onChange={(e) => setManualFat(e.target.value)}
                      step="0.1"
                      className="w-full px-2 py-1.5 text-base sm:text-xs rounded-lg bg-surface-sub border border-border text-foreground tabular-nums"
                    />
                  </div>
                </div>

                <div className="pt-1">
                  <button
                    type="submit"
                    disabled={!manualName.trim()}
                    className="macro-spring active:scale-95 w-full py-2.5 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Add to Meal</span>
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
