"use client";

import React, { useState, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X, RefreshCw, Zap, AlertCircle, RotateCcw } from 'lucide-react';
import { db, generateId } from '@/lib/db/opencalory-db';
import { computeMacroCalories } from '@/lib/nutrition/scaling';
import { useLoggerStore, formatHumanDate } from '@/stores/logger-store';
import {
  EASE_EXPRESSIVE,
  SPRING_SHEET,
  isTestEnvironment,
  triggerHaptic,
} from '@/lib/motion';
import { ShakeOnError } from '@/components/motion/motion-primitives';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import type { FoodLogEntry } from '@/types/nutrition';

const QUICK_ADD_DRAFT_KEY = 'macro_quick_add_draft_v1';

interface QuickAddDraft {
  name: string;
  protein: string;
  carbs: string;
  fat: string;
  fiber: string;
  calories: string;
  isCalorieOverridden: boolean;
}

function readQuickAddDraft(): Partial<QuickAddDraft> {
  try {
    const raw =
      typeof window !== 'undefined'
        ? window.localStorage.getItem(QUICK_ADD_DRAFT_KEY)
        : null;
    return raw ? (JSON.parse(raw) as Partial<QuickAddDraft>) : {};
  } catch {
    return {};
  }
}

export interface QuickAddDrawerProps {
  open: boolean;
  date?: string;
  mealSlot?: string;
  onClose: () => void;
}

interface QuickAddContentProps {
  date?: string;
  mealSlot?: string;
  onClose: () => void;
}

