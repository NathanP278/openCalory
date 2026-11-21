'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, generateId } from '@/lib/db/opencalory-db';
import { useLoggerStore } from '@/stores/logger-store';
import { DEFAULT_RDA_MICROS, resolveGoalsForDate } from '@/lib/nutrition/goals';
import { aggregateDailySummary } from '@/lib/nutrition/daily-summary';
import { computeAdaptiveTdee } from '@/lib/nutrition/adaptive-tdee';
import { computeRangeAnalytics } from '@/lib/nutrition/analytics';
import { formatWeight } from '@/components/trends/chart-utils';
import { MacroBentoGrid, type DayNutritionPoint } from '@/components/dashboard/macro-bento-grid';
import {
  HabitsAnalyticsGrid,
  type LoggedDayDot,
} from '@/components/dashboard/habits-analytics-grid';
import { MicronutrientPanel } from '@/components/dashboard/micronutrient-panel';
import { AppShell } from '@/components/shell/app-shell';
import { SettingsHeaderLink } from '@/components/shell/settings-header-link';
import { DatePickerPopover } from '@/components/log/date-picker-popover';
import { FoodRowSkeleton } from '@/components/ui/skeleton';
import {
  PageStagger,
  ScrollReveal,
  StaggerItem,
} from '@/components/motion/motion-primitives';
import {
  SPRING_EXPRESSIVE,
  isTestEnvironment,
  runViewTransition,
  triggerHaptic,
} from '@/lib/motion';
import type { FoodLogEntry, UserGoals } from '@/types/nutrition';
import {
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  Pencil,
  Plus,
  RotateCcw,
  Scale,
  SlidersHorizontal,
  Sparkles,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';

function getTodayIsoDate(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function offsetIsoDate(iso: string, dayOffset: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + dayOffset);
  const nextY = date.getFullYear();
  const nextM = String(date.getMonth() + 1).padStart(2, '0');
  const nextD = String(date.getDate()).padStart(2, '0');
  return `${nextY}-${nextM}-${nextD}`;
}

function formatUpperHeaderDate(iso: string): { kicker: string; isToday: boolean } {
  const today = getTodayIsoDate();
  const isToday = iso === today;
  const [y, m, d] = iso.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const formatted = dateObj
    .toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    })
    .toUpperCase();

  return { kicker: formatted, isToday };
}

function formatEntryTime(timestamp: number): string | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatEntryAmount(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  return String(Number(amount.toFixed(1)));
}

function computeRollingWeeklySummary(logs: FoodLogEntry[], goals: UserGoals) {
  const loggedDays = new Set(logs.map((l) => l.date)).size;
  if (loggedDays <= 1) {
    return aggregateDailySummary(logs, goals);
  }
  const factor = 1 / loggedDays;
  const scaled: FoodLogEntry[] = logs.map((l) => {
    const snap = l.nutritionSnapshot;
    const scaledMicros: Record<string, number> = {};
    if (snap?.micros) {
      for (const [k, v] of Object.entries(snap.micros)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          scaledMicros[k] = v * factor;
        }
      }
    }
    return {
      ...l,
      nutritionSnapshot: {
        calories: (snap?.calories ?? 0) * factor,
        protein: (snap?.protein ?? 0) * factor,
        carbs: (snap?.carbs ?? 0) * factor,
        fat: (snap?.fat ?? 0) * factor,
        fiber: (snap?.fiber ?? 0) * factor,
        micros: scaledMicros,
      },
    };
  });
  return aggregateDailySummary(scaled, goals);
}

