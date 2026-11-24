"use client";

import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  EASE_EXPRESSIVE,
  SPRING_SHEET,
  isTestEnvironment,
} from '@/lib/motion';
import {
  Search,
  X,
  ArrowLeft,
  Check,
  Globe,
  Loader2,
  Plus,
  Pin,
  Layers,
  ChefHat,
} from 'lucide-react';
import { db, generateId } from '@/lib/db/opencalory-db';
import {
  formatPortionUnit,
  getServingOptionsForFood,
  scaleFoodByOption,
} from '@/lib/nutrition/scaling';
import { useLoggerStore } from '@/stores/logger-store';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { filterStaples } from '@/lib/foods/staples-search';
import {
  initClientCatalog,
  getCatalogSyncState,
  subscribeCatalogSync,
  searchClientCatalog,
  resolveClientLegacyIds,
  type CatalogSyncState,
} from '@/lib/foods/client-catalog';
import { deduplicateSearchResults } from '@/lib/foods/dedup';
import {
  computeRecentEntries,
  computeFrequentEntries,
  computePinnedEntries,
  togglePinEntry,
  searchCustomRecipes,
  recipeToFoodItem,
  type SearchableEntry,
} from '@/lib/foods/search-history';
import { FoodRowSkeleton } from '@/components/ui/skeleton';
import { runViewTransition, triggerHaptic } from '@/lib/motion';
import type {
  CustomRecipe,
  FoodItem,
  FoodLogEntry,
  FoodServingOption,
  PinnedFood,
} from '@/types/nutrition';

const onlineQueryCache = new Map<string, FoodItem[]>();
const EMPTY_LEGACY_FOODS_MAP = new Map<string, FoodItem>();
const EMPTY_LEGACY_ALIAS_MAP = new Map<string, string>();

/**
 * Clears in-memory online food query caches (intended for tests/reset).
 */
export function clearOnlineSearchCache(): void {
  onlineQueryCache.clear();
}