function QuickAddContent({ date, mealSlot, onClose }: QuickAddContentProps) {
  const storeDate = useLoggerStore((s) => s.activeDate);
  const storeMealSlot = useLoggerStore((s) => s.activeMealSlot);

  const effectiveDate = date ?? storeDate;
  const effectiveMealSlot = mealSlot ?? storeMealSlot;

  const [initialDraft] = useState<Partial<QuickAddDraft>>(readQuickAddDraft);
  const [name, setName] = useState(initialDraft.name ?? 'Quick Add');
  const [protein, setProtein] = useState<string>(initialDraft.protein ?? '');
  const [carbs, setCarbs] = useState<string>(initialDraft.carbs ?? '');
  const [fat, setFat] = useState<string>(initialDraft.fat ?? '');
  const [fiber, setFiber] = useState<string>(initialDraft.fiber ?? '');
  const [calories, setCalories] = useState<string>(initialDraft.calories ?? '0');
  const [isCalorieOverridden, setIsCalorieOverridden] = useState(
    Boolean(initialDraft.isCalorieOverridden)
  );
  const [touched, setTouched] = useState<{
    calories?: boolean;
    protein?: boolean;
    carbs?: boolean;
    fat?: boolean;
    fiber?: boolean;
  }>({});
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmHighCalories, setConfirmHighCalories] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(sheetRef, true);

  const isDirty =
    name !== 'Quick Add' ||
    protein !== '' ||
    carbs !== '' ||
    fat !== '' ||
    fiber !== '' ||
    calories !== '0' ||
    isCalorieOverridden;

  useEffect(() => {
    try {
      if (isDirty) {
        window.localStorage.setItem(
          QUICK_ADD_DRAFT_KEY,
          JSON.stringify({
            name,
            protein,
            carbs,
            fat,
            fiber,
            calories,
            isCalorieOverridden,
          })
        );
      } else {
        window.localStorage.removeItem(QUICK_ADD_DRAFT_KEY);
      }
    } catch {
      // Ignore storage quota/unavailable errors
    }
  }, [isDirty, name, protein, carbs, fat, fiber, calories, isCalorieOverridden]);

  const handleResetDraft = () => {
    setName('Quick Add');
    setProtein('');
    setCarbs('');
    setFat('');
    setFiber('');
    setCalories('0');
    setIsCalorieOverridden(false);
    setTouched({});
    try {
      window.localStorage.removeItem(QUICK_ADD_DRAFT_KEY);
    } catch {
      // Ignore storage errors
    }
  };

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

  const parseSafe = (val: string): number => {
    const num = parseFloat(val);
    return Number.isFinite(num) && num > 0 ? num : 0;
  };

  const handleMacroChange = (macro: 'p' | 'c' | 'f', val: string) => {
    setConfirmHighCalories(false);
    const newP = macro === 'p' ? val : protein;
    const newC = macro === 'c' ? val : carbs;
    const newF = macro === 'f' ? val : fat;

    if (macro === 'p') setProtein(val);
    if (macro === 'c') setCarbs(val);
    if (macro === 'f') setFat(val);

    if (!isCalorieOverridden) {
      const p = parseSafe(newP);
      const c = parseSafe(newC);
      const f = parseSafe(newF);
      setCalories(String(computeMacroCalories(p, c, f)));
    }
  };

  const handleCaloriesChange = (val: string) => {
    setConfirmHighCalories(false);
    setIsCalorieOverridden(true);
    setCalories(val);
  };

  const handleSyncToMacros = () => {
    setConfirmHighCalories(false);
    setIsCalorieOverridden(false);
    const p = parseSafe(protein);
    const c = parseSafe(carbs);
    const f = parseSafe(fat);
    setCalories(String(computeMacroCalories(p, c, f)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;

    const safeP = parseSafe(protein);
    const safeC = parseSafe(carbs);
    const safeF = parseSafe(fat);
    const safeFiber = parseSafe(fiber);
    const safeCal = parseSafe(calories);

    if (safeCal > 10000 && !confirmHighCalories) {
      setConfirmHighCalories(true);
      setErrorMessage(
        `Double-check ${Math.round(safeCal).toLocaleString()} kcal â€” tap "Confirm & Log" if this entry is intentional.`
      );
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setConfirmHighCalories(false);

    try {

      const entry: FoodLogEntry = {
        id: generateId(),
        date: effectiveDate,
        mealSlot: effectiveMealSlot,
        foodId: `quick-add-${generateId()}`,
        name: name.trim() || 'Quick Add',
        source: 'quick_add',
        amount: 1,
        unit: 'serving',
        nutritionSnapshot: {
          calories: safeCal,
          protein: safeP,
          carbs: safeC,
          fat: safeF,
          fiber: safeFiber,
          micros: {},
        },
        createdAt: Date.now(),
      };

      await db.foodLogs.add(entry);
      try {
        window.localStorage.removeItem(QUICK_ADD_DRAFT_KEY);
      } catch {
        // Ignore storage errors
      }
      triggerHaptic(10);
      onClose();
    } catch (err: unknown) {
      console.error('Failed to log quick add entry:', err);
      setErrorMessage('Unable to save log entry offline. Check browser storage permissions and try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const isTest = isTestEnvironment();

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Quick Add Macros"
      data-testid="quick-add-drawer"
      initial={isTest ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={isTest ? undefined : { opacity: 0 }}
      transition={{ duration: 0.24, ease: EASE_EXPRESSIVE }}
      className="modal-viewport-overlay z-50 flex flex-col justify-end sm:items-center sm:justify-center sm:p-6 bg-black/72"
      onClick={onClose}
    >
      <motion.div
        ref={sheetRef}
        initial={isTest ? false : { opacity: 0, y: 48, scale: 0.94 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={isTest ? undefined : { opacity: 0, y: 36, scale: 0.95 }}
        transition={SPRING_SHEET}
        className="modal-viewport-sheet w-full max-w-lg mx-auto surface-elevated-sheet rounded-t-3xl sm:rounded-3xl px-4 sm:px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-5 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-9 h-1 rounded-full bg-border mx-auto mb-3 shrink-0 sm:hidden" aria-hidden="true" />
        {/* Drawer Header */}
        <div className="shrink-0 flex items-center justify-between pb-3 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[var(--macro-fat)]/15 flex items-center justify-center text-[var(--macro-fat)]">
              <Zap className="w-4 h-4" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Quick Add Macros</h2>
              <p className="text-[11px] text-muted-foreground">
                Logging for {formatHumanDate(effectiveDate)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {isDirty && (
              <button
                type="button"
                onClick={handleResetDraft}
                className="tactile-press inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-full bg-surface-sub border border-border text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="w-3 h-3" aria-hidden="true" />
                <span>Reset draft</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close quick add"
              className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="pt-4 space-y-4 flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <div>
            <label htmlFor="quick-add-name" className="block text-[11px] font-medium text-muted-foreground mb-1">
              Description (Optional)
            </label>
            <input
              id="quick-add-name"
              aria-label="Description"
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Protein shake, Greek yogurt"
              className="w-full px-3 py-2 text-base sm:text-sm rounded-xl bg-surface-sub border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground placeholder:text-muted-foreground/50 transition-shadow"
            />
          </div>

          {/* Calories row with override indicator & sync */}
          <div className="bg-surface-sub border border-border rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="quick-add-calories" className="text-xs font-semibold text-foreground">
                Calories (kcal)
              </label>
              <button
                type="button"
                onClick={handleSyncToMacros}
                aria-label="Sync to macros"
                className="tactile-press inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-2.5 py-1 rounded-full bg-card border border-border"
              >
                <RefreshCw
                  className={`w-2.5 h-2.5 ${isCalorieOverridden ? 'text-[var(--macro-calories)]' : ''}`}
                  aria-hidden="true"
                />
                <span>Sync to macros</span>
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="quick-add-calories"
                aria-label="Calories"
                type="number"
                step="any"
                value={calories}
                onChange={(e) => handleCaloriesChange(e.target.value)}
                onBlur={() => setTouched((prev) => ({ ...prev, calories: true }))}
                className="w-full px-3 py-2 text-base sm:text-sm font-semibold tabular-nums rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
              />
            </div>
            {touched.calories && parseFloat(calories) < 0 && (
              <p className="text-[11px] text-[var(--neutral-over)]">
                Negative calories will clamp to 0 on save.
              </p>
            )}
            {isCalorieOverridden && (
              <p className="text-[10px] text-[var(--macro-calories)] font-medium">
                Manual calorie override active (does not recalculate from macros)
              </p>
            )}
          </div>

          {/* Macro grid */}
          <div className="space-y-1.5">
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-surface-sub border border-border rounded-xl p-2.5">
                <label htmlFor="quick-add-protein" className="block text-[10px] font-semibold text-[var(--macro-protein)] mb-1">
                  Protein (g)
                </label>
                <input
                  id="quick-add-protein"
                  aria-label="Protein"
                  type="number"
                  step="any"
                  value={protein}
                  onChange={(e) => handleMacroChange('p', e.target.value)}
                  onBlur={() => setTouched((prev) => ({ ...prev, protein: true }))}
                  placeholder="0"
                  className="w-full px-2 py-1.5 text-base sm:text-xs font-semibold tabular-nums rounded-lg bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                />
              </div>

              <div className="bg-surface-sub border border-border rounded-xl p-2.5">
                <label htmlFor="quick-add-carbs" className="block text-[10px] font-semibold text-[var(--macro-carbs)] mb-1">
                  Carbs (g)
                </label>
                <input
                  id="quick-add-carbs"
                  aria-label="Carbs"
                  type="number"
                  step="any"
                  value={carbs}
                  onChange={(e) => handleMacroChange('c', e.target.value)}
                  onBlur={() => setTouched((prev) => ({ ...prev, carbs: true }))}
                  placeholder="0"
                  className="w-full px-2 py-1.5 text-base sm:text-xs font-semibold tabular-nums rounded-lg bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                />
              </div>

              <div className="bg-surface-sub border border-border rounded-xl p-2.5">
                <label htmlFor="quick-add-fat" className="block text-[10px] font-semibold text-[var(--macro-fat)] mb-1">
                  Fat (g)
                </label>
                <input
                  id="quick-add-fat"
                  aria-label="Fat"
                  type="number"
                  step="any"
                  value={fat}
                  onChange={(e) => handleMacroChange('f', e.target.value)}
                  onBlur={() => setTouched((prev) => ({ ...prev, fat: true }))}
                  placeholder="0"
                  className="w-full px-2 py-1.5 text-base sm:text-xs font-semibold tabular-nums rounded-lg bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                />
              </div>
            </div>
            {((touched.protein && parseFloat(protein) < 0) ||
              (touched.carbs && parseFloat(carbs) < 0) ||
              (touched.fat && parseFloat(fat) < 0)) && (
              <p className="text-[11px] text-[var(--neutral-over)] px-1">
                Negative macro values will clamp to 0 on save.
              </p>
            )}
          </div>

          {/* Optional Fiber */}
          <div className="space-y-1">
            <div className="bg-surface-sub border border-border rounded-xl p-2.5 flex items-center justify-between">
              <label htmlFor="quick-add-fiber" className="text-[11px] font-medium text-muted-foreground">
                Fiber (g, optional)
              </label>
              <input
                id="quick-add-fiber"
                aria-label="Fiber"
                type="number"
                step="any"
                value={fiber}
                onChange={(e) => setFiber(e.target.value)}
                onBlur={() => setTouched((prev) => ({ ...prev, fiber: true }))}
                placeholder="0"
                className="w-24 px-2 py-1 text-base sm:text-xs tabular-nums text-right rounded-lg bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
              />
            </div>
            {touched.fiber && parseFloat(fiber) < 0 && (
              <p className="text-[11px] text-[var(--neutral-over)] px-1">
                Negative fiber will clamp to 0 on save.
              </p>
            )}
          </div>

          {/* Error Message with Validation Shake */}
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

          {/* Submit Button */}
          <button
            type="submit"
            disabled={isSaving}
            className="tactile-press w-full py-2.5 px-4 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-xs"
          >
            <Zap className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{confirmHighCalories ? 'Confirm & Log' : 'Log Quick Add'}</span>
          </button>
        </form>
      </motion.div>
    </motion.div>
  );
}

export function QuickAddDrawer({ open, date, mealSlot, onClose }: QuickAddDrawerProps) {
  return (
    <AnimatePresence>
      {open && (
        <QuickAddContent
          key={`${date}-${mealSlot}`}
          date={date}
          mealSlot={mealSlot}
          onClose={onClose}
        />
      )}
    </AnimatePresence>
  );
}
