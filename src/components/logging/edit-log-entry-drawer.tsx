"use client";

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  Calendar,
  Check,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  StickyNote,
  X,
} from 'lucide-react';
import { db } from '@/lib/db/opencalory-db';
import { loadStaples } from '@/lib/foods/staples-search';
import {
  computeMacroCalories,
  formatPortionUnit,
  getServingOptionsForFood,
  scaleFoodByOption,
} from '@/lib/nutrition/scaling';
import {
  EASE_EXPRESSIVE,
  SPRING_SHEET,
  isTestEnvironment,
  triggerHaptic,
} from '@/lib/motion';
import { ShakeOnError } from '@/components/motion/motion-primitives';
import { useLoggerStore } from '@/stores/logger-store';
import type {
  CustomRecipe,
  FoodItem,
  FoodLogEntry,
  FoodServingOption,
  MacroNutrients,
  Micronutrients,
} from '@/types/nutrition';

export interface EditLogEntryDrawerProps {
  entry: FoodLogEntry | null;
  onClose: () => void;
}

function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

function parseNonNegative(raw: string): number {
  const num = parseFloat(raw);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function cloneSnapshot(
  snapshot?: FoodLogEntry['nutritionSnapshot']
): FoodLogEntry['nutritionSnapshot'] {
  const safeVal = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

  const micros: Micronutrients = {};
  if (snapshot?.micros && typeof snapshot.micros === 'object') {
    for (const [k, v] of Object.entries(snapshot.micros)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        micros[k] = safeVal(v);
      }
    }
  }

  return {
    calories: safeVal(snapshot?.calories),
    protein: safeVal(snapshot?.protein),
    carbs: safeVal(snapshot?.carbs),
    fat: safeVal(snapshot?.fat),
    fiber: safeVal(snapshot?.fiber),
    micros,
  };
}

/**
 * Proportionally rescales macros and all micronutrient keys (including extended nutrients)
 * by (newAmount / oldAmount), safely guarding against zero/invalid oldAmount.
 */
export function scaleSnapshotProportionally(
  snapshot: FoodLogEntry['nutritionSnapshot'] | undefined,
  oldAmount: number,
  newAmount: number
): FoodLogEntry['nutritionSnapshot'] {
  const safeOld =
    typeof oldAmount === 'number' && Number.isFinite(oldAmount) && oldAmount > 0
      ? oldAmount
      : 0;
  const safeNew =
    typeof newAmount === 'number' && Number.isFinite(newAmount) && newAmount > 0
      ? newAmount
      : 0;

  const factor = safeOld > 0 ? safeNew / safeOld : safeNew > 0 ? 1 : 0;

  const scaleVal = (val: unknown): number => {
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0 || factor === 0) {
      return 0;
    }
    return round2(val * factor);
  };

  const micros: Micronutrients = {};
  if (snapshot?.micros && typeof snapshot.micros === 'object') {
    for (const [key, value] of Object.entries(snapshot.micros)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        micros[key] = scaleVal(value);
      }
    }
  }

  return {
    calories: scaleVal(snapshot?.calories),
    protein: scaleVal(snapshot?.protein),
    carbs: scaleVal(snapshot?.carbs),
    fat: scaleVal(snapshot?.fat),
    fiber: scaleVal(snapshot?.fiber),
    micros,
  };
}

/**
 * Maps a CustomRecipe to a FoodItem so FoodServingOption unit pills and scaleFoodByOption
 * work consistently across servings and grams.
 */
