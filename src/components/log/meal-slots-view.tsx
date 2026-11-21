'use client';

import React, { useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, generateId } from '@/lib/db/opencalory-db';
import { useLoggerStore } from '@/stores/logger-store';
import {
  copyLogsFromDate,
  foodLogEntriesToRecipeIngredients,
  offsetIsoDate,
} from '@/lib/recipes/recipe-builder';
import { DEFAULT_RDA_MICROS, resolveGoalsForDate } from '@/lib/nutrition/goals';
import { FoodRowSkeleton } from '@/components/ui/skeleton';
import { CopyFromDateDrawer } from './copy-from-date-drawer';
import { RecipeBuilderModal } from '@/components/recipes/recipe-builder-modal';
import {
  SPRING_EXPRESSIVE,
  isTestEnvironment,
  triggerHaptic,
} from '@/lib/motion';
import type {
  CustomRecipe,
  CustomRecipeIngredient,
  FoodLogEntry,
  UserGoals,
} from '@/types/nutrition';
import {
  Plus,
  RotateCcw,
  Trash2,
  Check,
  ChevronDown,
  CopyPlus,
  Pencil,
  StickyNote,
  Calendar,
  ChefHat,
  CheckSquare,
  X,
} from 'lucide-react';

function formatEntryTime(timestamp: number): string | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatEntryAmount(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  return String(Number(amount.toFixed(1)));
}

function getTodayIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cloneEntrySnapshot(entry: FoodLogEntry): FoodLogEntry {
  return {
    ...entry,
    nutritionSnapshot: entry.nutritionSnapshot
      ? {
          ...entry.nutritionSnapshot,
          micros: entry.nutritionSnapshot.micros
            ? { ...entry.nutritionSnapshot.micros }
            : {},
        }
      : entry.nutritionSnapshot,
  };
}

const FALLBACK_GOALS: UserGoals = {
  id: 'active',
  dailyCalories: 2000,
  proteinG: 150,
  carbsG: 200,
  fatG: 65,
  fiberG: 30,
  micronutrientTargets: { ...DEFAULT_RDA_MICROS },
  mealSlots: [],
  updatedAt: 0,
};