export default function HomePage() {
  const activeDate = useLoggerStore((s) => s.activeDate);
  const dateDirection = useLoggerStore((s) => s.dateDirection);
  const setActiveDate = useLoggerStore((s) => s.setActiveDate);
  const openSheet = useLoggerStore((s) => s.openSheet);
  const setEditingEntry = useLoggerStore((s) => s.setEditingEntry);
  const showUndoToast = useLoggerStore((s) => s.showUndoToast);
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const headerTouchStartX = useRef<number | null>(null);

  const windowStartDate = useMemo(() => offsetIsoDate(activeDate, -29), [activeDate]);

  // Query 30 days ending on activeDate so daily metrics, 7-day stacked bars, and 30-day logging heatmap stay synced
  const rangeLogs = useLiveQuery(
    async () => {
      const rows = await db.foodLogs
        .where('date')
        .between(windowStartDate, activeDate, true, true)
        .toArray();
      setHasLoadedOnce(true);
      return rows;
    },
    [windowStartDate, activeDate]
  );

  const userGoals = useLiveQuery(() => db.userGoals.get('active'), []);
  const weightLogs = useLiveQuery(() => db.weightLogs.toArray(), []);
  const [targetsPromptDismissed, setTargetsPromptDismissed] = useState(true);

  useEffect(() => {
    try {
      const dismissed = window.localStorage?.getItem('opencalory-onboard-targets-dismissed') === '1';
      setTargetsPromptDismissed(dismissed);
    } catch {
      setTargetsPromptDismissed(false);
    }
  }, []);

  const showFirstRunTargetsCard =
    !targetsPromptDismissed &&
    userGoals !== undefined &&
    (!userGoals || !userGoals.updatedAt || userGoals.updatedAt === 0);

  const fallbackGoals: UserGoals = useMemo(
    () => ({
      id: 'active',
      dailyCalories: 2000,
      proteinG: 150,
      carbsG: 200,
      fatG: 65,
      fiberG: 30,
      micronutrientTargets: { ...DEFAULT_RDA_MICROS },
      mealSlots: [],
      weightUnit: 'kg',
      updatedAt: 0,
    }),
    []
  );

  const activeGoals = userGoals ?? fallbackGoals;
  const weightUnit: 'kg' | 'lb' = activeGoals.weightUnit === 'lb' ? 'lb' : 'kg';
  const resolvedActiveGoals = useMemo(
    () => resolveGoalsForDate(activeGoals, activeDate),
    [activeGoals, activeDate]
  );

  const safeRangeLogs = useMemo(() => rangeLogs ?? [], [rangeLogs]);
  const safeWeightLogs = useMemo(() => weightLogs ?? [], [weightLogs]);

  const adaptive = useMemo(
    () =>
      computeAdaptiveTdee({
        weights: safeWeightLogs,
        foodLogs: safeRangeLogs,
        goals: activeGoals,
        today: activeDate,
      }),
    [safeWeightLogs, safeRangeLogs, activeGoals, activeDate]
  );

  const weekStartDate = useMemo(() => offsetIsoDate(activeDate, -6), [activeDate]);

  const logsByDate = useMemo(() => {
    const grouped = new Map<string, FoodLogEntry[]>();
    for (const entry of safeRangeLogs) {
      const bucket = grouped.get(entry.date);
      if (bucket) {
        bucket.push(entry);
      } else {
        grouped.set(entry.date, [entry]);
      }
    }
    return grouped;
  }, [safeRangeLogs]);

  const activeLogs = useMemo(
    () => logsByDate.get(activeDate) ?? [],
    [logsByDate, activeDate]
  );

  const weeklyLogs = useMemo(
    () => safeRangeLogs.filter((l) => l.date >= weekStartDate && l.date <= activeDate),
    [safeRangeLogs, weekStartDate, activeDate]
  );

  const summary = useMemo(
    () => aggregateDailySummary(activeLogs, resolvedActiveGoals),
    [activeLogs, resolvedActiveGoals]
  );

  const rolling7d = useMemo(
    () =>
      computeRangeAnalytics(
        safeRangeLogs,
        activeGoals,
        activeDate,
        7,
        adaptive.latestTrendKg
      ),
    [safeRangeLogs, activeGoals, activeDate, adaptive.latestTrendKg]
  );

  const weeklyMicroSummary = useMemo(
    () => computeRollingWeeklySummary(weeklyLogs, activeGoals),
    [weeklyLogs, activeGoals]
  );

  // Build 7-day sequence ending on activeDate (Pics 3 & 4)
  const weeklyDays: DayNutritionPoint[] = useMemo(() => {
    const days: DayNutritionPoint[] = [];
    for (let i = -6; i <= 0; i++) {
      const iso = offsetIsoDate(activeDate, i);
      const dayEntries = logsByDate.get(iso) ?? [];
      const dayGoals = resolveGoalsForDate(activeGoals, iso);
      const [y, m, d] = iso.split('-').map(Number);
      const dayLetter = new Date(y, m - 1, d)
        .toLocaleDateString('en-US', { weekday: 'narrow' })
        .toUpperCase();

      let cal = 0;
      let pro = 0;
      let fat = 0;
      let carbs = 0;
      for (const e of dayEntries) {
        cal += Number(e.nutritionSnapshot?.calories) || 0;
        pro += Number(e.nutritionSnapshot?.protein) || 0;
        fat += Number(e.nutritionSnapshot?.fat) || 0;
        carbs += Number(e.nutritionSnapshot?.carbs) || 0;
      }

      days.push({
        date: iso,
        dayLetter,
        calories: Math.round(cal),
        protein: Math.round(pro),
        fat: Math.round(fat),
        carbs: Math.round(carbs),
        caloriesTarget: dayGoals.dailyCalories,
        proteinTarget: dayGoals.proteinG,
        fatTarget: dayGoals.fatG,
        carbsTarget: dayGoals.carbsG,
        isSelected: iso === activeDate,
      });
    }
    return days;
  }, [activeDate, logsByDate, activeGoals]);

  // Build 30-day logging dots ending on activeDate (Pic 1 Habits)
  const thirtyDayDots: LoggedDayDot[] = useMemo(() => {
    const dots: LoggedDayDot[] = [];
    for (let i = -29; i <= 0; i++) {
      const iso = offsetIsoDate(activeDate, i);
      const entries = logsByDate.get(iso) ?? [];
      const dayTarget = resolveGoalsForDate(activeGoals, iso).dailyCalories;
      const cal = entries.reduce(
        (sum, e) => sum + (Number(e.nutritionSnapshot?.calories) || 0),
        0
      );
      const intensity: 'none' | 'partial' | 'logged' =
        entries.length === 0
          ? 'none'
          : dayTarget > 0 && cal < dayTarget * 0.5
            ? 'partial'
            : 'logged';
      dots.push({
        date: iso,
        hasLogs: entries.length > 0,
        intensity,
        calories: Math.round(cal),
        targetCalories: dayTarget,
      });
    }
    return dots;
  }, [activeDate, logsByDate, activeGoals]);

  const sortedLogs = useMemo(
    () => [...activeLogs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    [activeLogs]
  );

  const handleDeleteEntry = async (entry: FoodLogEntry) => {
    const snapshot: FoodLogEntry = {
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

  const dateInfo = formatUpperHeaderDate(activeDate);

  const handlePrevDay = () => {
    triggerHaptic(8);
    runViewTransition(() => setActiveDate(offsetIsoDate(activeDate, -1)), {
      direction: 'backward',
    });
  };
  const handleNextDay = () => {
    triggerHaptic(8);
    runViewTransition(() => setActiveDate(offsetIsoDate(activeDate, 1)), {
      direction: 'forward',
    });
  };
  const handleToday = () => {
    triggerHaptic(8);
    const today = getTodayIsoDate();
    runViewTransition(() => setActiveDate(today), {
      direction: today > activeDate ? 'forward' : today < activeDate ? 'backward' : null,
    });
  };
  const handleSelectDate = (iso: string) => {
    triggerHaptic(8);
    runViewTransition(() => setActiveDate(iso), {
      direction: iso > activeDate ? 'forward' : iso < activeDate ? 'backward' : null,
    });
  };

  const handleHeaderTouchStart = (e: React.TouchEvent) => {
    headerTouchStartX.current = e.touches[0]?.clientX ?? null;
  };

  const handleHeaderTouchEnd = (e: React.TouchEvent) => {
    if (headerTouchStartX.current === null) return;
    const endX = e.changedTouches[0]?.clientX ?? headerTouchStartX.current;
    const dx = endX - headerTouchStartX.current;
    headerTouchStartX.current = null;
    if (Math.abs(dx) < 48) return;
    if (dx > 0) handlePrevDay();
    else handleNextDay();
  };

  const isLoadingLogs = hasLoadedOnce && rangeLogs === undefined;
  const dateSlideClass =
    dateDirection === 'forward'
      ? 'slide-enter-right'
      : dateDirection === 'backward'
        ? 'slide-enter-left'
        : '';

  return (
    <AppShell>
      <PageStagger className="flex flex-col gap-5 sm:gap-7 px-4 sm:px-6 lg:px-8 pt-3 sm:pt-6 pb-8">
        {/* Clean MacroFactor Header (swipeable horizontally on mobile, zero layout shift on day switch) */}
        <StaggerItem>
        <header
          onTouchStart={handleHeaderTouchStart}
          onTouchEnd={handleHeaderTouchEnd}
          className="flex items-center justify-between gap-2.5"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2.5">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground truncate">
                Dashboard
              </h1>
              <span className="text-xs font-medium text-muted-foreground hidden sm:inline">
                openCalory
              </span>
            </div>
            <div className="flex items-center gap-1.5 min-w-0 mt-1">
              <DatePickerPopover
                activeDate={activeDate}
                onSelectDate={handleSelectDate}
                align="left"
                trigger={
                  <button
                    type="button"
                    title="Choose date"
                    className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full liquid-pill-glass text-[11px] font-medium text-muted-foreground hover:text-foreground max-w-full"
                  >
                    <Calendar
                      className="w-3 h-3 text-muted-foreground shrink-0"
                      aria-hidden="true"
                    />
                    <span className="truncate" suppressHydrationWarning>
                      {dateInfo.kicker}
                    </span>
                  </button>
                }
              />
              {!dateInfo.isToday && (
                <button
                  type="button"
                  onClick={handleToday}
                  className="touch-target inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold liquid-pill-glass text-foreground shrink-0"
                >
                  <RotateCcw className="w-2.5 h-2.5" aria-hidden="true" />
                  <span>Today</span>
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              onClick={handlePrevDay}
              aria-label="Previous day"
              className="touch-target w-11 h-11 sm:w-9 sm:h-9 rounded-full flex items-center justify-center liquid-pill-glass text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleNextDay}
              aria-label="Next day"
              className="touch-target w-11 h-11 sm:w-9 sm:h-9 rounded-full flex items-center justify-center liquid-pill-glass text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <SettingsHeaderLink />
          </div>
        </header>
        </StaggerItem>

        {/* First-Run Target Calibration Banner (dismissible, non-blocking) */}
        <AnimatePresence>
        {showFirstRunTargetsCard && (
          <motion.div
            key="first-run-targets-banner"
            initial={isTestEnvironment() ? false : { opacity: 0, y: -12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={isTestEnvironment() ? undefined : { opacity: 0, y: -10, scale: 0.96 }}
            transition={SPRING_EXPRESSIVE}
            data-testid="first-run-targets-banner"
            className="bg-card border border-border rounded-2xl px-4 py-3.5 flex flex-wrap items-center justify-between gap-3"
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-full liquid-pill-glass flex items-center justify-center text-foreground shrink-0">
                <SlidersHorizontal className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-foreground">
                  Calibrate your daily targets
                </p>
                <p className="text-[11px] text-muted-foreground leading-snug">
                  You&apos;re starting on the 2,000 kcal default. Personalize your calories &amp; macros in 10 seconds.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Link
                href="/settings"
                onClick={() => triggerHaptic(8)}
                className="touch-target px-4 py-2 rounded-full liquid-pill-primary text-xs font-semibold"
              >
                Set My Targets
              </Link>
              <button
                type="button"
                aria-label="Dismiss target calibration prompt"
                onClick={() => {
                  triggerHaptic(6);
                  setTargetsPromptDismissed(true);
                  try {
                    window.localStorage?.setItem('opencalory-onboard-targets-dismissed', '1');
                  } catch {
                    // Ignore storage errors
                  }
                }}
                className="touch-target tactile-press w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface-sub"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </motion.div>
        )}
        </AnimatePresence>

        <div style={{ viewTransitionName: 'date-stage' }} className="space-y-5 sm:space-y-6">
          {/* Top Responsive Bento Workspace: Hero (left) + Insights & Habits (right on tablet/laptop) */}
          <div
            key={`bento-${activeDate}`}
            className={`grid grid-cols-1 md:grid-cols-12 gap-4 sm:gap-5 lg:gap-6 md:items-stretch ${dateSlideClass}`}
          >
            <StaggerItem className="md:col-span-6 lg:col-span-5 flex">
              <MacroBentoGrid
                summary={summary}
                weeklyDays={weeklyDays}
                onSelectDate={handleSelectDate}
                className="w-full"
              />
            </StaggerItem>

            <StaggerItem className="md:col-span-6 lg:col-span-7">
              <HabitsAnalyticsGrid
                summary={summary}
                weeklyDays={weeklyDays}
                thirtyDayDots={thirtyDayDots}
                onSelectDate={handleSelectDate}
              />
            </StaggerItem>
          </div>

          {/* Bottom Workspace: Logged Entries + Quick Tools (left) | Micronutrient Targets (right) */}
          <ScrollReveal
            className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-5 lg:gap-6 items-start"
          >
            {/* Left Column: Quick Coaching Strip + Logged Entries (absorbs vertical slack beside Micronutrients) */}
            <div className="lg:col-span-7 space-y-5 sm:space-y-6">
              {/* Contextual Coaching & Body Strip: AI Meal Ideas + Weight Trend */}
              <div
                data-testid="dashboard-quick-tools"
                className="grid grid-cols-2 gap-2.5 sm:gap-4"
              >
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic(8);
                    openSheet('meal-ideas');
                  }}
                  className="touch-target tactile-press macro-card-interactive bg-card border border-border rounded-2xl p-2.5 sm:p-4 text-left flex items-center gap-2 sm:gap-3 min-w-0"
                >
                  <span className="w-8 h-8 sm:w-9 sm:h-9 rounded-full liquid-pill-glass flex items-center justify-center text-foreground shrink-0">
                    <Sparkles className="w-3.5 h-3.5 sm:w-4 sm:h-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs sm:text-sm font-bold text-foreground truncate">
                      AI Meal Ideas
                    </span>
                    <span className="block text-[11px] text-muted-foreground truncate tabular-nums">
                      {summary.calories.remaining > 0
                        ? `${Math.round(summary.calories.remaining).toLocaleString('en-US')} kcal left`
                        : 'Fill remaining macros'}
                    </span>
                  </span>
                </button>

                <div className="macro-card-interactive bg-card border border-border rounded-2xl p-2.5 sm:p-4 flex items-center justify-between gap-1.5 sm:gap-2 min-w-0">
                  <Link
                    href="/trends"
                    onClick={() => triggerHaptic(8)}
                    title={
                      rolling7d.rolling7dSummary.loggedDays > 0
                        ? `7D avg ${Math.round(rolling7d.avgCalories).toLocaleString('en-US')} kcal â€” Open Trends`
                        : 'Open Trends'
                    }
                    className="touch-target tactile-press flex items-center gap-2 sm:gap-3 min-w-0 flex-1"
                  >
                    <span className="w-8 h-8 sm:w-9 sm:h-9 rounded-full liquid-pill-glass flex items-center justify-center text-foreground shrink-0">
                      <Scale className="w-3.5 h-3.5 sm:w-4 sm:h-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs sm:text-sm font-bold text-foreground whitespace-nowrap">
                        {adaptive.latestTrendKg !== null
                          ? formatWeight(adaptive.latestTrendKg, weightUnit)
                          : adaptive.latestScaleKg !== null
                            ? formatWeight(adaptive.latestScaleKg, weightUnit)
                            : 'Weight'}
                      </span>
                      <span className="block text-[11px] text-muted-foreground whitespace-nowrap">
                        {adaptive.latestTrendKg !== null
                          ? 'EMA trend'
                          : adaptive.latestScaleKg !== null
                            ? 'Latest scale'
                            : 'Trends'}
                      </span>
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic(8);
                      openSheet('weight');
                    }}
                    aria-label="Log weigh-in"
                    title="Log weigh-in"
                    className="touch-target w-7 h-7 sm:w-9 sm:h-9 rounded-full liquid-pill-glass text-muted-foreground hover:text-foreground inline-flex items-center justify-center shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5 sm:w-4 sm:h-4" aria-hidden="true" />
                  </button>
                </div>
              </div>

              {/* Logged Entries Section */}
              <section aria-labelledby="logged-entries-heading" className="space-y-3">
              <div className="flex items-center justify-between gap-2 px-0.5">
                <div className="flex items-baseline gap-2">
                  <h2
                    id="logged-entries-heading"
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

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => openSheet('search')}
                    aria-label="Add food"
                    className="touch-target flex items-center gap-1 px-3 py-1 rounded-full liquid-pill-glass text-xs font-semibold text-foreground"
                  >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Add</span>
                  </button>
                  <Link
                    href="/log"
                    className="touch-target py-1 px-1.5 -mr-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    See All
                  </Link>
                </div>
              </div>

              {isLoadingLogs ? (
                <FoodRowSkeleton count={3} />
              ) : sortedLogs.length > 0 ? (
                <ul className="rounded-2xl bg-card border border-border/50 overflow-hidden divide-y divide-border/60">
                  <AnimatePresence initial={false}>
                  {sortedLogs.map((log, idx) => {
                    const entryTime = formatEntryTime(log.createdAt);
                    const isExpanded = expandedEntryId === log.id;
                    const micros = log.nutritionSnapshot?.micros;
                    const trimmedNote = log.note?.trim();

                    return (
                      <motion.li
                        key={log.id}
                        layout={!isTestEnvironment()}
                        initial={isTestEnvironment() ? false : { opacity: 0, y: 14 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={isTestEnvironment() ? undefined : { opacity: 0, x: -28, scale: 0.97 }}
                        transition={{
                          ...SPRING_EXPRESSIVE,
                          delay: isTestEnvironment() ? 0 : Math.min(idx, 5) * 0.04,
                        }}
                        className="hover:bg-surface-sub/40 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-[18px] sm:py-3.5">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedEntryId((prev) =>
                                prev === log.id ? null : log.id
                              )
                            }
                            aria-expanded={isExpanded}
                            className="min-w-0 flex-1 text-left group"
                          >
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-semibold text-foreground truncate">
                                {log.name}
                              </span>
                              {trimmedNote && (
                                <StickyNote
                                  className="w-3 h-3 text-muted-foreground/75 shrink-0"
                                  aria-hidden="true"
                                />
                              )}
                              <ChevronDown
                                className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-150 ${
                                  isExpanded ? 'rotate-180 text-foreground' : 'opacity-60 group-hover:opacity-100'
                                }`}
                                aria-hidden="true"
                              />
                            </div>
                            <div className="text-xs text-muted-foreground tabular-nums mt-0.5 truncate">
                              {formatEntryAmount(log.amount)} {log.unit}
                              {entryTime ? ` Â· ${entryTime}` : ''}
                            </div>
                          </button>

                          <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
                            <div className="text-right tabular-nums">
                              <div
                                className="text-sm font-bold"
                                style={{ color: 'var(--macro-calories)' }}
                              >
                                {Math.round(log.nutritionSnapshot?.calories ?? 0).toLocaleString()} kcal
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                <span className="text-[var(--macro-protein)]">
                                  {Math.round(log.nutritionSnapshot?.protein ?? 0).toLocaleString()}P
                                </span>{' '}
                                Â·{' '}
                                <span className="text-[var(--macro-carbs)]">
                                  {Math.round(log.nutritionSnapshot?.carbs ?? 0).toLocaleString()}C
                                </span>{' '}
                                Â·{' '}
                                <span className="text-[var(--macro-fat)]">
                                  {Math.round(log.nutritionSnapshot?.fat ?? 0).toLocaleString()}F
                                </span>
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => void handleDeleteEntry(log)}
                              aria-label={`Delete ${log.name}`}
                              className="touch-target tactile-press ml-0.5 w-8 h-8 rounded-full border border-transparent hover:border-border/60 flex items-center justify-center text-muted-foreground/75 hover:text-foreground hover:bg-surface-sub transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        </div>

                        <div
                          className="accordion-grid"
                          data-open={isExpanded ? 'true' : 'false'}
                          aria-hidden={!isExpanded}
                        >
                          <div className="accordion-inner">
                            <div className="px-4 pb-3 pt-1.5 sm:px-[18px] space-y-2 text-[11px] text-muted-foreground border-t border-border/40 bg-surface-sub/35">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
                                  <span>
                                    Fiber:{' '}
                                    <strong className="text-foreground">
                                      {Math.round((log.nutritionSnapshot?.fiber ?? 0) * 10) / 10}g
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
                                    {log.source.replace('_', ' ')}
                                  </span>
                                </div>

                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    type="button"
                                    tabIndex={isExpanded ? 0 : -1}
                                    onClick={() => {
                                      triggerHaptic(8);
                                      setEditingEntry(log);
                                    }}
                                    className="touch-target inline-flex items-center gap-1 px-2.5 py-1 rounded-full liquid-pill-glass text-foreground font-medium"
                                  >
                                    <Pencil className="w-3 h-3" aria-hidden="true" />
                                    <span>Edit</span>
                                  </button>
                                  <button
                                    type="button"
                                    tabIndex={isExpanded ? 0 : -1}
                                    onClick={() => void handleDuplicateEntry(log)}
                                    className="touch-target inline-flex items-center gap-1 px-2.5 py-1 rounded-full liquid-pill-glass text-foreground font-medium"
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
                  <p className="text-xs text-muted-foreground mt-1 max-w-[34ch] mx-auto">
                    Search offline staples, scan a barcode, or snap a meal photo to log your day.
                  </p>
                  <button
                    type="button"
                    onClick={() => openSheet('search')}
                    className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-full liquid-pill-primary text-xs font-semibold"
                  >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Log Food</span>
                  </button>
                </div>
              )}
              </section>
            </div>

            {/* Micronutrient Targets Panel */}
            <div className="lg:col-span-5 lg:sticky lg:top-[max(1.5rem,env(safe-area-inset-top))]">
              <MicronutrientPanel
                micros={summary.micros}
                weeklyMicros={weeklyMicroSummary.micros}
                netCarbsG={summary.netCarbsG}
                weeklyNetCarbsG={weeklyMicroSummary.netCarbsG}
                potassiumSodiumRatio={summary.potassiumSodiumRatio}
                weeklyPotassiumSodiumRatio={weeklyMicroSummary.potassiumSodiumRatio}
                todayLogs={activeLogs}
                weeklyLogs={weeklyLogs}
              />
            </div>
          </ScrollReveal>
        </div>
      </PageStagger>
    </AppShell>
  );
}