export function recipeToFoodItem(recipe: CustomRecipe): FoodItem {
  const defaultServings = Math.max(1, Number(recipe.defaultServings) || 1);
  const effectiveTotalGrams =
    typeof recipe.cookedWeightGrams === 'number' && recipe.cookedWeightGrams > 0
      ? recipe.cookedWeightGrams
      : Number(recipe.totalGrams) || 0;

  const servingWeightGrams =
    effectiveTotalGrams > 0 ? round2(effectiveTotalGrams / defaultServings) : undefined;

  if (recipe.basis === 'per100g') {
    const servingOptions: FoodServingOption[] = [
      { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
    ];
    if (servingWeightGrams && servingWeightGrams > 0) {
      servingOptions.push({
        id: 'serving',
        label: `serving (${servingWeightGrams}g)`,
        unit: 'serving',
        grams: servingWeightGrams,
        defaultAmount: 1,
      });
    }
    return {
      id: `recipe:${recipe.id}`,
      source: 'custom_food',
      name: recipe.name,
      basis: 'per100g',
      servingSize: 100,
      servingUnit: 'g',
      servingWeightGrams,
      servingOptions,
      nutrientsPerBasis: { ...recipe.nutrientsPerBasis },
      micronutrientsPerBasis: { ...(recipe.micronutrientsPerBasis ?? {}) },
      updatedAt: recipe.createdAt ?? Date.now(),
    };
  }

  const servingOptions: FoodServingOption[] = [
    {
      id: 'serving',
      label: servingWeightGrams ? `serving (${servingWeightGrams}g)` : 'serving',
      unit: 'serving',
      grams: servingWeightGrams ?? 0,
      defaultAmount: 1,
    },
  ];
  if (servingWeightGrams && servingWeightGrams > 0) {
    servingOptions.push({
      id: 'g',
      label: 'g',
      unit: 'g',
      grams: 1,
      defaultAmount: Math.round(servingWeightGrams),
    });
  }

  return {
    id: `recipe:${recipe.id}`,
    source: 'custom_food',
    name: recipe.name,
    basis: 'perServing',
    servingSize: 1,
    servingUnit: 'serving',
    servingWeightGrams,
    servingOptions,
    nutrientsPerBasis: { ...recipe.nutrientsPerBasis },
    micronutrientsPerBasis: { ...(recipe.micronutrientsPerBasis ?? {}) },
    updatedAt: recipe.createdAt ?? Date.now(),
  };
}

function findMatchingServingOption(
  options: FoodServingOption[],
  unit: string
): FoodServingOption | undefined {
  const raw = (unit || '').trim().toLowerCase();
  if (!raw) return undefined;
  const canonical = formatPortionUnit(1, raw).toLowerCase();

  return options.find((opt) => {
    const optUnit = opt.unit.trim().toLowerCase();
    const optCanonical = formatPortionUnit(1, optUnit).toLowerCase();
    return (
      opt.id.toLowerCase() === raw ||
      optUnit === raw ||
      optCanonical === canonical
    );
  });
}

async function resolveFoodForEntry(entry: FoodLogEntry): Promise<FoodItem | null> {
  if (!entry.foodId || entry.source === 'quick_add') {
    return null;
  }

  try {
    if (entry.source === 'recipe' || entry.foodId.startsWith('recipe:')) {
      const recipeId = entry.foodId.startsWith('recipe:')
        ? entry.foodId.slice('recipe:'.length)
        : entry.foodId;
      const recipe = await db.customRecipes.get(recipeId);
      if (recipe) {
        return recipeToFoodItem(recipe);
      }
    }

    const cached = await db.foodsCache.get(entry.foodId);
    if (cached) {
      return cached;
    }

    const staples = await loadStaples();
    return staples.find((item) => item.id === entry.foodId) ?? null;
  } catch {
    return null;
  }
}

function EditLogEntryContent({
  entry,
  onClose,
}: {
  entry: FoodLogEntry;
  onClose: () => void;
}) {
  const showUndoToast = useLoggerStore((s) => s.showUndoToast);

  const [amount, setAmount] = useState<string>(() => String(entry.amount ?? 0));
  const [unit, setUnit] = useState<string>(() => entry.unit || 'g');
  const [logDate, setLogDate] = useState<string>(() => entry.date);
  const [note, setNote] = useState<string>(() => entry.note ?? '');

  const [directMacroEdit, setDirectMacroEdit] = useState<boolean>(
    () => entry.source === 'quick_add'
  );
  const [directName, setDirectName] = useState<string>(() => entry.name);
  const [directCalories, setDirectCalories] = useState<string>(() =>
    String(entry.nutritionSnapshot?.calories ?? 0)
  );
  const [directProtein, setDirectProtein] = useState<string>(() =>
    String(entry.nutritionSnapshot?.protein ?? 0)
  );
  const [directCarbs, setDirectCarbs] = useState<string>(() =>
    String(entry.nutritionSnapshot?.carbs ?? 0)
  );
  const [directFat, setDirectFat] = useState<string>(() =>
    String(entry.nutritionSnapshot?.fat ?? 0)
  );
  const [directFiber, setDirectFiber] = useState<string>(() =>
    String(entry.nutritionSnapshot?.fiber ?? 0)
  );
  const macroRatioAnchorRef = useRef<MacroNutrients>({
    calories: entry.nutritionSnapshot?.calories ?? 0,
    protein: entry.nutritionSnapshot?.protein ?? 0,
    carbs: entry.nutritionSnapshot?.carbs ?? 0,
    fat: entry.nutritionSnapshot?.fat ?? 0,
    fiber: entry.nutritionSnapshot?.fiber ?? 0,
  });

  const [hasPortionChanged, setHasPortionChanged] = useState<boolean>(false);
  const [hasUnitManuallyEdited, setHasUnitManuallyEdited] = useState<boolean>(false);
  const [resolvedFood, setResolvedFood] = useState<FoodItem | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string>('');
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void resolveFoodForEntry(entry).then((food) => {
      if (!cancelled && food) {
        setResolvedFood(food);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const servingOptions = useMemo(
    () => (resolvedFood ? getServingOptionsForFood(resolvedFood) : []),
    [resolvedFood]
  );

  const matchedInitialOption = useMemo(
    () => findMatchingServingOption(servingOptions, entry.unit),
    [servingOptions, entry.unit]
  );

  const activeServingOption = useMemo(() => {
    if (selectedOptionId) {
      return servingOptions.find((o) => o.id === selectedOptionId) ?? matchedInitialOption;
    }
    return matchedInitialOption;
  }, [servingOptions, selectedOptionId, matchedInitialOption]);

  const parsedAmount = parseNonNegative(amount);

  const computedScaled = useMemo((): {
    macros: MacroNutrients;
    micros: Micronutrients;
    effectiveGrams?: number;
  } => {
    if (!hasPortionChanged) {
      const snap = cloneSnapshot(entry.nutritionSnapshot);
      const effectiveGrams =
        activeServingOption &&
        activeServingOption.unit !== 'g' &&
        activeServingOption.unit !== 'ml' &&
        activeServingOption.grams > 0
          ? round2(parsedAmount * activeServingOption.grams)
          : undefined;
      return {
        macros: {
          calories: snap.calories,
          protein: snap.protein,
          carbs: snap.carbs,
          fat: snap.fat,
          fiber: snap.fiber,
        },
        micros: snap.micros,
        effectiveGrams,
      };
    }

    if (resolvedFood && activeServingOption) {
      return scaleFoodByOption(resolvedFood, parsedAmount, activeServingOption);
    }

    const scaled = scaleSnapshotProportionally(
      entry.nutritionSnapshot,
      entry.amount,
      parsedAmount
    );
    return {
      macros: {
        calories: scaled.calories,
        protein: scaled.protein,
        carbs: scaled.carbs,
        fat: scaled.fat,
        fiber: scaled.fiber,
      },
      micros: scaled.micros,
      effectiveGrams: undefined,
    };
  }, [hasPortionChanged, entry, resolvedFood, activeServingOption, parsedAmount]);

  const previewNutrition = useMemo(() => {
    if (directMacroEdit) {
      return {
        macros: {
          calories: parseNonNegative(directCalories),
          protein: parseNonNegative(directProtein),
          carbs: parseNonNegative(directCarbs),
          fat: parseNonNegative(directFat),
          fiber: parseNonNegative(directFiber),
        },
        micros: computedScaled.micros,
      };
    }
    return {
      macros: computedScaled.macros,
      micros: computedScaled.micros,
    };
  }, [
    directMacroEdit,
    directCalories,
    directProtein,
    directCarbs,
    directFat,
    directFiber,
    computedScaled,
  ]);

  const handleSelectServingOption = (opt: FoodServingOption) => {
    triggerHaptic(6);
    const prevUnit = activeServingOption?.unit ?? unit.trim().toLowerCase();
    const prevGramsPerUnit =
      prevUnit === 'g' || prevUnit === 'ml' ? 1 : (activeServingOption?.grams ?? 0);
    const nextGramsPerUnit = opt.unit === 'g' || opt.unit === 'ml' ? 1 : opt.grams;

    let nextAmount: number;
    if (parsedAmount > 0 && prevGramsPerUnit > 0 && nextGramsPerUnit > 0) {
      nextAmount = round2((parsedAmount * prevGramsPerUnit) / nextGramsPerUnit);
    } else {
      nextAmount =
        opt.defaultAmount ?? (opt.unit === 'g' || opt.unit === 'ml' ? 100 : 1);
    }

    setSelectedOptionId(opt.id);
    setAmount(String(nextAmount));
    setUnit(formatPortionUnit(nextAmount, opt.unit));
    setHasUnitManuallyEdited(false);
    setHasPortionChanged(true);
  };

  const handleAmountChange = (val: string) => {
    setAmount(val);
    setHasPortionChanged(true);

    if (!hasUnitManuallyEdited) {
      const targetUnit =
        activeServingOption &&
        activeServingOption.unit !== 'g' &&
        activeServingOption.unit !== 'ml'
          ? activeServingOption.unit
          : unit;
      const lower = targetUnit.trim().toLowerCase();
      if (lower && lower !== 'g' && lower !== 'ml') {
        const parsed = parseFloat(val);
        if (Number.isFinite(parsed) && parsed > 0) {
          setUnit(formatPortionUnit(parsed, targetUnit));
        }
      }
    }
  };

  const handlePresetClick = (preset: number, presetUnit: string) => {
    triggerHaptic(6);
    setAmount(String(preset));
    setUnit(presetUnit);
    setHasUnitManuallyEdited(false);
    setHasPortionChanged(true);
  };

  const handleToggleDirectMacroEdit = (nextChecked: boolean) => {
    triggerHaptic(6);
    if (nextChecked) {
      setDirectName(entry.name);
      setDirectCalories(String(computedScaled.macros.calories));
      setDirectProtein(String(computedScaled.macros.protein));
      setDirectCarbs(String(computedScaled.macros.carbs));
      setDirectFat(String(computedScaled.macros.fat));
      setDirectFiber(String(computedScaled.macros.fiber));
      macroRatioAnchorRef.current = { ...computedScaled.macros };
    }
    setDirectMacroEdit(nextChecked);
  };

  const handleDirectMacroChange = (
    field: 'protein' | 'carbs' | 'fat' | 'fiber',
    rawVal: string
  ) => {
    const nextProteinStr = field === 'protein' ? rawVal : directProtein;
    const nextCarbsStr = field === 'carbs' ? rawVal : directCarbs;
    const nextFatStr = field === 'fat' ? rawVal : directFat;
    const nextFiberStr = field === 'fiber' ? rawVal : directFiber;

    if (field === 'protein') setDirectProtein(rawVal);
    if (field === 'carbs') setDirectCarbs(rawVal);
    if (field === 'fat') setDirectFat(rawVal);
    if (field === 'fiber') setDirectFiber(rawVal);

    const nextP = parseNonNegative(nextProteinStr);
    const nextC = parseNonNegative(nextCarbsStr);
    const nextF = parseNonNegative(nextFatStr);
    const nextFiber = parseNonNegative(nextFiberStr);

    if (field === 'fiber') {
      macroRatioAnchorRef.current = {
        ...macroRatioAnchorRef.current,
        fiber: nextFiber,
      };
      return;
    }

    const nextCalories = computeMacroCalories(nextP, nextC, nextF);
    setDirectCalories(String(nextCalories));
    if (nextCalories > 0 || nextP > 0 || nextC > 0 || nextF > 0 || nextFiber > 0) {
      macroRatioAnchorRef.current = {
        calories: nextCalories,
        protein: nextP,
        carbs: nextC,
        fat: nextF,
        fiber: nextFiber,
      };
    }
  };

  const handleDirectCaloriesChange = (rawVal: string) => {
    setDirectCalories(rawVal);
    const nextCalories = parseNonNegative(rawVal);
    const anchor = macroRatioAnchorRef.current;
    const anchorCalories =
      anchor.calories > 0
        ? anchor.calories
        : computeMacroCalories(anchor.protein, anchor.carbs, anchor.fat);

    if (anchorCalories > 0) {
      const factor = nextCalories / anchorCalories;
      setDirectProtein(String(round2(anchor.protein * factor)));
      setDirectCarbs(String(round2(anchor.carbs * factor)));
      setDirectFat(String(round2(anchor.fat * factor)));
      setDirectFiber(String(round2(anchor.fiber * factor)));
    }
  };

  const handleSyncToMacros = () => {
    triggerHaptic(6);
    const p = parseNonNegative(directProtein);
    const c = parseNonNegative(directCarbs);
    const f = parseNonNegative(directFat);
    const fiber = parseNonNegative(directFiber);
    const cal = computeMacroCalories(p, c, f);
    setDirectCalories(String(cal));
    if (cal > 0 || p > 0 || c > 0 || f > 0 || fiber > 0) {
      macroRatioAnchorRef.current = {
        calories: cal,
        protein: p,
        carbs: c,
        fat: f,
        fiber,
      };
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setIsSaving(true);
    setErrorMessage(null);

    try {
      const previousSnapshot: FoodLogEntry = {
        ...entry,
        nutritionSnapshot: cloneSnapshot(entry.nutritionSnapshot),
      };

      const trimmedUnit = unit.trim();
      const resolvedUnit = trimmedUnit
        ? hasUnitManuallyEdited
          ? trimmedUnit
          : formatPortionUnit(parsedAmount, trimmedUnit)
        : entry.unit || 'g';

      const trimmedNote = note.trim();
      const updated: FoodLogEntry = {
        id: entry.id,
        date: logDate.trim() || entry.date,
        mealSlot: entry.mealSlot ?? 'log',
        foodId: entry.foodId,
        name: directMacroEdit ? directName.trim() || entry.name : entry.name,
        source: entry.source,
        amount: parsedAmount,
        unit: resolvedUnit,
        nutritionSnapshot: {
          calories: previewNutrition.macros.calories,
          protein: previewNutrition.macros.protein,
          carbs: previewNutrition.macros.carbs,
          fat: previewNutrition.macros.fat,
          fiber: previewNutrition.macros.fiber,
          micros: { ...previewNutrition.micros },
        },
        ...(trimmedNote ? { note: trimmedNote } : {}),
        createdAt: entry.createdAt,
      };

      await db.foodLogs.put(updated);
      triggerHaptic(10);

      showUndoToast({
        message: `Updated ${updated.name}`,
        onUndo: async () => {
          await db.foodLogs.put(previousSnapshot);
        },
      });

      onClose();
    } catch (err) {
      console.error('Failed to update log entry:', err);
      setErrorMessage('Unable to save changes offline. Please check storage and try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const isMetricMode =
    !activeServingOption ||
    activeServingOption.unit === 'g' ||
    activeServingOption.unit === 'ml';
  const metricUnit =
    activeServingOption?.unit === 'ml' || unit.trim().toLowerCase() === 'ml' ? 'ml' : 'g';
  const metricPresets = [50, 100, 150, 200, 250];
  const countablePresets = [0.5, 1, 1.5, 2, 3];
  const canShowQuickPresets =
    !directMacroEdit &&
    (servingOptions.length > 0 ||
      unit.trim().toLowerCase() === 'g' ||
      unit.trim().toLowerCase() === 'ml');

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Edit Log Entry"
      data-testid="edit-log-entry-drawer"
      initial={isTestEnvironment() ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={isTestEnvironment() ? undefined : { opacity: 0 }}
      transition={{ duration: 0.24, ease: EASE_EXPRESSIVE }}
      className="modal-viewport-overlay z-50 flex flex-col justify-end sm:items-center sm:justify-center sm:p-6 bg-black/72"
      onClick={onClose}
    >
      <motion.div
        initial={isTestEnvironment() ? false : { opacity: 0, y: 48, scale: 0.94 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={isTestEnvironment() ? undefined : { opacity: 0, y: 36, scale: 0.95 }}
        transition={SPRING_SHEET}
        className="modal-viewport-sheet w-full max-w-lg mx-auto surface-elevated-sheet rounded-t-3xl sm:rounded-3xl px-4 sm:px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-5 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-9 h-1 rounded-full bg-border mx-auto mb-3 shrink-0 sm:hidden" aria-hidden="true" />

        {/* Header */}
        <div className="shrink-0 flex items-center justify-between pb-3 border-b border-border gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-surface-sub border border-border/60 flex items-center justify-center text-foreground shrink-0">
              <Pencil className="w-4 h-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground truncate">
                {directMacroEdit ? directName.trim() || entry.name : entry.name}
              </h2>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
                {entry.source.replace('_', ' ')} Â· {logDate || entry.date}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close edit drawer"
            className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub shrink-0"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Form Body */}
        <form
          onSubmit={handleSubmit}
          className="pt-4 space-y-4 flex-1 min-h-0 overflow-y-auto overscroll-contain"
        >
          {/* Portion Card */}
          <div className="bg-surface-sub border border-border rounded-2xl p-3.5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="edit-entry-amount" className="text-xs font-semibold text-foreground">
                Portion Amount
              </label>
              {activeServingOption && !isMetricMode && computedScaled.effectiveGrams !== undefined && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  &asymp; {computedScaled.effectiveGrams}g
                </span>
              )}
            </div>

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
                  id="edit-entry-amount"
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
                  id="edit-entry-unit"
                  aria-label="Portion unit"
                  type="text"
                  value={unit}
                  onChange={(e) => {
                    setUnit(e.target.value);
                    setHasUnitManuallyEdited(true);
                  }}
                  className="w-full px-3 py-2 text-base sm:text-xs font-medium rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground text-center"
                />
              </div>
            </div>

            {canShowQuickPresets && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {isMetricMode
                  ? metricPresets.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => handlePresetClick(preset, metricUnit)}
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
                        activeServingOption?.unit || unit || 'serving'
                      );
                      return (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => handlePresetClick(preset, presetUnit)}
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
            )}
          </div>

          {/* Scaled Nutrition Summary (when not editing macros directly) */}
          {!directMacroEdit && (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="text-xs font-semibold text-foreground">Scaled Nutrition</span>
                <span className="text-xs font-bold text-[var(--macro-calories)] tabular-nums">
                  {previewNutrition.macros.calories} kcal
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="bg-surface-sub border border-border rounded-xl p-2">
                  <span className="text-[10px] text-[var(--macro-protein)] font-semibold block">
                    Protein
                  </span>
                  <span className="text-xs font-semibold tabular-nums text-foreground">
                    {previewNutrition.macros.protein}g
                  </span>
                </div>
                <div className="bg-surface-sub border border-border rounded-xl p-2">
                  <span className="text-[10px] text-[var(--macro-carbs)] font-semibold block">
                    Carbs
                  </span>
                  <span className="text-xs font-semibold tabular-nums text-foreground">
                    {previewNutrition.macros.carbs}g
                  </span>
                </div>
                <div className="bg-surface-sub border border-border rounded-xl p-2">
                  <span className="text-[10px] text-[var(--macro-fat)] font-semibold block">
                    Fat
                  </span>
                  <span className="text-xs font-semibold tabular-nums text-foreground">
                    {previewNutrition.macros.fat}g
                  </span>
                </div>
                <div className="bg-surface-sub border border-border rounded-xl p-2">
                  <span className="text-[10px] text-[var(--macro-fiber)] font-semibold block">
                    Fiber
                  </span>
                  <span className="text-xs font-semibold tabular-nums text-foreground">
                    {previewNutrition.macros.fiber}g
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Direct Macro Edit Toggle */}
          <div className="bg-surface-sub border border-border rounded-2xl p-3 space-y-3">
            <label
              htmlFor="edit-macros-directly-switch"
              className="flex items-center justify-between gap-3 cursor-pointer select-none"
            >
              <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <SlidersHorizontal className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
                <span>Edit macros directly</span>
              </span>
              <span className="relative inline-flex items-center shrink-0">
                <input
                  id="edit-macros-directly-switch"
                  type="checkbox"
                  role="switch"
                  aria-checked={directMacroEdit}
                  checked={directMacroEdit}
                  onChange={(e) => handleToggleDirectMacroEdit(e.target.checked)}
                  className="sr-only peer"
                />
                <span className="w-10 h-6 rounded-full bg-card border border-border peer-checked:bg-foreground transition-colors" />
                <span className="absolute left-1 top-1 w-4 h-4 rounded-full bg-muted-foreground peer-checked:translate-x-4 peer-checked:bg-background transition-transform" />
              </span>
            </label>

            {directMacroEdit && (
              <div className="space-y-3 pt-2 border-t border-border/60">
                <div>
                  <label
                    htmlFor="edit-entry-name"
                    className="block text-[11px] font-medium text-muted-foreground mb-1"
                  >
                    Name
                  </label>
                  <input
                    id="edit-entry-name"
                    aria-label="Name"
                    type="text"
                    value={directName}
                    onChange={(e) => setDirectName(e.target.value)}
                    className="w-full px-3 py-2 text-base sm:text-sm rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="edit-entry-calories"
                      className="text-[11px] font-semibold text-[var(--macro-calories)]"
                    >
                      Calories (kcal)
                    </label>
                    <button
                      type="button"
                      onClick={handleSyncToMacros}
                      aria-label="Sync to macros"
                      className="tactile-press inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-2.5 py-1 rounded-full bg-card border border-border"
                    >
                      <RefreshCw className="w-2.5 h-2.5" aria-hidden="true" />
                      <span>Sync to macros</span>
                    </button>
                  </div>
                  <input
                    id="edit-entry-calories"
                    aria-label="Calories"
                    type="number"
                    step="any"
                    min="0"
                    value={directCalories}
                    onChange={(e) => handleDirectCaloriesChange(e.target.value)}
                    className="w-full px-3 py-2 text-base sm:text-sm font-semibold tabular-nums rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                  />
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div>
                    <label
                      htmlFor="edit-entry-protein"
                      className="block text-[10px] font-semibold text-[var(--macro-protein)] mb-1"
                    >
                      Protein (g)
                    </label>
                    <input
                      id="edit-entry-protein"
                      aria-label="Protein"
                      type="number"
                      step="any"
                      min="0"
                      value={directProtein}
                      onChange={(e) => handleDirectMacroChange('protein', e.target.value)}
                      className="w-full px-2.5 py-1.5 text-base sm:text-xs font-semibold tabular-nums rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="edit-entry-carbs"
                      className="block text-[10px] font-semibold text-[var(--macro-carbs)] mb-1"
                    >
                      Carbs (g)
                    </label>
                    <input
                      id="edit-entry-carbs"
                      aria-label="Carbs"
                      type="number"
                      step="any"
                      min="0"
                      value={directCarbs}
                      onChange={(e) => handleDirectMacroChange('carbs', e.target.value)}
                      className="w-full px-2.5 py-1.5 text-base sm:text-xs font-semibold tabular-nums rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="edit-entry-fat"
                      className="block text-[10px] font-semibold text-[var(--macro-fat)] mb-1"
                    >
                      Fat (g)
                    </label>
                    <input
                      id="edit-entry-fat"
                      aria-label="Fat"
                      type="number"
                      step="any"
                      min="0"
                      value={directFat}
                      onChange={(e) => handleDirectMacroChange('fat', e.target.value)}
                      className="w-full px-2.5 py-1.5 text-base sm:text-xs font-semibold tabular-nums rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="edit-entry-fiber"
                      className="block text-[10px] font-semibold text-[var(--macro-fiber)] mb-1"
                    >
                      Fiber (g)
                    </label>
                    <input
                      id="edit-entry-fiber"
                      aria-label="Fiber"
                      type="number"
                      step="any"
                      min="0"
                      value={directFiber}
                      onChange={(e) => handleDirectMacroChange('fiber', e.target.value)}
                      className="w-full px-2.5 py-1.5 text-base sm:text-xs font-semibold tabular-nums rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Log Date & Note */}
          <div className="space-y-3">
            <div className="bg-surface-sub border border-border rounded-xl p-3 flex items-center justify-between gap-3">
              <label
                htmlFor="edit-entry-date"
                className="flex items-center gap-2 text-xs font-semibold text-foreground shrink-0"
              >
                <Calendar className="w-3.5 h-3.5 text-[var(--macro-calories)]" aria-hidden="true" />
                <span>Log Date</span>
              </label>
              <input
                id="edit-entry-date"
                aria-label="Log date"
                type="date"
                value={logDate}
                onChange={(e) => setLogDate(e.target.value)}
                className="px-2.5 py-1.5 text-base sm:text-xs font-medium tabular-nums rounded-lg bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
              />
            </div>

            <div className="bg-surface-sub border border-border rounded-xl p-3 space-y-1.5">
              <label
                htmlFor="edit-entry-note"
                className="flex items-center gap-1.5 text-xs font-semibold text-foreground"
              >
                <StickyNote className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
                <span>Note (Optional)</span>
              </label>
              <textarea
                id="edit-entry-note"
                aria-label="Note"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add context (e.g. post-workout, air-fried, brand variant)..."
                className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground placeholder:text-muted-foreground/55 resize-none"
              />
            </div>
          </div>

          {errorMessage && (
            <ShakeOnError shakeKey={errorMessage}>
              <div
                role="alert"
                className="p-2.5 rounded-xl bg-surface-sub border border-border text-[var(--neutral-over)] text-xs flex items-center gap-2"
              >
                <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{errorMessage}</span>
              </div>
            </ShakeOnError>
          )}

          {/* Save Changes */}
          <button
            type="submit"
            disabled={isSaving}
            className="tactile-press w-full py-2.5 px-4 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-xs"
          >
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Save Changes</span>
          </button>
        </form>
      </motion.div>
    </motion.div>
  );
}

export function EditLogEntryDrawer({ entry, onClose }: EditLogEntryDrawerProps) {
  return (
    <AnimatePresence>
      {entry && <EditLogEntryContent key={entry.id} entry={entry} onClose={onClose} />}
    </AnimatePresence>
  );
}