function getFoodSourceBadge(food: FoodItem): {
  label: 'Verified' | 'Regional' | 'Branded' | 'Custom';
  toneClass: string;
  showGlobe?: boolean;
} {
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

export interface FoodSearchDrawerProps {
  open: boolean;
  date?: string;
  mealSlot?: string;
  onClose: () => void;
}

interface FoodSearchContentProps {
  date?: string;
  mealSlot?: string;
  onClose: () => void;
}

type HistoryTab = 'recents' | 'frequent' | 'pinned';

function formatFoodBasisLabel(item: FoodItem): string {
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

function formatRecipeBasisLabel(recipe: CustomRecipe): string {
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

function resolveDefaultFoodSelection(
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

  const pickBestHouseholdOption = (): FoodServingOption | undefined => {
    for (const unitKey of COUNTABLE_UNIT_PRIORITY) {
      const found = options.find((o) => o.unit.toLowerCase() === unitKey);
      if (found) return found;
    }
    return options.find((o) => o.unit !== 'g' && o.unit !== 'ml' && o.unit !== 'oz' && o.unit !== 'fl oz');
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

function FoodSearchContent({ date, mealSlot, onClose }: FoodSearchContentProps) {
  const storeDate = useLoggerStore((s) => s.activeDate);
  const storeMealSlot = useLoggerStore((s) => s.activeMealSlot);
  const searchInitialQuery = useLoggerStore((s) => s.searchInitialQuery);
  const setSearchInitialQuery = useLoggerStore((s) => s.setSearchInitialQuery);
  const showUndoToast = useLoggerStore((s) => s.showUndoToast);

  const effectiveDate = date ?? storeDate;
  const effectiveMealSlot = mealSlot ?? storeMealSlot;

  const [query, setQuery] = useState(() => searchInitialQuery || '');
  const [activeTab, setActiveTab] = useState<HistoryTab>('recents');
  const [catalogSyncState, setCatalogSyncState] = useState<CatalogSyncState>(() =>
    getCatalogSyncState()
  );
  const [cachedFoods, setCachedFoods] = useState<FoodItem[]>([]);
  const [customRecipes, setCustomRecipes] = useState<CustomRecipe[]>([]);
  const [pinnedFoods, setPinnedFoods] = useState<PinnedFood[]>([]);
  const [historyLogs, setHistoryLogs] = useState<FoodLogEntry[]>([]);
  const [catalogResults, setCatalogResults] = useState<FoodItem[]>([]);
  const [catalogSettledQuery, setCatalogSettledQuery] = useState<string>('');
  const [resolvedLegacyFoodsState, setResolvedLegacyFoodsState] = useState<
    Map<string, FoodItem>
  >(() => new Map());
  const [legacyAliasMapState, setLegacyAliasMapState] = useState<Map<string, string>>(
    () => new Map()
  );
  const [onlineResults, setOnlineResults] = useState<FoodItem[]>(() => {
    const initKey = (searchInitialQuery || '').trim().toLowerCase();
    return initKey ? (onlineQueryCache.get(initKey) ?? []) : [];
  });
  const [isOnlineLoading, setIsOnlineLoading] = useState<boolean>(false);
  const [onlineError, setOnlineError] = useState<string | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(sheetRef, true);

  // Portion selection state
  const [selectedFood, setSelectedFood] = useState<FoodItem | null>(null);
  const [selectedRecipe, setSelectedRecipe] = useState<CustomRecipe | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string>('');
  const [amount, setAmount] = useState<string>('100');
  const [unit, setUnit] = useState<string>('g');
  const [isLogging, setIsLogging] = useState(false);

  // Multi-Add staging tray state
  const [stagedEntries, setStagedEntries] = useState<FoodLogEntry[]>([]);

  const isMountedRef = useRef(true);
  const catalogAbortRef = useRef<AbortController | null>(null);
  const onlineAbortRef = useRef<AbortController | null>(null);
  const resultsContainerRef = useRef<HTMLDivElement | null>(null);
  const savedScrollTopRef = useRef<number>(0);

  // Initialize OPFS SQLite catalog and load Dexie foodsCache, customRecipes, pinnedFoods, and foodLogs on mount
  useEffect(() => {
    isMountedRef.current = true;
    initClientCatalog();
    const unsubscribe = subscribeCatalogSync((nextState) => {
      if (isMountedRef.current) {
        setCatalogSyncState(nextState);
      }
    });

    async function initLocalData() {
      try {
        const [cached, recipes, pins, logs] = await Promise.all([
          db.foodsCache.toArray(),
          db.customRecipes.toArray(),
          db.pinnedFoods.toArray(),
          db.foodLogs.toArray(),
        ]);
        if (isMountedRef.current) {
          setCachedFoods(cached);
          setCustomRecipes(recipes);
          setPinnedFoods(pins);
          setHistoryLogs(logs);
        }
      } catch (err) {
        console.error('Failed to load local cache/history:', err);
      }
    }
    void initLocalData();
    return () => {
      isMountedRef.current = false;
      unsubscribe();
      catalogAbortRef.current?.abort();
      onlineAbortRef.current?.abort();
    };
  }, []);

  // Review Focus #5: Lazily resolve legacy foodIds (staple:*, usda:*, ph:*) in foodLogs & pinnedFoods
  const legacyCandidateIds = React.useMemo(() => {
    const candidateIds = new Set<string>();
    for (const log of historyLogs) {
      const id = (log.foodId || '').trim();
      if (id && log.source !== 'recipe' && !id.startsWith('recipe:')) {
        candidateIds.add(id);
      }
    }
    for (const pin of pinnedFoods) {
      if (pin.kind === 'food' && pin.refId) {
        candidateIds.add(pin.refId.trim());
      }
    }
    return Array.from(candidateIds);
  }, [historyLogs, pinnedFoods]);

  const legacyAliasMap =
    legacyCandidateIds.length === 0 ? EMPTY_LEGACY_ALIAS_MAP : legacyAliasMapState;
  const resolvedLegacyFoods =
    legacyCandidateIds.length === 0 ? EMPTY_LEGACY_FOODS_MAP : resolvedLegacyFoodsState;

  useEffect(() => {
    if (legacyCandidateIds.length === 0) {
      return;
    }

    let cancelled = false;
    void resolveClientLegacyIds(legacyCandidateIds)
      .then((resolved) => {
        if (cancelled || !isMountedRef.current) return;
        const nextAliasMap = new Map<string, string>();
        const nextResolvedFoods = new Map<string, FoodItem>();
        for (const [legacyId, canonicalFood] of resolved.entries()) {
          if (canonicalFood?.id) {
            nextAliasMap.set(legacyId, canonicalFood.id);
            nextResolvedFoods.set(canonicalFood.id, canonicalFood);
          }
        }
        setLegacyAliasMapState(nextAliasMap);
        setResolvedLegacyFoodsState(nextResolvedFoods);
      })
      .catch(() => {
        // Non-fatal: fallback to Dexie foodsCache or synthesized log entries
      });

    return () => {
      cancelled = true;
    };
  }, [legacyCandidateIds, catalogSyncState.status]);

  const refreshHistoryAndPins = async () => {
    try {
      const [pins, logs, cached] = await Promise.all([
        db.pinnedFoods.toArray(),
        db.foodLogs.toArray(),
        db.foodsCache.toArray(),
      ]);
      if (isMountedRef.current) {
        setPinnedFoods(pins);
        setHistoryLogs(logs);
        setCachedFoods(cached);
      }
    } catch {
      // Ignore refresh error
    }
  };

  const runOnlineSearch = React.useCallback(async (trimmedQuery: string, normKey: string) => {
    if (!trimmedQuery || !normKey) return;
    if (onlineAbortRef.current) {
      onlineAbortRef.current.abort();
    }
    const abortController = new AbortController();
    onlineAbortRef.current = abortController;

    setIsOnlineLoading(true);
    setOnlineError(null);

    try {
      const params = new URLSearchParams({
        q: trimmedQuery,
        online: '1',
        limit: '35',
      });
      const res = await fetch(`/api/foods/search?${params.toString()}`, {
        signal: abortController.signal,
      });
      if (abortController.signal.aborted || !isMountedRef.current) return;

      if (!res.ok) {
        setOnlineError('Online search unavailable. Showing local & cached matches.');
        setIsOnlineLoading(false);
        return;
      }

      const data = (await res.json()) as {
        items?: FoodItem[];
        partialError?: string;
      };
      if (abortController.signal.aborted || !isMountedRef.current) return;

      const items = Array.isArray(data?.items) ? data.items : [];
      onlineQueryCache.set(normKey, items);
      setOnlineResults(items);
      if (data?.partialError) {
        setOnlineError(data.partialError);
      }
      setIsOnlineLoading(false);
    } catch {
      if (abortController.signal.aborted || !isMountedRef.current) return;
      setOnlineError('Online search unavailable. Showing local & cached matches.');
      setIsOnlineLoading(false);
    }
  }, []);

  const handleQueryChange = (val: string) => {
    setQuery(val);
    setHighlightedIndex(-1);
    if (!val && searchInitialQuery) {
      setSearchInitialQuery('');
    }
    if (onlineAbortRef.current) {
      onlineAbortRef.current.abort();
    }
    const normKey = val.trim().toLowerCase();
    if (!normKey) {
      setCatalogResults([]);
      setCatalogSettledQuery('');
      setOnlineResults([]);
      setIsOnlineLoading(false);
      setOnlineError(null);
      return;
    }
    const cachedHit = onlineQueryCache.get(normKey);
    if (cachedHit) {
      setOnlineResults(cachedHit);
      setIsOnlineLoading(false);
      setOnlineError(null);
      return;
    }
    setOnlineResults([]);
    setIsOnlineLoading(false);
    setOnlineError(null);
  };

  // Instant local OPFS SQLite FTS5 catalog search (< 25ms)
  useEffect(() => {
    const trimmed = query.trim();
    const normKey = trimmed.toLowerCase();
    if (!trimmed) {
      return;
    }

    if (catalogAbortRef.current) {
      catalogAbortRef.current.abort();
    }
    const abortController = new AbortController();
    catalogAbortRef.current = abortController;

    void searchClientCatalog(trimmed, {
      limit: 35,
      signal: abortController.signal,
    })
      .then((res) => {
        if (abortController.signal.aborted || !isMountedRef.current) return;
        setCatalogResults(Array.isArray(res?.items) ? res.items : []);
        setCatalogSettledQuery(normKey);
      })
      .catch(() => {
        if (abortController.signal.aborted || !isMountedRef.current) return;
        setCatalogResults([]);
        setCatalogSettledQuery(normKey);
      });

    return () => {
      abortController.abort();
    };
  }, [query, catalogSyncState.status]);

  // Deduplicated local results for the active query (custom foods -> catalog -> foodsCache)
  const localMergedFoods = React.useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const matchingCached = filterStaples(cachedFoods, trimmed, 30);
    const customCached = matchingCached.filter(
      (f) => f.source === 'custom_food' || f.source === 'custom_barcode'
    );
    const otherCached = matchingCached.filter(
      (f) => f.source !== 'custom_food' && f.source !== 'custom_barcode'
    );

    return deduplicateSearchResults(
      [...customCached, ...catalogResults, ...otherCached],
      legacyAliasMap
    );
  }, [query, cachedFoods, catalogResults, legacyAliasMap]);

  // Smart live fallback: auto-fire /api/foods/search?online=1 ONLY when local results < 5 and online
  useEffect(() => {
    const trimmed = query.trim();
    const normKey = trimmed.toLowerCase();
    if (!trimmed) return;
    if (catalogSettledQuery !== normKey) return;
    if (onlineQueryCache.has(normKey)) return;
    if (localMergedFoods.length >= 5) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) {
        void runOnlineSearch(trimmed, normKey);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [query, catalogSettledQuery, localMergedFoods.length, runOnlineSearch]);

  const foodsById = React.useMemo(() => {
    const map = new Map<string, FoodItem>();
    for (const item of cachedFoods) {
      map.set(item.id, item);
    }
    for (const [id, item] of resolvedLegacyFoods.entries()) {
      map.set(id, item);
    }
    for (const item of catalogResults) {
      if (!map.has(item.id)) {
        map.set(item.id, item);
      }
    }
    for (const item of onlineResults) {
      if (!map.has(item.id)) {
        map.set(item.id, item);
      }
    }
    return map;
  }, [cachedFoods, resolvedLegacyFoods, catalogResults, onlineResults]);

  const recipesById = React.useMemo(
    () => new Map<string, CustomRecipe>(customRecipes.map((r) => [r.id, r])),
    [customRecipes]
  );

  const pinnedIdSet = React.useMemo(() => {
    const set = new Set<string>();
    for (const p of pinnedFoods) {
      set.add(p.id);
      if (p.kind === 'food') {
        const canonical = legacyAliasMap.get(p.refId);
        if (canonical) {
          set.add(`food:${canonical}`);
        }
      }
    }
    return set;
  }, [pinnedFoods, legacyAliasMap]);

  const recentEntries = React.useMemo(
    () => computeRecentEntries(historyLogs, foodsById, recipesById, 25, legacyAliasMap),
    [historyLogs, foodsById, recipesById, legacyAliasMap]
  );

  const frequentEntries = React.useMemo(
    () => computeFrequentEntries(historyLogs, foodsById, recipesById, 60, 25, legacyAliasMap),
    [historyLogs, foodsById, recipesById, legacyAliasMap]
  );

  const pinnedEntries = React.useMemo(
    () => computePinnedEntries(pinnedFoods, foodsById, recipesById, historyLogs, legacyAliasMap),
    [pinnedFoods, foodsById, recipesById, historyLogs, legacyAliasMap]
  );

  const lastPortionMap = React.useMemo(() => {
    const map = new Map<string, { lastAmount: number; lastUnit: string }>();
    for (const entry of recentEntries) {
      const key =
        entry.kind === 'food' ? `food:${entry.food.id}` : `recipe:${entry.recipe.id}`;
      if (entry.lastAmount !== undefined && entry.lastUnit !== undefined) {
        map.set(key, { lastAmount: entry.lastAmount, lastUnit: entry.lastUnit });
      }
    }
    return map;
  }, [recentEntries]);

  const displayedEntries = React.useMemo((): SearchableEntry[] => {
    const trimmed = query.trim();
    if (!trimmed) {
      if (activeTab === 'frequent') {
        return frequentEntries;
      }
      if (activeTab === 'pinned') {
        return pinnedEntries;
      }
      // Recents tab: show recent entries first, followed by unlogged cached local foods
      const seenFoodIds = new Set<string>();
      for (const r of recentEntries) {
        if (r.kind === 'food') {
          seenFoodIds.add(r.food.id);
        }
      }
      const fallbackLocal = deduplicateSearchResults(cachedFoods, legacyAliasMap)
        .filter((f) => !seenFoodIds.has(f.id) && !seenFoodIds.has(legacyAliasMap.get(f.id) ?? f.id))
        .slice(0, 40)
        .map((food) => ({
          kind: 'food' as const,
          food,
        }));
      return [...recentEntries, ...fallbackLocal].slice(0, 40);
    }

    const matchingRecipes = searchCustomRecipes(customRecipes, trimmed, 12);
    const combinedFoods = deduplicateSearchResults(
      [...localMergedFoods, ...onlineResults],
      legacyAliasMap
    ).slice(0, 48);

    const entries: SearchableEntry[] = [];
    for (const recipe of matchingRecipes) {
      const last = lastPortionMap.get(`recipe:${recipe.id}`);
      entries.push({
        kind: 'recipe',
        recipe,
        ...(last ?? {}),
      });
    }
    for (const food of combinedFoods) {
      const last = lastPortionMap.get(`food:${food.id}`);
      entries.push({
        kind: 'food',
        food,
        ...(last ?? {}),
      });
    }

    return entries;
  }, [
    query,
    activeTab,
    frequentEntries,
    pinnedEntries,
    recentEntries,
    cachedFoods,
    customRecipes,
    localMergedFoods,
    onlineResults,
    legacyAliasMap,
    lastPortionMap,
  ]);

  const servingOptions = React.useMemo(
    () => (selectedFood ? getServingOptionsForFood(selectedFood) : []),
    [selectedFood]
  );

  const activeServingOption = React.useMemo(
    () =>
      servingOptions.find((o) => o.id === selectedOptionId) ?? servingOptions[0],
    [servingOptions, selectedOptionId]
  );

  const handleSelectServingOption = (opt: FoodServingOption) => {
    setSelectedOptionId(opt.id);
    const nextAmount =
      opt.defaultAmount ?? (opt.unit === 'g' || opt.unit === 'ml' ? 100 : 1);
    setAmount(String(nextAmount));
    setUnit(formatPortionUnit(nextAmount, opt.unit));
  };

  const handleSelectEntry = (entry: SearchableEntry) => {
    const targetFood =
      entry.kind === 'recipe' ? recipeToFoodItem(entry.recipe) : entry.food;
    const { option: preferred, amount: initialAmount, unit: initialUnit } =
      resolveDefaultFoodSelection(targetFood, entry.lastAmount, entry.lastUnit);

    if (resultsContainerRef.current) {
      savedScrollTopRef.current = resultsContainerRef.current.scrollTop;
    }
    triggerHaptic(8);
    runViewTransition(
      () => {
        setSelectedRecipe(entry.kind === 'recipe' ? entry.recipe : null);
        setSelectedFood(targetFood);
        setSelectedOptionId(preferred?.id ?? '');
        setAmount(String(initialAmount));
        setUnit(initialUnit);
      },
      { direction: 'forward' }
    );
  };

  const handleBackToResults = () => {
    triggerHaptic(6);
    runViewTransition(
      () => {
        setSelectedFood(null);
        setSelectedRecipe(null);
      },
      { direction: 'backward' }
    );
  };

  useLayoutEffect(() => {
    if (!selectedFood && resultsContainerRef.current) {
      resultsContainerRef.current.scrollTop = savedScrollTopRef.current;
    }
  }, [selectedFood]);

  const handleAmountChange = (val: string) => {
    setAmount(val);
    if (
      activeServingOption &&
      activeServingOption.unit !== 'g' &&
      activeServingOption.unit !== 'ml'
    ) {
      const parsed = parseFloat(val);
      if (Number.isFinite(parsed) && parsed > 0) {
        setUnit(formatPortionUnit(parsed, activeServingOption.unit));
      }
    }
  };

  const parsedAmount = Math.max(0, parseFloat(amount) || 0);

  const scaledNutrition = React.useMemo(() => {
    if (!selectedFood) return null;
    return scaleFoodByOption(selectedFood, parsedAmount, activeServingOption);
  }, [selectedFood, parsedAmount, activeServingOption]);

  const buildCurrentLogEntry = (): FoodLogEntry | null => {
    if (!selectedFood || parsedAmount <= 0) return null;
    const scaled = scaleFoodByOption(
      selectedFood,
      parsedAmount,
      activeServingOption
    );
    const normalizedUnit = formatPortionUnit(
      parsedAmount,
      unit.trim() || activeServingOption?.unit || 'g'
    );

    return {
      id: generateId(),
      date: effectiveDate,
      mealSlot: effectiveMealSlot,
      foodId: selectedRecipe ? `recipe:${selectedRecipe.id}` : selectedFood.id,
      name: selectedRecipe ? selectedRecipe.name : selectedFood.name,
      source: selectedRecipe ? 'recipe' : selectedFood.source,
      amount: parsedAmount,
      unit: normalizedUnit,
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
  };

  const handleLogFood = async () => {
    if (!selectedFood || isLogging) return;
    const entry = buildCurrentLogEntry();
    if (!entry) return;
    setIsLogging(true);

    try {
      await Promise.all([
        db.foodLogs.add(entry),
        !selectedRecipe ? db.foodsCache.put(selectedFood) : Promise.resolve(),
      ]);

      showUndoToast({
        message: `Logged ${entry.name}`,
        onUndo: async () => {
          await db.foodLogs.delete(entry.id);
        },
      });

      triggerHaptic(10);
      if (searchInitialQuery) {
        setSearchInitialQuery('');
      }
      onClose();
    } catch (err) {
      console.error('Failed to log food:', err);
    } finally {
      setIsLogging(false);
    }
  };

  const handleStageAndAddAnother = async () => {
    if (!selectedFood || parsedAmount <= 0) return;
    const entry = buildCurrentLogEntry();
    if (!entry) return;

    if (!selectedRecipe) {
      void db.foodsCache.put(selectedFood);
    }

    setStagedEntries((prev) => [...prev, entry]);
    triggerHaptic(8);
    runViewTransition(
      () => {
        setSelectedFood(null);
        setSelectedRecipe(null);
      },
      { direction: 'backward' }
    );
  };

  const handleQuickLogEntry = async (
    e: React.MouseEvent,
    entry: SearchableEntry
  ) => {
    e.stopPropagation();
    try {
      const targetFood =
        entry.kind === 'recipe' ? recipeToFoodItem(entry.recipe) : entry.food;
      const { option, amount: quickAmount, unit: quickUnit } =
        resolveDefaultFoodSelection(targetFood, entry.lastAmount, entry.lastUnit);
      const scaled = scaleFoodByOption(targetFood, quickAmount, option);

      const logEntry: FoodLogEntry = {
        id: generateId(),
        date: effectiveDate,
        mealSlot: effectiveMealSlot,
        foodId:
          entry.kind === 'recipe' ? `recipe:${entry.recipe.id}` : entry.food.id,
        name: entry.kind === 'recipe' ? entry.recipe.name : entry.food.name,
        source: entry.kind === 'recipe' ? 'recipe' : entry.food.source,
        amount: quickAmount,
        unit: quickUnit,
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

      await Promise.all([
        db.foodLogs.add(logEntry),
        entry.kind === 'food'
          ? db.foodsCache.put(entry.food)
          : Promise.resolve(),
      ]);

      await refreshHistoryAndPins();

      showUndoToast({
        message: `Logged ${logEntry.name} (${quickAmount} ${quickUnit})`,
        onUndo: async () => {
          await db.foodLogs.delete(logEntry.id);
          await refreshHistoryAndPins();
        },
      });

      triggerHaptic(10);
    } catch (err) {
      console.error('Failed to quick log food:', err);
    }
  };

  const handleTogglePin = async (
    e: React.MouseEvent,
    entry: SearchableEntry
  ) => {
    e.stopPropagation();
    const refId = entry.kind === 'recipe' ? entry.recipe.id : entry.food.id;
    const pinKey = `${entry.kind}:${refId}`;
    const wasPinned = pinnedIdSet.has(pinKey);

    if (wasPinned && entry.kind === 'food') {
      const aliasPinIds = pinnedFoods
        .filter(
          (p) =>
            p.kind === 'food' &&
            (p.refId === refId || legacyAliasMap.get(p.refId) === refId)
        )
        .map((p) => p.id);
      if (aliasPinIds.length > 0) {
        await db.pinnedFoods.bulkDelete(aliasPinIds);
      } else {
        await togglePinEntry(entry.kind, refId);
      }
    } else {
      await togglePinEntry(entry.kind, refId);
    }

    triggerHaptic(6);
    const pins = await db.pinnedFoods.toArray();
    setPinnedFoods(pins);
  };

  const handleRemoveStagedItem = (id: string) => {
    setStagedEntries((prev) => prev.filter((item) => item.id !== id));
  };

  const handleLogAllStaged = async () => {
    if (stagedEntries.length === 0 || isLogging) return;
    setIsLogging(true);
    try {
      const now = Date.now();
      const entriesToCommit = stagedEntries.map((item, idx) => ({
        ...item,
        createdAt: now + idx,
      }));
      const stagedIds = entriesToCommit.map((item) => item.id);

      await db.foodLogs.bulkAdd(entriesToCommit);

      showUndoToast({
        message: `Logged ${entriesToCommit.length} ${
          entriesToCommit.length === 1 ? 'item' : 'items'
        }`,
        onUndo: async () => {
          await db.foodLogs.bulkDelete(stagedIds);
        },
      });

      triggerHaptic(12);
      setStagedEntries([]);
      if (searchInitialQuery) {
        setSearchInitialQuery('');
      }
      onClose();
    } catch (err) {
      console.error('Failed to commit staged items:', err);
    } finally {
      setIsLogging(false);
    }
  };

  const totalStagedCalories = React.useMemo(
    () =>
      Math.round(
        stagedEntries.reduce(
          (sum, item) => sum + (Number(item.nutritionSnapshot.calories) || 0),
          0
        )
      ),
    [stagedEntries]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (selectedFood) {
          handleBackToResults();
        } else {
          onClose();
        }
        return;
      }

      if (!selectedFood && displayedEntries.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev < displayedEntries.length - 1 ? prev + 1 : 0
          );
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev > 0 ? prev - 1 : displayedEntries.length - 1
          );
          return;
        }
        if (
          e.key === 'Enter' &&
          highlightedIndex >= 0 &&
          displayedEntries[highlightedIndex]
        ) {
          e.preventDefault();
          handleSelectEntry(displayedEntries[highlightedIndex]);
          return;
        }
      }

      if (
        selectedFood &&
        e.key === 'Enter' &&
        (e.target as HTMLElement | null)?.tagName !== 'BUTTON' &&
        parsedAmount > 0 &&
        !isLogging
      ) {
        e.preventDefault();
        void handleLogFood();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Food Search"
      data-testid="food-search-drawer"
      initial={isTestEnvironment() ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={isTestEnvironment() ? undefined : { opacity: 0 }}
      transition={{ duration: 0.24, ease: EASE_EXPRESSIVE }}
      className="modal-viewport-overlay z-50 flex flex-col justify-end sm:items-center sm:justify-center sm:p-6 bg-black/70 backdrop-blur-md"
      onClick={onClose}
    >
      <motion.div
        ref={sheetRef}
        initial={isTestEnvironment() ? false : { opacity: 0, y: 48, scale: 0.94 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={isTestEnvironment() ? undefined : { opacity: 0, y: 36, scale: 0.95 }}
        transition={SPRING_SHEET}
        className="modal-viewport-sheet w-full max-w-lg lg:max-w-2xl mx-auto surface-elevated-sheet rounded-t-3xl sm:rounded-3xl px-4 sm:px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-5 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="w-9 h-1 rounded-full bg-border mx-auto mb-3 shrink-0 sm:hidden"
          aria-hidden="true"
        />
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div className="flex items-center gap-2.5">
            {selectedFood ? (
              <button
                type="button"
                onClick={handleBackToResults}
                aria-label="Back to search results"
                className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub mr-0.5"
              >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              </button>
            ) : (
              <div className="w-8 h-8 rounded-xl bg-[var(--macro-carbs)]/15 flex items-center justify-center text-[var(--macro-carbs)]">
                <Search className="w-4 h-4" aria-hidden="true" />
              </div>
            )}
            <div>
              <h2
                style={{ viewTransitionName: 'selected-food-header' }}
                className="text-sm font-semibold text-foreground line-clamp-1"
              >
                {selectedFood ? selectedFood.name : 'Search Foods'}
              </h2>
              <p className="text-[11px] text-muted-foreground">
                Logging for {effectiveDate}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close food search"
            className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Portion Selector View */}
        {selectedFood ? (
          (() => {
            const metricUnit =
              activeServingOption?.unit === 'ml' ||
              selectedFood.basis === 'per100ml'
                ? 'ml'
                : 'g';
            const isMetricMode =
              !activeServingOption ||
              activeServingOption.unit === 'g' ||
              activeServingOption.unit === 'ml';
            const countablePresets = [0.5, 1, 1.5, 2, 3];
            const metricPresets = [50, 100, 150, 200, 250];

            return (
              <div
                key={selectedFood.id}
                className="pt-4 flex-1 overflow-y-auto overscroll-contain space-y-4 animate-panel-switch"
              >
                <div className="bg-surface-sub border border-border rounded-2xl p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground">
                      Portion Amount
                    </span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {activeServingOption && !isMetricMode
                        ? `Basis: 1 ${activeServingOption.unit}${
                            activeServingOption.grams > 0
                              ? ` (${activeServingOption.grams}g)`
                              : ''
                          }`
                        : `Basis: ${selectedFood.servingSize || 100} ${
                            selectedFood.servingUnit || 'g'
                          }`}
                    </span>
                  </div>

                  {/* Serving Unit Selector Pills (ONLY when countable options apply) */}
                  {servingOptions.length > 1 && (
                    <div
                      role="group"
                      aria-label="Serving unit options"
                      className="flex flex-wrap items-center gap-1.5"
                    >
                      {servingOptions.map((opt) => {
                        const isActive = activeServingOption?.id === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => handleSelectServingOption(opt)}
                            aria-pressed={isActive}
                            className={`tactile-press px-2.5 py-1 text-[11px] font-semibold rounded-full border ${
                              isActive
                                ? 'bg-foreground text-background border-foreground shadow-xs'
                                : 'bg-card text-muted-foreground border-border hover:text-foreground'
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <input
                        aria-label="Portion amount"
                        type="number"
                        step="any"
                        min="0"
                        value={amount}
                        onChange={(e) => handleAmountChange(e.target.value)}
                        className="w-full px-3 py-2 text-base font-semibold tabular-nums rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                      />
                    </div>
                    <div className="w-24">
                      <input
                        aria-label="Portion unit"
                        type="text"
                        value={unit}
                        onChange={(e) => setUnit(e.target.value)}
                        className="w-full px-3 py-2 text-base sm:text-xs font-medium rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground text-center"
                      />
                    </div>
                  </div>

                  {/* Quick Portion Presets */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {isMetricMode
                        ? metricPresets.map((preset) => (
                            <button
                              key={preset}
                              type="button"
                              onClick={() => {
                                setAmount(String(preset));
                                setUnit(metricUnit);
                              }}
                              className={`tactile-press px-2.5 py-1 text-[11px] font-semibold rounded-full ${
                                amount === String(preset) && unit === metricUnit
                                  ? 'bg-foreground text-background shadow-xs'
                                  : 'bg-card text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              {preset}
                              {metricUnit}
                            </button>
                          ))
                        : countablePresets.map((preset) => {
                            const presetUnit = formatPortionUnit(
                              preset,
                              activeServingOption.unit
                            );
                            return (
                              <button
                                key={preset}
                                type="button"
                                onClick={() => {
                                  setAmount(String(preset));
                                  setUnit(presetUnit);
                                }}
                                className={`tactile-press px-2.5 py-1 text-[11px] font-semibold rounded-full ${
                                  parsedAmount === preset
                                    ? 'bg-foreground text-background shadow-xs'
                                    : 'bg-card text-muted-foreground hover:text-foreground'
                                }`}
                              >
                                {preset} {presetUnit}
                              </button>
                            );
                          })}
                    </div>
                    {!isMetricMode &&
                      scaledNutrition?.effectiveGrams !== undefined && (
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          &asymp; {scaledNutrition.effectiveGrams}g
                        </span>
                      )}
                  </div>
                </div>

                {/* Scaled Macro Summary */}
                {scaledNutrition && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-xs font-semibold text-foreground">
                        Scaled Nutrition
                      </span>
                      <span className="text-xs font-bold text-[var(--macro-calories)] tabular-nums">
                        {scaledNutrition.macros.calories} kcal
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-center">
                      <div className="bg-surface-sub border border-border rounded-xl p-2">
                        <span className="text-[10px] text-[var(--macro-protein)] font-semibold block">
                          Protein
                        </span>
                        <span className="text-xs font-semibold tabular-nums text-foreground">
                          {scaledNutrition.macros.protein}g
                        </span>
                      </div>
                      <div className="bg-surface-sub border border-border rounded-xl p-2">
                        <span className="text-[10px] text-[var(--macro-carbs)] font-semibold block">
                          Carbs
                        </span>
                        <span className="text-xs font-semibold tabular-nums text-foreground">
                          {scaledNutrition.macros.carbs}g
                        </span>
                      </div>
                      <div className="bg-surface-sub border border-border rounded-xl p-2">
                        <span className="text-[10px] text-[var(--macro-fat)] font-semibold block">
                          Fat
                        </span>
                        <span className="text-xs font-semibold tabular-nums text-foreground">
                          {scaledNutrition.macros.fat}g
                        </span>
                      </div>
                      <div className="bg-surface-sub border border-border rounded-xl p-2">
                        <span className="text-[10px] text-[var(--macro-fiber)] font-semibold block">
                          Fiber
                        </span>
                        <span className="text-xs font-semibold tabular-nums text-foreground">
                          {scaledNutrition.macros.fiber}g
                        </span>
                      </div>
                    </div>

                    {/* Micronutrients Pill Row (if any available) */}
                    {Object.keys(scaledNutrition.micros).length > 0 && (
                      <div className="bg-surface-sub/50 border border-border rounded-xl p-2.5 text-[10px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                        {scaledNutrition.micros.potassiumMg !== undefined && (
                          <span>
                            Potassium:{' '}
                            <strong className="text-foreground tabular-nums">
                              {scaledNutrition.micros.potassiumMg}mg
                            </strong>
                          </span>
                        )}
                        {scaledNutrition.micros.sodiumMg !== undefined && (
                          <span>
                            Sodium:{' '}
                            <strong className="text-foreground tabular-nums">
                              {scaledNutrition.micros.sodiumMg}mg
                            </strong>
                          </span>
                        )}
                        {scaledNutrition.micros.calciumMg !== undefined && (
                          <span>
                            Calcium:{' '}
                            <strong className="text-foreground tabular-nums">
                              {scaledNutrition.micros.calciumMg}mg
                            </strong>
                          </span>
                        )}
                        {scaledNutrition.micros.ironMg !== undefined && (
                          <span>
                            Iron:{' '}
                            <strong className="text-foreground tabular-nums">
                              {scaledNutrition.micros.ironMg}mg
                            </strong>
                          </span>
                        )}
                        {scaledNutrition.micros.magnesiumMg !== undefined && (
                          <span>
                            Magnesium:{' '}
                            <strong className="text-foreground tabular-nums">
                              {scaledNutrition.micros.magnesiumMg}mg
                            </strong>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Confirm Log & Multi-Add Staging Buttons */}
                <div className="pt-2 flex flex-col sm:flex-row gap-2">
                  <button
                    type="button"
                    onClick={handleStageAndAddAnother}
                    disabled={isLogging || parsedAmount <= 0}
                    className="tactile-press flex-1 py-2.5 px-4 rounded-full bg-surface-sub border border-border text-foreground font-semibold text-xs hover:bg-accent disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    <Layers className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Stage &amp; Add Another</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleLogFood}
                    disabled={isLogging || parsedAmount <= 0}
                    className="tactile-press flex-1 py-2.5 px-4 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-xs"
                  >
                    {isLogging ? (
                      <Loader2
                        className="w-3.5 h-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Check className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>Log Food</span>
                  </button>
                </div>
              </div>
            );
          })()
        ) : (
          /* Search View */
          <div className="pt-3 flex-1 flex flex-col min-h-0 space-y-2.5">
            {/* Search Input */}
            <div className="relative">
              <Search
                className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                type="text"
                aria-label="Search foods"
                placeholder="Search foods, brands, or staples..."
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                autoFocus
                className="w-full pl-9 pr-8 py-2 text-base sm:text-sm rounded-xl bg-surface-sub border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground placeholder:text-muted-foreground/50 transition-shadow"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => handleQueryChange('')}
                  aria-label="Clear search query"
                  className="touch-target absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              )}
            </div>

            {/* Segmented Recents | Frequent | Pinned Tabs on Empty Query */}
            {!query.trim() && (
              <div
                role="tablist"
                aria-label="Food history tabs"
                className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-surface-sub border border-border"
              >
                {(
                  [
                    { id: 'recents', label: 'Recents' },
                    { id: 'frequent', label: 'Frequent' },
                    { id: 'pinned', label: 'Pinned' },
                  ] as const
                ).map((tab) => {
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => {
                        setActiveTab(tab.id);
                        setHighlightedIndex(-1);
                      }}
                      className={`tactile-press py-1.5 px-2.5 rounded-lg text-xs font-semibold transition-colors ${
                        isActive
                          ? 'bg-foreground text-background shadow-xs'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Non-Blocking Online Status Indicator */}
            {query.trim() && (isOnlineLoading || onlineError) && (
              <div className="flex items-center gap-1.5 px-1 text-[11px]">
                {isOnlineLoading ? (
                  <>
                    <Loader2
                      className="w-3 h-3 animate-spin text-[var(--macro-calories)] shrink-0"
                      aria-hidden="true"
                    />
                    <span className="text-muted-foreground">
                      Searching online food databases...
                    </span>
                  </>
                ) : (
                  <div className="flex items-center justify-between gap-2 w-full">
                    <span className="text-[var(--neutral-over)]">
                      {onlineError}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const trimmed = query.trim();
                        const normKey = trimmed.toLowerCase();
                        if (normKey) onlineQueryCache.delete(normKey);
                        void runOnlineSearch(trimmed, normKey);
                      }}
                      className="tactile-press shrink-0 px-2 py-0.5 rounded-full bg-surface-sub border border-border text-[11px] font-semibold text-foreground hover:bg-surface-elevated"
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Results */}
            <div
              ref={resultsContainerRef}
              data-testid="food-search-results"
              className="flex-1 overflow-y-auto overscroll-contain space-y-1.5 min-h-[200px] sm:min-h-[280px] max-h-[52dvh] sm:max-h-[420px] pr-0.5"
            >
              {displayedEntries.length > 0 ? (
                <>
                  {displayedEntries.map((entry, idx) => {
                    const isRecipe = entry.kind === 'recipe';
                    const itemId = isRecipe ? entry.recipe.id : entry.food.id;
                    const itemName = isRecipe
                      ? entry.recipe.name
                      : entry.food.name;
                    const itemBrand = isRecipe ? undefined : entry.food.brand;
                    const itemRegion = isRecipe ? undefined : entry.food.region;
                    const badge = isRecipe ? null : getFoodSourceBadge(entry.food);
                    const nutrients = isRecipe
                      ? entry.recipe.nutrientsPerBasis
                      : entry.food.nutrientsPerBasis;
                    const basisLabel = isRecipe
                      ? formatRecipeBasisLabel(entry.recipe)
                      : formatFoodBasisLabel(entry.food);
                    const pinKey = `${entry.kind}:${itemId}`;
                    const isPinned = pinnedIdSet.has(pinKey);

                    return (
                      <div
                        key={pinKey}
                        data-highlighted={
                          highlightedIndex === idx ? 'true' : undefined
                        }
                        style={{ animationDelay: `${Math.min(idx, 8) * 25}ms` }}
                        onClick={() => handleSelectEntry(entry)}
                        className={`tactile-press stagger-item w-full text-left p-3 rounded-xl border group flex items-center justify-between gap-2.5 cursor-pointer ${
                          highlightedIndex === idx
                            ? 'bg-accent border-border-focus'
                            : 'bg-surface-sub hover:bg-accent border-border hover:border-border-focus'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-xs font-semibold text-foreground line-clamp-1 group-hover:text-foreground">
                              {itemName}
                            </span>
                            {itemRegion === 'PH' && (
                              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-md font-semibold bg-emerald-500/15 text-emerald-500 shrink-0">
                                PH
                              </span>
                            )}
                            {isRecipe ? (
                              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-md font-semibold bg-[var(--macro-fiber)]/15 text-[var(--macro-fiber)] shrink-0 inline-flex items-center gap-1">
                                <ChefHat
                                  className="w-2.5 h-2.5"
                                  aria-hidden="true"
                                />
                                RECIPE
                              </span>
                            ) : badge ? (
                              <span
                                className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-md font-medium shrink-0 inline-flex items-center gap-1 ${badge.toneClass}`}
                              >
                                {badge.showGlobe && (
                                  <Globe
                                    className="w-2.5 h-2.5"
                                    aria-hidden="true"
                                  />
                                )}
                                {badge.label}
                              </span>
                            ) : null}
                            {entry.lastAmount !== undefined &&
                              entry.lastUnit && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-card border border-border text-muted-foreground tabular-nums">
                                  Last: {entry.lastAmount} {entry.lastUnit}
                                </span>
                              )}
                          </div>
                          {itemBrand && (
                            <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                              {itemBrand}
                            </p>
                          )}
                          <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-1 text-[11px] text-muted-foreground tabular-nums">
                            <span className="text-[var(--macro-calories)] font-semibold">
                              {nutrients.calories} kcal
                            </span>
                            <span>&bull;</span>
                            <span className="text-[var(--macro-protein)]">
                              P: {nutrients.protein}g
                            </span>
                            <span className="text-[var(--macro-carbs)]">
                              C: {nutrients.carbs}g
                            </span>
                            <span className="text-[var(--macro-fat)]">
                              F: {nutrients.fat}g
                            </span>
                            <span className="text-[10px] text-muted-foreground/70">
                              {basisLabel}
                            </span>
                          </div>
                        </div>

                        {/* Per-Row Pin & 1-Tap Quick-Log Actions */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={(e) => void handleTogglePin(e, entry)}
                            aria-label={
                              isPinned ? `Unpin ${itemName}` : `Pin ${itemName}`
                            }
                            aria-pressed={isPinned}
                            className={`touch-target p-1.5 rounded-full border transition-colors ${
                              isPinned
                                ? 'bg-foreground text-background border-foreground'
                                : 'bg-card text-muted-foreground border-border hover:text-foreground'
                            }`}
                          >
                            <Pin className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => void handleQuickLogEntry(e, entry)}
                            aria-label={`Quick log ${itemName}`}
                            className="touch-target p-1.5 rounded-full bg-card border border-border text-muted-foreground hover:bg-foreground hover:text-background hover:border-foreground transition-colors"
                          >
                            <Plus className="w-4 h-4" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {query.trim() &&
                    !isOnlineLoading &&
                    !onlineQueryCache.has(query.trim().toLowerCase()) && (
                      <div className="pt-1.5 pb-1">
                        <button
                          type="button"
                          onClick={() =>
                            void runOnlineSearch(
                              query.trim(),
                              query.trim().toLowerCase()
                            )
                          }
                          className="tactile-press w-full py-2 px-3 rounded-xl bg-surface-sub border border-border hover:bg-accent hover:border-border-focus text-xs font-semibold text-foreground flex items-center justify-center gap-1.5 transition-colors"
                        >
                          <Globe
                            className="w-3.5 h-3.5 text-[var(--macro-calories)]"
                            aria-hidden="true"
                          />
                          <span>Search online</span>
                        </button>
                      </div>
                    )}
                </>
              ) : isOnlineLoading ? (
                <FoodRowSkeleton count={4} />
              ) : (
                <div className="py-10 text-center text-muted-foreground text-xs flex flex-col items-center gap-2.5">
                  <svg
                    width="36"
                    height="36"
                    viewBox="0 0 36 36"
                    fill="none"
                    aria-hidden="true"
                    className="text-muted-foreground/45"
                  >
                    <circle
                      cx="16"
                      cy="16"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M23.5 23.5L31 31"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                  <p>
                    {query.trim()
                      ? 'No matching foods found.'
                      : activeTab === 'pinned'
                        ? 'No pinned foods or recipes yet. Tap the pin button on any item to save it here.'
                        : activeTab === 'frequent'
                          ? 'No frequent logs in the last 60 days yet.'
                          : 'Search offline catalog, regional foods, or online databases above.'}
                  </p>
                  {query.trim() &&
                    !onlineQueryCache.has(query.trim().toLowerCase()) && (
                      <button
                        type="button"
                        onClick={() =>
                          void runOnlineSearch(
                            query.trim(),
                            query.trim().toLowerCase()
                          )
                        }
                        className="tactile-press mt-1 py-1.5 px-3.5 rounded-full bg-surface-sub border border-border hover:bg-accent text-xs font-semibold text-foreground inline-flex items-center gap-1.5"
                      >
                        <Globe
                          className="w-3.5 h-3.5 text-[var(--macro-calories)]"
                          aria-hidden="true"
                        />
                        <span>Search online</span>
                      </button>
                    )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Sticky Multi-Add Staging Tray */}
        {stagedEntries.length > 0 && (
          <div
            data-testid="multi-add-tray"
            className="mt-3 pt-2.5 border-t border-border flex flex-col gap-2 shrink-0"
          >
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
              {stagedEntries.map((item) => (
                <span
                  key={item.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-sub border border-border text-[11px] text-foreground shrink-0 tabular-nums"
                >
                  <span className="max-w-[120px] truncate font-medium">
                    {item.name}
                  </span>
                  <span className="text-muted-foreground">
                    ({item.amount}
                    {item.unit === 'g' || item.unit === 'ml'
                      ? item.unit
                      : ` ${item.unit}`}
                    )
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemoveStagedItem(item.id)}
                    aria-label={`Remove staged ${item.name}`}
                    className="text-muted-foreground hover:text-foreground ml-0.5"
                  >
                    <X className="w-3 h-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 bg-surface-sub border border-border rounded-2xl px-3 py-2">
              <div className="text-xs font-semibold text-foreground tabular-nums">
                {stagedEntries.length}{' '}
                {stagedEntries.length === 1 ? 'item' : 'items'} &middot;{' '}
                <span className="text-[var(--macro-calories)]">
                  {totalStagedCalories} kcal
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setStagedEntries([])}
                  aria-label="Clear staged items"
                  className="tactile-press px-2.5 py-1 rounded-full text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => void handleLogAllStaged()}
                  disabled={isLogging}
                  className="tactile-press px-3.5 py-1.5 rounded-full bg-foreground text-background text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  Log All
                </button>
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

export function FoodSearchDrawer({
  open,
  date,
  mealSlot,
  onClose,
}: FoodSearchDrawerProps) {
  return (
    <AnimatePresence>
      {open && (
        <FoodSearchContent
          key={`${date}-${mealSlot}`}
          date={date}
          mealSlot={mealSlot}
          onClose={onClose}
        />
      )}
    </AnimatePresence>
  );
}