export function MealSlotsView() {
  const activeDate = useLoggerStore((s) => s.activeDate);
  const openSheet = useLoggerStore((s) => s.openSheet);
  const setEditingEntry = useLoggerStore((s) => s.setEditingEntry);
  const showUndoToast = useLoggerStore((s) => s.showUndoToast);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const [isCopyDrawerOpen, setIsCopyDrawerOpen] = useState(false);
  const [selectionState, setSelectionState] = useState<{
    date: string;
    active: boolean;
    ids: string[];
  }>({
    date: activeDate,
    active: false,
    ids: [],
  });
  const [isCopyToDateOpen, setIsCopyToDateOpen] = useState(false);
  const [copyTargetDate, setCopyTargetDate] = useState<string>(() =>
    offsetIsoDate(activeDate, 1)
  );
  const [recipeSeedIngredients, setRecipeSeedIngredients] = useState<
    CustomRecipeIngredient[] | null
  >(null);
  const [isPreparingRecipe, setIsPreparingRecipe] = useState(false);
  const feedbackTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowTouchStartX = useRef<number | null>(null);

  React.useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  // Query today's logs
  const todayLogs = useLiveQuery(
    () => db.foodLogs.where('date').equals(activeDate).toArray(),
    [activeDate]
  );

  // Query yesterday's logs to detect Copy Yesterday availability
  const yesterdayDate = offsetIsoDate(activeDate, -1);
  const yesterdayLogs = useLiveQuery(
    () => db.foodLogs.where('date').equals(yesterdayDate).toArray(),
    [yesterdayDate]
  );

  // Query active goals and apply weekday calorie cycling for activeDate
  const userGoals = useLiveQuery(() => db.userGoals.get('active'), []);

  const activeGoals = useMemo(
    () => resolveGoalsForDate(userGoals ?? FALLBACK_GOALS, activeDate),
    [userGoals, activeDate]
  );
  const logs = useMemo(() => todayLogs ?? [], [todayLogs]);
  const sortedLogs = useMemo(
    () => [...logs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    [logs]
  );
  const yesterdayEntries = yesterdayLogs ?? [];

  // Compute daily totals
  let totalCalories = 0;
  let totalProtein = 0;
  let totalCarbs = 0;
  let totalFat = 0;
  let totalFiber = 0;

  for (const entry of logs) {
    if (entry.nutritionSnapshot) {
      totalCalories += Number(entry.nutritionSnapshot.calories) || 0;
      totalProtein += Number(entry.nutritionSnapshot.protein) || 0;
      totalCarbs += Number(entry.nutritionSnapshot.carbs) || 0;
      totalFat += Number(entry.nutritionSnapshot.fat) || 0;
      totalFiber += Number(entry.nutritionSnapshot.fiber) || 0;
    }
  }

  const remainingCal = Math.round(activeGoals.dailyCalories - totalCalories);

  const isSelectMode = selectionState.date === activeDate && selectionState.active;
  const selectedIdSet = useMemo(
    () => new Set(selectionState.date === activeDate ? selectionState.ids : []),
    [selectionState, activeDate]
  );
  const activeSelectedEntries = useMemo(
    () => (isSelectMode ? sortedLogs.filter((entry) => selectedIdSet.has(entry.id)) : []),
    [isSelectMode, sortedLogs, selectedIdSet]
  );
  const selectedTotalCalories = useMemo(
    () =>
      activeSelectedEntries.reduce(
        (sum, e) => sum + (Number(e.nutritionSnapshot?.calories) || 0),
        0
      ),
    [activeSelectedEntries]
  );

  const showCopyFeedback = (msg: string) => {
    setCopyFeedback(msg);
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = setTimeout(() => {
      setCopyFeedback(null);
      feedbackTimerRef.current = null;
    }, 2500);
  };

  const handleCopyYesterday = async () => {
    try {
      const { count, insertedIds } = await copyLogsFromDate(yesterdayDate, activeDate);
      if (count > 0) {
        triggerHaptic(10);
        showCopyFeedback(`Copied ${count} ${count === 1 ? 'item' : 'items'}`);
        showUndoToast({
          message: `Copied ${count} ${count === 1 ? 'item' : 'items'} from yesterday`,
          onUndo: async () => {
            if (insertedIds.length > 0) {
              await db.foodLogs.bulkDelete(insertedIds);
            }
          },
        });
      }
    } catch (err) {
      console.error("Failed to copy yesterday's logs:", err);
    }
  };

  const handleToggleSelectMode = () => {
    triggerHaptic(6);
    setIsCopyToDateOpen(false);
    setSelectionState((prev) => {
      const currentlyActive = prev.date === activeDate && prev.active;
      return {
        date: activeDate,
        active: !currentlyActive,
        ids: [],
      };
    });
  };

  const handleToggleEntrySelection = (entryId: string) => {
    triggerHaptic(6);
    setSelectionState((prev) => {
      const currentIds = prev.date === activeDate ? prev.ids : [];
      const exists = currentIds.includes(entryId);
      const nextIds = exists
        ? currentIds.filter((id) => id !== entryId)
        : [...currentIds, entryId];
      return {
        date: activeDate,
        active: true,
        ids: nextIds,
      };
    });
  };

  const handleToggleSelectAll = () => {
    triggerHaptic(6);
    setSelectionState((prev) => {
      const currentIds = prev.date === activeDate ? prev.ids : [];
      const allChecked =
        sortedLogs.length > 0 && sortedLogs.every((e) => currentIds.includes(e.id));
      return {
        date: activeDate,
        active: true,
        ids: allChecked ? [] : sortedLogs.map((e) => e.id),
      };
    });
  };

  const handleOpenSaveAsRecipe = async () => {
    if (activeSelectedEntries.length === 0 || isPreparingRecipe) return;
    setIsPreparingRecipe(true);
    triggerHaptic(8);
    try {
      const converted = await foodLogEntriesToRecipeIngredients(activeSelectedEntries);
      setRecipeSeedIngredients(converted);
    } catch (err) {
      console.error('Failed to prepare recipe ingredients:', err);
    } finally {
      setIsPreparingRecipe(false);
    }
  };

  const handleOpenCopyToDate = () => {
    triggerHaptic(6);
    const todayIso = getTodayIsoDate();
    setCopyTargetDate(activeDate < todayIso ? todayIso : offsetIsoDate(activeDate, 1));
    setIsCopyToDateOpen((prev) => !prev);
  };

  const handleCopySelectedToDate = async () => {
    if (activeSelectedEntries.length === 0 || !copyTargetDate.trim()) return;
    const ids = activeSelectedEntries.map((e) => e.id);
    const target = copyTargetDate.trim();
    try {
      const { count, insertedIds } = await copyLogsFromDate(activeDate, target, ids);
      triggerHaptic(10);
      setIsCopyToDateOpen(false);
      setSelectionState({ date: activeDate, active: false, ids: [] });
      if (count > 0) {
        showCopyFeedback(`Copied ${count} to ${target}`);
        showUndoToast({
          message: `Copied ${count} ${count === 1 ? 'item' : 'items'} to ${target}`,
          onUndo: async () => {
            if (insertedIds.length > 0) {
              await db.foodLogs.bulkDelete(insertedIds);
            }
          },
        });
      }
    } catch (err) {
      console.error('Failed to copy selected entries to date:', err);
    }
  };

  const handleDeleteSelected = async () => {
    if (activeSelectedEntries.length === 0) return;
    const snapshots = activeSelectedEntries.map(cloneEntrySnapshot);
    const idsToDelete = snapshots.map((s) => s.id);
    try {
      await db.foodLogs.bulkDelete(idsToDelete);
      triggerHaptic(12);
      setIsCopyToDateOpen(false);
      setSelectionState({ date: activeDate, active: false, ids: [] });
      showUndoToast({
        message: `Removed ${snapshots.length} ${snapshots.length === 1 ? 'entry' : 'entries'}`,
        onUndo: async () => {
          await db.foodLogs.bulkPut(snapshots);
        },
      });
    } catch (err) {
      console.error('Failed to delete selected entries:', err);
    }
  };

  const handleRecipeSaved = (saved: CustomRecipe) => {
    setSelectionState({ date: activeDate, active: false, ids: [] });
    setRecipeSeedIngredients(null);
    showCopyFeedback(`Saved "${saved.name}"`);
  };

  const handleDeleteEntry = async (entry: FoodLogEntry) => {
    const snapshot = cloneEntrySnapshot(entry);
    try {
      await db.foodLogs.delete(entry.id);
      triggerHaptic(12);
      setExpandedEntryId((prev) => (prev === entry.id ? null : prev));
      showUndoToast({
        message: `Removed ${entry.name}`,
        onUndo: async () => {
          await db.foodLogs.put(snapshot);
        },
      });
    } catch (err) {
      console.error('Failed to delete log entry:', err);
    }
  };

  const handleDuplicateEntry = async (entry: FoodLogEntry) => {
    try {
      await db.foodLogs.add({
        ...entry,
        id: generateId(),
        date: activeDate,
        createdAt: Date.now(),
      });
      triggerHaptic(10);
    } catch (err) {
      console.error('Failed to duplicate log entry:', err);
    }
  };

  const isLoadingLogs = todayLogs === undefined;

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-5 lg:gap-6 items-start animate-card-enter">
      {/* Left Sticky Daily Consumed Rail (Tablet & Desktop) / Full-Width Summary (Mobile) */}
      <aside
        aria-label="Daily nutrition totals"
        className="md:col-span-5 lg:col-span-4 md:sticky md:top-[max(1.5rem,env(safe-area-inset-top))] bg-card border border-border/50 rounded-2xl p-4 sm:p-5 grid grid-cols-1 gap-4"
      >
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="text-xs text-muted-foreground font-medium">Daily Consumed</span>
              <div className="text-2xl sm:text-3xl font-bold tabular-nums text-foreground mt-0.5">
                {Math.round(totalCalories).toLocaleString()}{' '}
                <span className="text-xs font-normal text-muted-foreground">
                  / {activeGoals.dailyCalories.toLocaleString()} kcal
                </span>
              </div>
            </div>
            <span
              className={`text-xs font-semibold tabular-nums px-2.5 py-1 rounded-full bg-surface-sub shrink-0 ${
                remainingCal < 0
                  ? 'text-[var(--neutral-over)]'
                  : 'text-[var(--macro-calories)]'
              }`}
            >
              {remainingCal < 0
                ? `+${Math.abs(remainingCal).toLocaleString()} surplus`
                : `${remainingCal.toLocaleString()} left`}
            </span>
          </div>

          <progress
            className="macro-progress progress-calories w-full h-2 block"
            max={Math.max(1, activeGoals.dailyCalories)}
            value={Math.min(activeGoals.dailyCalories, Math.max(0, Math.round(totalCalories)))}
            aria-label="Daily calorie progress"
          />
        </div>

        <div className="space-y-3 md:pt-3 md:border-t md:border-border/60">
          <div className="grid grid-cols-3 md:grid-cols-1 gap-2.5 sm:gap-3.5 md:gap-3">
            <div className="flex flex-col items-center text-center gap-1.5 min-w-0 md:grid md:grid-cols-[1fr_auto] md:items-baseline md:text-left md:gap-x-2 md:gap-y-1.5">
              <span className="order-1 text-xs text-muted-foreground font-medium">Protein</span>
              <progress
                className="order-2 md:order-3 md:col-span-2 macro-progress progress-protein w-full h-1.5 block"
                max={Math.max(1, activeGoals.proteinG)}
                value={Math.min(activeGoals.proteinG, Math.max(0, Math.round(totalProtein)))}
                aria-label="Protein progress"
              />
              <span className="order-3 md:order-2 text-[11px] sm:text-xs font-semibold tabular-nums text-[var(--macro-protein)] whitespace-nowrap md:text-right">
                {Math.round(totalProtein)}
                <span className="text-[11px] text-muted-foreground font-normal">
                  /{activeGoals.proteinG}g
                </span>
              </span>
            </div>

            <div className="flex flex-col items-center text-center gap-1.5 min-w-0 md:grid md:grid-cols-[1fr_auto] md:items-baseline md:text-left md:gap-x-2 md:gap-y-1.5">
              <span className="order-1 text-xs text-muted-foreground font-medium">Fat</span>
              <progress
                className="order-2 md:order-3 md:col-span-2 macro-progress progress-fat w-full h-1.5 block"
                max={Math.max(1, activeGoals.fatG)}
                value={Math.min(activeGoals.fatG, Math.max(0, Math.round(totalFat)))}
                aria-label="Fat progress"
              />
              <span className="order-3 md:order-2 text-[11px] sm:text-xs font-semibold tabular-nums text-[var(--macro-fat)] whitespace-nowrap md:text-right">
                {Math.round(totalFat)}
                <span className="text-[11px] text-muted-foreground font-normal">
                  /{activeGoals.fatG}g
                </span>
              </span>
            </div>

            <div className="flex flex-col items-center text-center gap-1.5 min-w-0 md:grid md:grid-cols-[1fr_auto] md:items-baseline md:text-left md:gap-x-2 md:gap-y-1.5">
              <span className="order-1 text-xs text-muted-foreground font-medium">Carbs</span>
              <progress
                className="order-2 md:order-3 md:col-span-2 macro-progress progress-carbs w-full h-1.5 block"
                max={Math.max(1, activeGoals.carbsG)}
                value={Math.min(activeGoals.carbsG, Math.max(0, Math.round(totalCarbs)))}
                aria-label="Carbs progress"
              />
              <span className="order-3 md:order-2 text-[11px] sm:text-xs font-semibold tabular-nums text-[var(--macro-carbs)] whitespace-nowrap md:text-right">
                {Math.round(totalCarbs)}
                <span className="text-[11px] text-muted-foreground font-normal">
                  /{activeGoals.carbsG}g
                </span>
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2.5 border-t border-border/60 text-xs tabular-nums">
            <span className="text-muted-foreground">Fiber</span>
            <span className="font-semibold text-[var(--macro-fiber)]">
              {Math.round(totalFiber)}g{' '}
              <span className="text-muted-foreground font-normal">/ {activeGoals.fiberG}g</span>
            </span>
          </div>
        </div>
      </aside>

      {/* Unified Logged Entries List */}
      <section aria-labelledby="food-log-entries-heading" className="md:col-span-7 lg:col-span-8 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
          <div className="flex items-baseline gap-2">
            <h2
              id="food-log-entries-heading"
              className="text-base font-bold tracking-tight text-foreground"
            >
              Logged Entries
            </h2>
            {sortedLogs.length > 0 && (
              <span className="text-xs font-medium text-muted-foreground tabular-nums">
                {sortedLogs.length} {sortedLogs.length === 1 ? 'item' : 'items'}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {copyFeedback && (
              <span className="animate-check-pop text-[11px] text-[var(--macro-carbs)] flex items-center gap-1 font-semibold">
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                {copyFeedback}
              </span>
            )}
            {isSelectMode && sortedLogs.length > 0 && (
              <button
                type="button"
                onClick={handleToggleSelectAll}
                className="touch-target tactile-press flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-sub hover:bg-surface-elevated text-xs text-foreground font-medium"
              >
                <span>
                  {activeSelectedEntries.length === sortedLogs.length ? 'Clear' : 'Select All'}
                </span>
              </button>
            )}
            {(sortedLogs.length > 0 || isSelectMode) && (
              <button
                type="button"
                onClick={handleToggleSelectMode}
                aria-pressed={isSelectMode}
                className={`touch-target tactile-press flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold ${
                  isSelectMode
                    ? 'bg-foreground text-background shadow-xs'
                    : 'bg-surface-sub hover:bg-surface-elevated text-foreground'
                }`}
              >
                {isSelectMode ? (
                  <>
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Cancel</span>
                  </>
                ) : (
                  <>
                    <CheckSquare className="w-3.5 h-3.5 text-[var(--macro-calories)]" aria-hidden="true" />
                    <span>Select</span>
                  </>
                )}
              </button>
            )}
            {!isSelectMode && sortedLogs.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic(6);
                  setIsCopyDrawerOpen(true);
                }}
                aria-label="Copy From Date"
                className="touch-target tactile-press flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-sub hover:bg-surface-elevated text-xs text-foreground font-medium"
              >
                <Calendar className="w-3.5 h-3.5 text-[var(--macro-calories)]" aria-hidden="true" />
                <span>Copy From Date</span>
              </button>
            )}
            {!isSelectMode && sortedLogs.length > 0 && yesterdayEntries.length > 0 && (
              <button
                type="button"
                onClick={handleCopyYesterday}
                aria-label="Copy Yesterday"
                className="touch-target tactile-press flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-sub hover:bg-surface-elevated text-xs text-foreground font-medium"
              >
                <RotateCcw className="w-3.5 h-3.5 text-[var(--macro-calories)]" aria-hidden="true" />
                <span>Copy Yesterday</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  ({yesterdayEntries.length})
                </span>
              </button>
            )}
            {!isSelectMode && sortedLogs.length > 0 && (
              <button
                type="button"
                onClick={() => openSheet('search')}
                aria-label="Add food"
                className="touch-target tactile-press flex items-center gap-1 px-3 py-1.5 rounded-full bg-surface-sub hover:bg-foreground hover:text-background text-xs font-semibold text-foreground"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Add</span>
              </button>
            )}
          </div>
        </div>

        {isLoadingLogs ? (
          <FoodRowSkeleton count={3} />
        ) : sortedLogs.length > 0 ? (
          <ul className="rounded-2xl bg-card border border-border/50 overflow-hidden divide-y divide-border/60">
            <AnimatePresence initial={false}>
            {sortedLogs.map((entry, idx) => {
              const entryTime = formatEntryTime(entry.createdAt);
              const isSelected = isSelectMode && selectedIdSet.has(entry.id);
              const isExpanded = !isSelectMode && expandedEntryId === entry.id;
              const micros = entry.nutritionSnapshot?.micros;
              const trimmedNote = entry.note?.trim();

              return (
                <motion.li
                  key={entry.id}
                  layout={!isTestEnvironment()}
                  initial={isTestEnvironment() ? false : { opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={isTestEnvironment() ? undefined : { opacity: 0, x: -32, scale: 0.97 }}
                  transition={{
                    ...SPRING_EXPRESSIVE,
                    delay: isTestEnvironment() ? 0 : Math.min(idx, 6) * 0.045,
                  }}
                  onTouchStart={(e) => {
                    rowTouchStartX.current = e.touches[0]?.clientX ?? null;
                  }}
                  onTouchEnd={(e) => {
                    if (isSelectMode || rowTouchStartX.current === null) return;
                    const dx =
                      (e.changedTouches[0]?.clientX ?? rowTouchStartX.current) -
                      rowTouchStartX.current;
                    rowTouchStartX.current = null;
                    if (dx < -48) setExpandedEntryId(entry.id);
                    else if (dx > 48 && isExpanded) setExpandedEntryId(null);
                  }}
                  className={`stagger-item transition-colors ${
                    isSelected ? 'bg-surface-sub/65' : 'hover:bg-surface-sub/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5 sm:py-3.5">
                    {isSelectMode && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleEntrySelection(entry.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select ${entry.name}`}
                        className="w-4 h-4 rounded accent-[var(--macro-calories)] shrink-0 cursor-pointer"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (isSelectMode) {
                          handleToggleEntrySelection(entry.id);
                        } else {
                          setExpandedEntryId((prev) =>
                            prev === entry.id ? null : entry.id
                          );
                        }
                      }}
                      aria-expanded={isSelectMode ? undefined : isExpanded}
                      className="min-w-0 flex-1 text-left group"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-semibold text-foreground truncate">
                          {entry.name}
                        </span>
                        {trimmedNote && (
                          <StickyNote
                            className="w-3 h-3 text-muted-foreground/75 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        {!isSelectMode && (
                          <ChevronDown
                            className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-150 ${
                              isExpanded
                                ? 'rotate-180 text-foreground'
                                : 'opacity-60 group-hover:opacity-100'
                            }`}
                            aria-hidden="true"
                          />
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground tabular-nums mt-0.5 truncate">
                        {formatEntryAmount(entry.amount)} {entry.unit}
                        {entryTime ? ` Â· ${entryTime}` : ''}
                      </div>
                    </button>

                    <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
                      <div className="text-right tabular-nums">
                        <div
                          className="text-sm font-bold"
                          style={{ color: 'var(--macro-calories)' }}
                        >
                          {Math.round(entry.nutritionSnapshot?.calories || 0)} kcal
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          <span className="text-[var(--macro-protein)]">
                            {Math.round(entry.nutritionSnapshot?.protein || 0)}P
                          </span>{' '}
                          Â·{' '}
                          <span className="text-[var(--macro-carbs)]">
                            {Math.round(entry.nutritionSnapshot?.carbs || 0)}C
                          </span>{' '}
                          Â·{' '}
                          <span className="text-[var(--macro-fat)]">
                            {Math.round(entry.nutritionSnapshot?.fat || 0)}F
                          </span>
                        </div>
                      </div>

                      {!isSelectMode && (
                        <button
                          type="button"
                          onClick={() => void handleDeleteEntry(entry)}
                          aria-label={`Delete ${entry.name}`}
                          className="touch-target tactile-press w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface-sub"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div
                    className="accordion-grid"
                    data-open={isExpanded ? 'true' : 'false'}
                    aria-hidden={!isExpanded}
                  >
                    <div className="accordion-inner">
                      <div className="px-4 pb-3 pt-1.5 sm:px-5 space-y-2 text-[11px] text-muted-foreground border-t border-border/40 bg-surface-sub/35">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
                            <span>
                              Fiber:{' '}
                              <strong className="text-foreground">
                                {Math.round((entry.nutritionSnapshot?.fiber ?? 0) * 10) / 10}g
                              </strong>
                            </span>
                            {micros?.sodiumMg !== undefined && (
                              <span>
                                Sodium:{' '}
                                <strong className="text-foreground">
                                  {Math.round(micros.sodiumMg)}mg
                                </strong>
                              </span>
                            )}
                            {micros?.potassiumMg !== undefined && (
                              <span>
                                Potassium:{' '}
                                <strong className="text-foreground">
                                  {Math.round(micros.potassiumMg)}mg
                                </strong>
                              </span>
                            )}
                            <span className="uppercase tracking-wider text-[10px]">
                              {entry.source.replace('_', ' ')}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              tabIndex={isExpanded ? 0 : -1}
                              onClick={() => {
                                triggerHaptic(8);
                                setEditingEntry(entry);
                              }}
                              className="touch-target tactile-press inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-card border border-border text-foreground font-medium hover:bg-surface-elevated"
                            >
                              <Pencil className="w-3 h-3" aria-hidden="true" />
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              tabIndex={isExpanded ? 0 : -1}
                              onClick={() => void handleDuplicateEntry(entry)}
                              className="touch-target tactile-press inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-card border border-border text-foreground font-medium hover:bg-surface-elevated"
                            >
                              <CopyPlus className="w-3 h-3" aria-hidden="true" />
                              <span>Log Again</span>
                            </button>
                          </div>
                        </div>

                        {trimmedNote && (
                          <div className="flex items-start gap-1.5 pt-1.5 border-t border-border/40 text-[11px] text-foreground/85">
                            <StickyNote
                              className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5"
                              aria-hidden="true"
                            />
                            <p className="leading-relaxed break-words whitespace-pre-wrap">
                              {trimmedNote}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.li>
              );
            })}
            </AnimatePresence>
          </ul>
        ) : (
          <div className="rounded-2xl bg-card border border-border/50 p-6 sm:p-8 text-center">
            <svg
              viewBox="0 0 64 64"
              className="w-12 h-12 mx-auto mb-3 text-muted-foreground/75"
              aria-hidden="true"
            >
              <circle
                cx="32"
                cy="34"
                r="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray="84 126"
                strokeLinecap="round"
                transform="rotate(150 32 34)"
              />
              <circle
                cx="32"
                cy="34"
                r="11"
                fill="none"
                stroke="var(--macro-calories)"
                strokeWidth="2"
                strokeOpacity="0.65"
              />
              <circle cx="32" cy="34" r="2.5" fill="var(--macro-calories)" />
            </svg>
            <p className="text-sm font-semibold text-foreground">No entries logged yet</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-[36ch] mx-auto">
              Search offline staples, scan a barcode, or copy yesterday&apos;s entries to build your log.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => {
                  triggerHaptic(6);
                  setIsCopyDrawerOpen(true);
                }}
                className="touch-target tactile-press inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-surface-sub hover:bg-surface-elevated text-xs font-semibold text-foreground"
              >
                <Calendar className="w-3.5 h-3.5 text-[var(--macro-calories)]" aria-hidden="true" />
                <span>Copy From Date</span>
              </button>
              {yesterdayEntries.length > 0 && (
                <button
                  type="button"
                  onClick={handleCopyYesterday}
                  aria-label="Copy Yesterday"
                  className="touch-target tactile-press inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-surface-sub hover:bg-surface-elevated text-xs font-semibold text-foreground"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-[var(--macro-calories)]" aria-hidden="true" />
                  <span>Copy Yesterday ({yesterdayEntries.length})</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => openSheet('search')}
                className="touch-target tactile-press inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-foreground text-background text-xs font-semibold hover:opacity-90"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Log Food</span>
              </button>
            </div>
          </div>
        )}

        {/* Sticky Multi-Select Action Bar */}
        {isSelectMode && activeSelectedEntries.length > 0 && (
          <div
            role="region"
            aria-label="Multi-select actions"
            data-testid="multi-select-action-bar"
            className="sticky bottom-[calc(8.75rem+env(safe-area-inset-bottom))] sm:bottom-[calc(9.25rem+env(safe-area-inset-bottom))] z-30 surface-elevated-sheet rounded-2xl p-3 sm:p-3.5 space-y-2.5 animate-sheet-in"
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-foreground tabular-nums">
                {activeSelectedEntries.length} selected Â·{' '}
                <span className="text-[var(--macro-calories)]">
                  {Math.round(selectedTotalCalories).toLocaleString()} kcal
                </span>
              </span>
              <button
                type="button"
                onClick={handleToggleSelectMode}
                className="tactile-press text-[11px] font-medium text-muted-foreground hover:text-foreground px-2 py-0.5 rounded-full"
              >
                Cancel
              </button>
            </div>

            {isCopyToDateOpen && (
              <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-surface-sub border border-border/60">
                <label
                  htmlFor="multi-copy-target-date"
                  className="text-[11px] font-semibold text-foreground shrink-0"
                >
                  Target Date
                </label>
                <div className="flex items-center gap-2 flex-1 justify-end">
                  <input
                    id="multi-copy-target-date"
                    aria-label="Target date"
                    type="date"
                    value={copyTargetDate}
                    onChange={(e) => setCopyTargetDate(e.target.value)}
                    className="px-2.5 py-1 text-base sm:text-xs font-medium tabular-nums rounded-lg bg-card border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCopySelectedToDate()}
                    className="touch-target tactile-press px-3 py-1.5 rounded-full bg-foreground text-background text-[11px] font-semibold hover:opacity-90 tabular-nums shrink-0"
                  >
                    Confirm Copy ({activeSelectedEntries.length})
                  </button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleOpenSaveAsRecipe()}
                disabled={isPreparingRecipe}
                className="touch-target tactile-press inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-foreground text-background text-xs font-semibold hover:opacity-90 disabled:opacity-50"
              >
                <ChefHat className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Save as Recipe</span>
              </button>

              <button
                type="button"
                onClick={handleOpenCopyToDate}
                aria-expanded={isCopyToDateOpen}
                className="touch-target tactile-press inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-surface-sub border border-border/60 hover:bg-card text-foreground text-xs font-semibold"
              >
                <CopyPlus className="w-3.5 h-3.5 text-[var(--macro-calories)]" aria-hidden="true" />
                <span>Copy to Date...</span>
              </button>

              <button
                type="button"
                onClick={() => void handleDeleteSelected()}
                className="touch-target tactile-press inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-surface-sub border border-border/60 hover:bg-card text-foreground text-xs font-semibold ml-auto"
              >
                <Trash2 className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
                <span>Delete Selected</span>
              </button>
            </div>
          </div>
        )}
      </section>

      <CopyFromDateDrawer
        open={isCopyDrawerOpen}
        targetDate={activeDate}
        onClose={() => setIsCopyDrawerOpen(false)}
      />

      <RecipeBuilderModal
        isOpen={Boolean(recipeSeedIngredients)}
        initialIngredients={recipeSeedIngredients}
        onClose={() => setRecipeSeedIngredients(null)}
        onSaved={handleRecipeSaved}
      />
    </div>
  );
}
