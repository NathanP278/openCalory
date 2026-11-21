"use client";

import React, { useState, useEffect, useMemo } from 'react';
import {
  Calculator,
  Check,
  Flame,
  Dumbbell,
  Wheat,
  Droplets,
  Leaf,
  RefreshCw,
  ChevronDown,
  CalendarRange,
  SlidersHorizontal,
  RotateCcw,
} from 'lucide-react';
import { db } from '@/lib/db/opencalory-db';
import {
  calculateMifflinStJeorTargets,
  DEFAULT_RDA_MICROS,
  ACTIVITY_LEVELS,
  WEEKDAY_KEYS,
  computeWeeklyScheduleAverage,
  buildCyclingPreset,
} from '@/lib/nutrition/goals';
import {
  RDA_MICRONUTRIENT_METADATA,
  EXTENDED_NUTRIENT_METADATA,
  DEFAULT_EXTENDED_TARGETS,
} from '@/lib/nutrition/daily-summary';
import { triggerHaptic } from '@/lib/motion';
import type {
  DailyMacroTargets,
  UserGoals,
  UserProfile,
  WeekdayKey,
} from '@/types/nutrition';

const GOAL_RATE_PRESETS = [
  { value: -500, label: '-500' },
  { value: -250, label: '-250' },
  { value: 0, label: '0' },
  { value: 250, label: '+250' },
  { value: 500, label: '+500' },
];

const WEEKDAY_LABELS: Record<WeekdayKey, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

const EXTENDED_BOUND_KEYS = [
  'saturatedFatG',
  'addedSugarG',
  'cholesterolMg',
  'caffeineMg',
] as const;

function buildDefaultMicroTargets(): Record<string, number> {
  return {
    ...DEFAULT_RDA_MICROS,
    saturatedFatG: DEFAULT_EXTENDED_TARGETS.saturatedFatG,
    addedSugarG: DEFAULT_EXTENDED_TARGETS.addedSugarG,
    cholesterolMg: DEFAULT_EXTENDED_TARGETS.cholesterolMg,
    caffeineMg: DEFAULT_EXTENDED_TARGETS.caffeineMg,
  };
}

function toDailyMacroTargets(t: {
  dailyCalories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
}): DailyMacroTargets {
  return {
    calories: t.dailyCalories,
    proteinG: t.proteinG,
    carbsG: t.carbsG,
    fatG: t.fatG,
    fiberG: t.fiberG,
  };
}

export function GoalsCalculatorForm() {
  const [targetMode, setTargetMode] = useState<'calculator' | 'custom'>('calculator');
  const [weightUnit, setWeightUnit] = useState<'kg' | 'lb'>('kg');

  // Mifflin-St Jeor profile inputs
  const [sex, setSex] = useState<'male' | 'female'>('male');
  const [age, setAge] = useState<number>(30);
  const [weightKg, setWeightKg] = useState<number>(75);
  const [heightCm, setHeightCm] = useState<number>(175);
  const [activityMultiplier, setActivityMultiplier] = useState<number>(1.55);
  const [goalDeltaKcal, setGoalDeltaKcal] = useState<number>(-300);
  const [proteinPerKg, setProteinPerKg] = useState<number>(2.0);
  const [touched, setTouched] = useState<{
    age?: boolean;
    weightKg?: boolean;
    heightCm?: boolean;
    proteinPerKg?: boolean;
  }>({});

  // Saved / active / custom targets state
  const [hasSavedGoals, setHasSavedGoals] = useState(false);
  const [lastCheckInAt, setLastCheckInAt] = useState<number | undefined>(undefined);
  const [activeTargets, setActiveTargets] = useState<DailyMacroTargets>({
    calories: 2000,
    proteinG: 150,
    carbsG: 200,
    fatG: 65,
    fiberG: 30,
  });

  // Weekly Calorie Cycling state
  const [cyclingExpanded, setCyclingExpanded] = useState(false);
  const [weeklyCyclingEnabled, setWeeklyCyclingEnabled] = useState(false);
  const [weeklySchedule, setWeeklySchedule] = useState<
    Record<WeekdayKey, DailyMacroTargets> | null
  >(null);

  // Custom Micronutrient & Extended Targets state
  const [microsExpanded, setMicrosExpanded] = useState(false);
  const [microTargets, setMicroTargets] = useState<Record<string, number>>(
    buildDefaultMicroTargets
  );

  const [savedSuccess, setSavedSuccess] = useState(false);
  const [recalcNotice, setRecalcNotice] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Load existing goals & profile on mount
  useEffect(() => {
    async function loadGoals() {
      try {
        const goals = await db.userGoals.get('active');
        if (!goals) return;

        const isUncustomizedSeed =
          goals.updatedAt === 0 && !goals.profile && !goals.lastCheckInAt;

        if (isUncustomizedSeed) {
          setHasSavedGoals(false);
          setLastCheckInAt(undefined);
          return;
        }

        setHasSavedGoals(true);
        setLastCheckInAt(goals.lastCheckInAt);
        setTargetMode(goals.targetMode ?? 'calculator');
        setWeightUnit(goals.weightUnit ?? 'kg');

        const loadedActive: DailyMacroTargets = {
          calories: goals.dailyCalories,
          proteinG: goals.proteinG,
          carbsG: goals.carbsG,
          fatG: goals.fatG,
          fiberG: goals.fiberG,
        };

        if (goals.profile) {
          const p = goals.profile;
          setSex(p.sex ?? 'male');
          setAge(p.age ?? 30);
          setWeightKg(p.weightKg ?? 75);
          setHeightCm(p.heightCm ?? 175);
          setActivityMultiplier(p.activityMultiplier ?? 1.55);
          setProteinPerKg(p.proteinPerKg ?? 2.0);
        }

        const resolvedDelta =
          goals.goalDeltaKcal ?? goals.profile?.goalDeltaKcal ?? 0;
        setGoalDeltaKcal(resolvedDelta);

        const cyclingEnabled = Boolean(goals.weeklyCyclingEnabled);
        const loadedSchedule =
          goals.weeklySchedule ??
          (cyclingEnabled ? buildCyclingPreset(loadedActive, 'even') : null);
        const syncedActive =
          cyclingEnabled && loadedSchedule
            ? computeWeeklyScheduleAverage(loadedSchedule)
            : loadedActive;

        setActiveTargets(syncedActive);
        setWeeklyCyclingEnabled(cyclingEnabled);
        setWeeklySchedule(loadedSchedule);
        setMicroTargets({
          ...buildDefaultMicroTargets(),
          ...(goals.micronutrientTargets ?? {}),
        });
      } catch (err) {
        console.error('Failed to load user goals profile:', err);
      }
    }
    void loadGoals();
  }, []);

  const calculatedTargets = useMemo(() => {
    return calculateMifflinStJeorTargets({
      sex,
      age,
      weightKg,
      heightCm,
      activityMultiplier,
      goalDeltaKcal,
      proteinPerKg,
    });
  }, [sex, age, weightKg, heightCm, activityMultiplier, goalDeltaKcal, proteinPerKg]);

  const baseTargets: DailyMacroTargets = useMemo(() => {
    if (targetMode === 'custom' || hasSavedGoals) {
      return activeTargets;
    }
    return toDailyMacroTargets(calculatedTargets);
  }, [targetMode, hasSavedGoals, activeTargets, calculatedTargets]);

  const resolvedWeeklySchedule = useMemo(
    () => weeklySchedule ?? buildCyclingPreset(baseTargets, 'even'),
    [weeklySchedule, baseTargets]
  );

  const weeklyAverage = useMemo(
    () => computeWeeklyScheduleAverage(resolvedWeeklySchedule),
    [resolvedWeeklySchedule]
  );

  const effectiveTargets: DailyMacroTargets = useMemo(() => {
    if (weeklyCyclingEnabled) {
      return weeklyAverage;
    }
    return baseTargets;
  }, [weeklyCyclingEnabled, weeklyAverage, baseTargets]);

  const macroEnergySum = useMemo(
    () =>
      Math.round(
        effectiveTargets.proteinG * 4 +
          effectiveTargets.carbsG * 4 +
          effectiveTargets.fatG * 9
      ),
    [effectiveTargets]
  );

  const formulaDiffersFromActive =
    (hasSavedGoals || weeklyCyclingEnabled) &&
    targetMode === 'calculator' &&
    (calculatedTargets.dailyCalories !== effectiveTargets.calories ||
      calculatedTargets.proteinG !== effectiveTargets.proteinG ||
      calculatedTargets.carbsG !== effectiveTargets.carbsG ||
      calculatedTargets.fatG !== effectiveTargets.fatG ||
      calculatedTargets.fiberG !== effectiveTargets.fiberG);

  const handleModeSwitch = (nextMode: 'calculator' | 'custom') => {
    if (nextMode === targetMode) return;
    if (nextMode === 'custom' && !hasSavedGoals) {
      setActiveTargets(effectiveTargets);
    }
    setTargetMode(nextMode);
    triggerHaptic(6);
  };

  const handleRecalculateFromFormula = () => {
    const next = toDailyMacroTargets(calculatedTargets);
    setActiveTargets(next);
    if (weeklyCyclingEnabled) {
      setWeeklySchedule(buildCyclingPreset(next, 'even'));
    }
    setRecalcNotice(true);
    triggerHaptic(8);
    setTimeout(() => setRecalcNotice(false), 2500);
  };

  const handleToggleCycling = (enabled: boolean) => {
    setWeeklyCyclingEnabled(enabled);
    if (enabled) {
      const nextSchedule =
        weeklySchedule ?? buildCyclingPreset(baseTargets, 'even');
      setWeeklySchedule(nextSchedule);
      setActiveTargets(computeWeeklyScheduleAverage(nextSchedule));
    }
    triggerHaptic(6);
  };

  const handleApplyCyclingPreset = (
    preset: 'even' | 'weekend_plus_250' | 'training_split'
  ) => {
    const nextSchedule = buildCyclingPreset(effectiveTargets, preset);
    setWeeklySchedule(nextSchedule);
    setWeeklyCyclingEnabled(true);
    setActiveTargets(computeWeeklyScheduleAverage(nextSchedule));
    triggerHaptic(8);
  };

  const handleUpdateDayField = (
    day: WeekdayKey,
    field: keyof DailyMacroTargets,
    rawValue: string
  ) => {
    const parsed = Math.max(0, Math.round(parseFloat(rawValue) || 0));
    const baseSchedule = weeklySchedule ?? buildCyclingPreset(baseTargets, 'even');
    const nextSchedule = {
      ...baseSchedule,
      [day]: {
        ...baseSchedule[day],
        [field]: parsed,
      },
    };
    setWeeklySchedule(nextSchedule);
    if (weeklyCyclingEnabled) {
      setActiveTargets(computeWeeklyScheduleAverage(nextSchedule));
    }
  };

  const handleUpdateCustomTargetField = (
    field: keyof DailyMacroTargets,
    rawValue: string
  ) => {
    const parsed = Math.max(0, parseInt(rawValue, 10) || 0);
    const nextTargets: DailyMacroTargets = {
      ...effectiveTargets,
      [field]: parsed,
    };
    setActiveTargets(nextTargets);
    if (weeklyCyclingEnabled) {
      setWeeklySchedule(buildCyclingPreset(nextTargets, 'even'));
    } else {
      setWeeklySchedule(null);
    }
  };

  const handleUpdateMicroTarget = (key: string, rawValue: string) => {
    const parsed = Math.max(0, parseFloat(rawValue) || 0);
    setMicroTargets((prev) => ({
      ...prev,
      [key]: parsed,
    }));
  };

  const handleResetMicroDefaults = () => {
    setMicroTargets(buildDefaultMicroTargets());
    triggerHaptic(8);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setIsSaving(true);
    setSavedSuccess(false);

    try {
      const existing = await db.userGoals.get('active');
      const profile: UserProfile = {
        sex,
        age,
        weightKg,
        heightCm,
        activityMultiplier,
        goalDeltaKcal,
        proteinPerKg,
      };

      const targetsToSave = weeklyCyclingEnabled ? weeklyAverage : effectiveTargets;
      const scheduleToSave = weeklyCyclingEnabled
        ? resolvedWeeklySchedule
        : existing?.weeklySchedule;

      const updatedGoals: UserGoals = {
        ...(existing ?? {}),
        id: 'active',
        dailyCalories: Math.max(0, Math.round(targetsToSave.calories)),
        proteinG: Math.max(0, Math.round(targetsToSave.proteinG)),
        carbsG: Math.max(0, Math.round(targetsToSave.carbsG)),
        fatG: Math.max(0, Math.round(targetsToSave.fatG)),
        fiberG: Math.max(0, Math.round(targetsToSave.fiberG)),
        micronutrientTargets: { ...microTargets },
        mealSlots: existing?.mealSlots ?? [],
        targetMode,
        goalDeltaKcal,
        weightUnit,
        weeklyCyclingEnabled,
        weeklySchedule: scheduleToSave,
        profile,
        updatedAt: Date.now(),
      };

      await db.userGoals.put(updatedGoals);
      setHasSavedGoals(true);
      setActiveTargets({
        calories: updatedGoals.dailyCalories,
        proteinG: updatedGoals.proteinG,
        carbsG: updatedGoals.carbsG,
        fatG: updatedGoals.fatG,
        fiberG: updatedGoals.fiberG,
      });
      triggerHaptic(10);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3000);
    } catch (err) {
      console.error('Failed to save user goals:', err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="bg-card border border-border/50 rounded-2xl p-4 sm:p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-2xl bg-[var(--macro-calories)]/15 flex items-center justify-center text-[var(--macro-calories)] shrink-0">
            <Calculator className="w-4 h-4" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground tracking-tight">
              Goals &amp; TDEE Calculator
            </h2>
            <p className="text-xs text-muted-foreground">
              Calculator, direct overrides, weekly cycling &amp; micro targets
            </p>
          </div>
        </div>

        {/* Mode Toggle: Calculator | Custom Targets */}
        <div
          role="tablist"
          aria-label="Target calculation mode"
          className="inline-flex items-center p-1 rounded-full bg-surface-sub border border-border/40"
        >
          <button
            type="button"
            role="tab"
            aria-selected={targetMode === 'calculator'}
            onClick={() => handleModeSwitch('calculator')}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
              targetMode === 'calculator'
                ? 'bg-foreground text-background shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Calculator
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={targetMode === 'custom'}
            onClick={() => handleModeSwitch('custom')}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
              targetMode === 'custom'
                ? 'bg-foreground text-background shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Custom Targets
          </button>
        </div>
      </div>

      {/* Active Targets Summary Banner */}
      <div className="bg-surface-sub rounded-2xl p-3.5 sm:p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {!hasSavedGoals && targetMode === 'calculator'
                ? 'Calculator Preview'
                : 'Active Daily Targets'}
            </span>
            {!hasSavedGoals && targetMode === 'calculator' && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-card text-muted-foreground border border-border/60">
                Unsaved Â· Dashboard is on {activeTargets.calories.toLocaleString()} kcal default
              </span>
            )}
            {hasSavedGoals && lastCheckInAt && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[var(--macro-calories)]/15 text-[var(--macro-calories)]">
                Coached
              </span>
            )}
            {weeklyCyclingEnabled && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-card text-muted-foreground border border-border/50">
                Cycling
              </span>
            )}
          </div>
          <span
            data-testid="active-targets-calories"
            className="inline-flex items-center gap-1 text-sm font-bold text-foreground tabular-nums"
          >
            <Flame
              className="w-3.5 h-3.5 text-[var(--macro-calories)]"
              aria-hidden="true"
            />
            {effectiveTargets.calories.toLocaleString()} kcal
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <div className="p-2.5 rounded-xl bg-card text-center">
            <div className="flex items-center justify-center gap-1 text-[11px] text-[var(--macro-protein)] font-semibold">
              <Dumbbell className="w-3 h-3" aria-hidden="true" />
              <span>Protein</span>
            </div>
            <p className="text-sm font-bold text-foreground tabular-nums mt-0.5">
              {effectiveTargets.proteinG}g
            </p>
          </div>

          <div className="p-2.5 rounded-xl bg-card text-center">
            <div className="flex items-center justify-center gap-1 text-[11px] text-[var(--macro-fat)] font-semibold">
              <Droplets className="w-3 h-3" aria-hidden="true" />
              <span>Fat</span>
            </div>
            <p className="text-sm font-bold text-foreground tabular-nums mt-0.5">
              {effectiveTargets.fatG}g
            </p>
          </div>

          <div className="p-2.5 rounded-xl bg-card text-center">
            <div className="flex items-center justify-center gap-1 text-[11px] text-[var(--macro-carbs)] font-semibold">
              <Wheat className="w-3 h-3" aria-hidden="true" />
              <span>Carbs</span>
            </div>
            <p className="text-sm font-bold text-foreground tabular-nums mt-0.5">
              {effectiveTargets.carbsG}g
            </p>
          </div>

          <div className="p-2.5 rounded-xl bg-card text-center">
            <div className="flex items-center justify-center gap-1 text-[11px] text-[var(--macro-fiber)] font-semibold">
              <Leaf className="w-3 h-3" aria-hidden="true" />
              <span>Fiber</span>
            </div>
            <p className="text-sm font-bold text-foreground tabular-nums mt-0.5">
              {effectiveTargets.fiberG}g
            </p>
          </div>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        {/* Shared Preferences: Goal Rate (both modes) + Weight Display Unit */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 bg-surface-sub/60 border border-border/40 rounded-2xl p-3.5">
          <div className="sm:col-span-8 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="goals-rate-delta"
                className="text-xs font-medium text-muted-foreground"
              >
                Goal Rate (kcal/day)
              </label>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                Used by Adaptive Check-Ins
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {GOAL_RATE_PRESETS.map((preset) => {
                const isSelected = goalDeltaKcal === preset.value;
                return (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => {
                      setGoalDeltaKcal(preset.value);
                      triggerHaptic(6);
                    }}
                    className={`px-2.5 py-1 rounded-full text-xs font-semibold tabular-nums transition-colors ${
                      isSelected
                        ? 'bg-foreground text-background'
                        : 'bg-card text-muted-foreground hover:text-foreground border border-border/50'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
              <input
                id="goals-rate-delta"
                aria-label="Goal Rate (kcal/day)"
                type="number"
                step={50}
                min={-1500}
                max={1500}
                value={goalDeltaKcal}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  setGoalDeltaKcal(Number.isFinite(parsed) ? parsed : 0);
                }}
                className="w-24 h-8 px-2.5 text-xs tabular-nums rounded-xl bg-card border border-border/50 focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
              />
            </div>
          </div>

          <div className="sm:col-span-4 space-y-2">
            <span className="block text-xs font-medium text-muted-foreground">
              Display Unit
            </span>
            <div
              role="group"
              aria-label="Display unit"
              className="inline-flex w-full p-1 rounded-xl bg-card border border-border/50"
            >
              <button
                type="button"
                aria-pressed={weightUnit === 'kg'}
                onClick={() => {
                  setWeightUnit('kg');
                  triggerHaptic(6);
                }}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  weightUnit === 'kg'
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                kg
              </button>
              <button
                type="button"
                aria-pressed={weightUnit === 'lb'}
                onClick={() => {
                  setWeightUnit('lb');
                  triggerHaptic(6);
                }}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  weightUnit === 'lb'
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                lb
              </button>
            </div>
          </div>
        </div>

        {/* Mode-specific Body */}
        {targetMode === 'calculator' ? (
          <div className="space-y-4">
            {/* Profile Inputs */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="goals-sex"
                  className="block text-xs font-medium text-muted-foreground mb-1.5"
                >
                  Biological Sex
                </label>
                <select
                  id="goals-sex"
                  aria-label="Biological Sex"
                  value={sex}
                  onChange={(e) => setSex(e.target.value as 'male' | 'female')}
                  className="w-full h-10 px-3.5 text-base sm:text-sm rounded-xl bg-surface-sub focus:outline-none focus:ring-2 focus:ring-ring text-foreground transition-shadow"
                >
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="goals-age"
                  className="block text-xs font-medium text-muted-foreground mb-1.5"
                >
                  Age (years)
                </label>
                <input
                  id="goals-age"
                  aria-label="Age"
                  type="number"
                  min={12}
                  max={120}
                  value={age || ''}
                  onChange={(e) =>
                    setAge(Math.max(1, parseInt(e.target.value, 10) || 0))
                  }
                  onBlur={() => setTouched((prev) => ({ ...prev, age: true }))}
                  className="w-full h-10 px-3.5 text-base sm:text-sm tabular-nums rounded-xl bg-surface-sub focus:outline-none focus:ring-2 focus:ring-ring text-foreground transition-shadow"
                />
                {touched.age && (age < 12 || age > 120) && (
                  <p className="text-[11px] text-[var(--neutral-over)] mt-1">
                    Typical adult range: 12â€“120 years.
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="goals-weight"
                  className="block text-xs font-medium text-muted-foreground mb-1.5"
                >
                  Weight (kg)
                </label>
                <input
                  id="goals-weight"
                  aria-label="Weight"
                  type="number"
                  step="0.5"
                  min={30}
                  max={300}
                  value={weightKg || ''}
                  onChange={(e) =>
                    setWeightKg(Math.max(1, parseFloat(e.target.value) || 0))
                  }
                  onBlur={() =>
                    setTouched((prev) => ({ ...prev, weightKg: true }))
                  }
                  className="w-full h-10 px-3.5 text-base sm:text-sm tabular-nums rounded-xl bg-surface-sub focus:outline-none focus:ring-2 focus:ring-ring text-foreground transition-shadow"
                />
                {touched.weightKg && (weightKg < 30 || weightKg > 300) && (
                  <p className="text-[11px] text-[var(--neutral-over)] mt-1">
                    Typical range: 30â€“300 kg.
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="goals-height"
                  className="block text-xs font-medium text-muted-foreground mb-1.5"
                >
                  Height (cm)
                </label>
                <input
                  id="goals-height"
                  aria-label="Height"
                  type="number"
                  min={100}
                  max={250}
                  value={heightCm || ''}
                  onChange={(e) =>
                    setHeightCm(Math.max(1, parseInt(e.target.value, 10) || 0))
                  }
                  onBlur={() =>
                    setTouched((prev) => ({ ...prev, heightCm: true }))
                  }
                  className="w-full h-10 px-3.5 text-base sm:text-sm tabular-nums rounded-xl bg-surface-sub focus:outline-none focus:ring-2 focus:ring-ring text-foreground transition-shadow"
                />
                {touched.heightCm && (heightCm < 100 || heightCm > 250) && (
                  <p className="text-[11px] text-[var(--neutral-over)] mt-1">
                    Typical range: 100â€“250 cm.
                  </p>
                )}
              </div>
            </div>

            {/* Activity & Protein Ratio */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="goals-activity"
                  className="block text-xs font-medium text-muted-foreground mb-1.5"
                >
                  Activity Level
                </label>
                <select
                  id="goals-activity"
                  aria-label="Activity Level"
                  value={activityMultiplier}
                  onChange={(e) =>
                    setActivityMultiplier(parseFloat(e.target.value))
                  }
                  className="w-full h-10 px-3.5 text-base sm:text-sm rounded-xl bg-surface-sub focus:outline-none focus:ring-2 focus:ring-ring text-foreground transition-shadow"
                >
                  {ACTIVITY_LEVELS.map((act) => (
                    <option key={act.value} value={act.value}>
                      {act.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="goals-protein-per-kg"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Protein per kg
                  </label>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {proteinPerKg.toFixed(1)} g/kg
                  </span>
                </div>
                <input
                  id="goals-protein-per-kg"
                  aria-label="Protein per kg"
                  type="number"
                  step="0.1"
                  min={1.0}
                  max={3.5}
                  value={proteinPerKg || ''}
                  onChange={(e) =>
                    setProteinPerKg(
                      Math.max(0.5, parseFloat(e.target.value) || 0)
                    )
                  }
                  onBlur={() =>
                    setTouched((prev) => ({ ...prev, proteinPerKg: true }))
                  }
                  className="w-full h-10 px-3.5 text-base sm:text-sm tabular-nums rounded-xl bg-surface-sub focus:outline-none focus:ring-2 focus:ring-ring text-foreground transition-shadow"
                />
                {touched.proteinPerKg &&
                  (proteinPerKg < 1.0 || proteinPerKg > 3.5) && (
                    <p className="text-[11px] text-[var(--neutral-over)] mt-1">
                      Recommended protein calibration band: 1.0â€“3.5 g/kg.
                    </p>
                  )}
              </div>
            </div>

            {/* Explicit Recalculate from Mifflin-St Jeor Strip */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 p-3 rounded-xl bg-surface-sub/60 border border-border/40">
              <div className="text-xs text-muted-foreground tabular-nums">
                <span>Formula estimate: </span>
                <strong className="text-foreground">
                  {calculatedTargets.dailyCalories.toLocaleString()} kcal
                </strong>{' '}
                <span>
                  ({calculatedTargets.proteinG}P Â· {calculatedTargets.carbsG}C Â·{' '}
                  {calculatedTargets.fatG}F Â· {calculatedTargets.fiberG}g fiber)
                </span>
                {formulaDiffersFromActive && (
                  <p className="text-[11px] text-[var(--neutral-over)] mt-0.5">
                    Saving preferences preserves your current active targets
                    unless you recalculate.
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={handleRecalculateFromFormula}
                className="tactile-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-card border border-border/60 hover:bg-surface-elevated text-xs font-semibold text-foreground shrink-0"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {recalcNotice
                    ? 'Applied Formula Targets'
                    : 'Recalculate from Mifflin-St Jeor'}
                </span>
              </button>
            </div>
          </div>
        ) : (
          /* Direct Custom Targets Mode */
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="col-span-2 sm:col-span-1">
                <label
                  htmlFor="custom-calories"
                  className="block text-xs font-medium text-muted-foreground mb-1.5"
                >
                  Daily Calories (kcal)
                </label>
                <input
                  id="custom-calories"
                  aria-label="Daily Calories (kcal)"
                  type="number"
                  min={500}
                  max={10000}
                  value={effectiveTargets.calories || ''}
                  onChange={(e) =>
                    handleUpdateCustomTargetField('calories', e.target.value)
                  }
                  className="w-full h-10 px-3.5 text-base sm:text-sm tabular-nums rounded-xl bg-surface-sub focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                />
              </div>

              <div>
                <label
                  htmlFor="custom-protein"
                  className="block text-xs font-medium text-[var(--macro-protein)] mb-1.5"
                >
                  Protein (g)
                </label>
                <input
                  id="custom-protein"
                  aria-label="Protein (g)"
                  type="number"
                  min={0}
                  max={600}
                  value={effectiveTargets.proteinG || ''}
                  onChange={(e) =>
                    handleUpdateCustomTargetField('proteinG', e.target.value)
                  }
                  className="w-full h-10 px-3.5 text-base sm:text-sm tabular-nums rounded-xl bg-surface-sub focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                />
              </div>

              <div>
                <label
                  htmlFor="custom-carbs"
                  className="block text-xs font-medium text-[var(--macro-carbs)] mb-1.5"
                >
                  Carbs (g)
                </label>
                <input
                  id="custom-carbs"
                  aria-label="Carbs (g)"
                  type="number"
                  min={0}
                  max={1200}
                  value={effectiveTargets.carbsG || ''}
                  onChange={(e) =>
                    handleUpdateCustomTargetField('carbsG', e.target.value)
                  }
                  className="w-full h-10 px-3.5 text-base sm:text-sm tabular-nums rounded-xl bg-surface-sub focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                />
              </div>

              <div>
                <label
                  htmlFor="custom-fat"
                  className="block text-xs font-medium text-[var(--macro-fat)] mb-1.5"
                >
                  Fat (g)
                </label>
                <input
                  id="custom-fat"
                  aria-label="Fat (g)"
                  type="number"
                  min={0}
                  max={400}
                  value={effectiveTargets.fatG || ''}
                  onChange={(e) =>
                    handleUpdateCustomTargetField('fatG', e.target.value)
                  }
                  className="w-full h-10 px-3.5 text-base sm:text-sm tabular-nums rounded-xl bg-surface-sub focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                />
              </div>

              <div>
                <label
                  htmlFor="custom-fiber"
                  className="block text-xs font-medium text-[var(--macro-fiber)] mb-1.5"
                >
                  Fiber (g)
                </label>
                <input
                  id="custom-fiber"
                  aria-label="Fiber (g)"
                  type="number"
                  min={0}
                  max={150}
                  value={effectiveTargets.fiberG || ''}
                  onChange={(e) =>
                    handleUpdateCustomTargetField('fiberG', e.target.value)
                  }
                  className="w-full h-10 px-3.5 text-base sm:text-sm tabular-nums rounded-xl bg-surface-sub focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
                />
              </div>
            </div>

            {/* Non-blocking 4-4-9 macro energy readout */}
            <div className="flex items-center justify-between px-3.5 py-2 rounded-xl bg-surface-sub/60 text-xs text-muted-foreground tabular-nums">
              <span>4-4-9 Macro Energy Sum</span>
              <span className="font-semibold text-foreground">
                {macroEnergySum.toLocaleString()} kcal
                {macroEnergySum !== effectiveTargets.calories && (
                  <span className="text-[var(--neutral-over)] font-normal ml-1.5">
                    ({macroEnergySum - effectiveTargets.calories > 0 ? '+' : ''}
                    {macroEnergySum - effectiveTargets.calories} vs target)
                  </span>
                )}
              </span>
            </div>
          </div>
        )}

        {/* Collapsible Weekly Calorie Cycling Editor */}
        <div className="rounded-2xl border border-border/50 bg-surface-sub/40 overflow-hidden">
          <button
            type="button"
            aria-expanded={cyclingExpanded}
            onClick={() => setCyclingExpanded((prev) => !prev)}
            className="w-full flex items-center justify-between gap-2 px-3.5 py-3 text-left hover:bg-surface-sub/70 transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <CalendarRange
                className="w-4 h-4 text-[var(--macro-calories)] shrink-0"
                aria-hidden="true"
              />
              <div>
                <span className="text-xs font-semibold text-foreground">
                  Weekly Calorie Cycling
                </span>
                <span className="block text-[11px] text-muted-foreground tabular-nums">
                  {weeklyCyclingEnabled
                    ? `Enabled Â· 7-day avg ${weeklyAverage.calories.toLocaleString()} kcal`
                    : 'Optional Monâ€“Sun daily target schedule'}
                </span>
              </div>
            </div>
            <ChevronDown
              className={`w-4 h-4 text-muted-foreground transition-transform duration-150 ${
                cyclingExpanded ? 'rotate-180 text-foreground' : ''
              }`}
              aria-hidden="true"
            />
          </button>

          {cyclingExpanded && (
            <div className="px-3.5 pb-3.5 pt-2 border-t border-border/40 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="inline-flex items-center gap-2 text-xs font-medium text-foreground cursor-pointer">
                  <input
                    id="goals-weekly-cycling"
                    type="checkbox"
                    checked={weeklyCyclingEnabled}
                    onChange={(e) => handleToggleCycling(e.target.checked)}
                    className="w-4 h-4 rounded accent-[var(--macro-calories)] cursor-pointer"
                  />
                  <span>Enable Weekly Calorie Cycling</span>
                </label>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleApplyCyclingPreset('even')}
                    className="px-2.5 py-1 rounded-full bg-card border border-border/50 hover:bg-surface-elevated text-[11px] font-medium text-foreground"
                  >
                    Even
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApplyCyclingPreset('weekend_plus_250')}
                    className="px-2.5 py-1 rounded-full bg-card border border-border/50 hover:bg-surface-elevated text-[11px] font-medium text-foreground"
                  >
                    Higher Weekend (+250 Fri/Sat)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApplyCyclingPreset('training_split')}
                    className="px-2.5 py-1 rounded-full bg-card border border-border/50 hover:bg-surface-elevated text-[11px] font-medium text-foreground"
                  >
                    Training Split
                  </button>
                </div>
              </div>

              {/* Live Weekly Average Banner */}
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-xl bg-card border border-border/40 text-xs tabular-nums">
                <span className="font-medium text-muted-foreground">
                  Weekly Average
                </span>
                <div className="flex flex-wrap items-center gap-2.5 font-semibold">
                  <span className="text-[var(--macro-calories)]">
                    {weeklyAverage.calories.toLocaleString()} kcal
                  </span>
                  <span className="text-[var(--macro-protein)]">
                    {weeklyAverage.proteinG}P
                  </span>
                  <span className="text-[var(--macro-carbs)]">
                    {weeklyAverage.carbsG}C
                  </span>
                  <span className="text-[var(--macro-fat)]">
                    {weeklyAverage.fatG}F
                  </span>
                  <span className="text-[var(--macro-fiber)]">
                    {weeklyAverage.fiberG}g fib
                  </span>
                </div>
              </div>

              {/* Mon-Sun Editable Rows */}
              <div className="space-y-1.5">
                <div className="grid grid-cols-6 gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>Day</span>
                  <span>kcal</span>
                  <span>P (g)</span>
                  <span>C (g)</span>
                  <span>F (g)</span>
                  <span>Fib (g)</span>
                </div>
                {WEEKDAY_KEYS.map((day) => {
                  const row = resolvedWeeklySchedule[day];
                  const label = WEEKDAY_LABELS[day];
                  return (
                    <div
                      key={day}
                      className="grid grid-cols-6 gap-1.5 items-center"
                    >
                      <span className="text-xs font-semibold text-foreground px-1">
                        {label}
                      </span>
                      <input
                        type="number"
                        aria-label={`${label} calories`}
                        min={0}
                        value={row.calories}
                        onChange={(e) =>
                          handleUpdateDayField(day, 'calories', e.target.value)
                        }
                        className="w-full h-8 px-2 text-xs tabular-nums rounded-lg bg-card border border-border/50 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <input
                        type="number"
                        aria-label={`${label} protein`}
                        min={0}
                        value={row.proteinG}
                        onChange={(e) =>
                          handleUpdateDayField(day, 'proteinG', e.target.value)
                        }
                        className="w-full h-8 px-2 text-xs tabular-nums rounded-lg bg-card border border-border/50 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <input
                        type="number"
                        aria-label={`${label} carbs`}
                        min={0}
                        value={row.carbsG}
                        onChange={(e) =>
                          handleUpdateDayField(day, 'carbsG', e.target.value)
                        }
                        className="w-full h-8 px-2 text-xs tabular-nums rounded-lg bg-card border border-border/50 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <input
                        type="number"
                        aria-label={`${label} fat`}
                        min={0}
                        value={row.fatG}
                        onChange={(e) =>
                          handleUpdateDayField(day, 'fatG', e.target.value)
                        }
                        className="w-full h-8 px-2 text-xs tabular-nums rounded-lg bg-card border border-border/50 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <input
                        type="number"
                        aria-label={`${label} fiber`}
                        min={0}
                        value={row.fiberG}
                        onChange={(e) =>
                          handleUpdateDayField(day, 'fiberG', e.target.value)
                        }
                        className="w-full h-8 px-2 text-xs tabular-nums rounded-lg bg-card border border-border/50 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Collapsible Custom Micronutrient & Extended Targets Editor */}
        <div className="rounded-2xl border border-border/50 bg-surface-sub/40 overflow-hidden">
          <button
            type="button"
            aria-expanded={microsExpanded}
            onClick={() => setMicrosExpanded((prev) => !prev)}
            className="w-full flex items-center justify-between gap-2 px-3.5 py-3 text-left hover:bg-surface-sub/70 transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <SlidersHorizontal
                className="w-4 h-4 text-[var(--macro-fiber)] shrink-0"
                aria-hidden="true"
              />
              <div>
                <span className="text-xs font-semibold text-foreground">
                  Custom Micronutrient Targets
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  12 Adult RDAs + 4 extended reference bounds
                </span>
              </div>
            </div>
            <ChevronDown
              className={`w-4 h-4 text-muted-foreground transition-transform duration-150 ${
                microsExpanded ? 'rotate-180 text-foreground' : ''
              }`}
              aria-hidden="true"
            />
          </button>

          {microsExpanded && (
            <div className="px-3.5 pb-3.5 pt-2.5 border-t border-border/40 space-y-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Core Vitamins &amp; Minerals (12 RDAs)
                </span>
                <button
                  type="button"
                  onClick={handleResetMicroDefaults}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-card border border-border/50 hover:bg-surface-elevated text-[11px] font-medium text-foreground"
                >
                  <RotateCcw className="w-3 h-3" aria-hidden="true" />
                  <span>Reset to Adult RDA Defaults</span>
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {Object.values(RDA_MICRONUTRIENT_METADATA).map((meta) => (
                  <div key={meta.key}>
                    <label
                      htmlFor={`micro-target-${meta.key}`}
                      className="block text-[11px] font-medium text-muted-foreground mb-1"
                    >
                      {meta.name} ({meta.unit})
                    </label>
                    <input
                      id={`micro-target-${meta.key}`}
                      aria-label={`${meta.name} (${meta.unit})`}
                      type="number"
                      step="any"
                      min={0}
                      value={microTargets[meta.key] ?? DEFAULT_RDA_MICROS[meta.key] ?? 0}
                      onChange={(e) =>
                        handleUpdateMicroTarget(meta.key, e.target.value)
                      }
                      className="w-full h-9 px-2.5 text-xs tabular-nums rounded-xl bg-card border border-border/50 focus:outline-none focus:ring-1 focus:ring-ring text-foreground"
                    />
                  </div>
                ))}
              </div>

              <div className="pt-2 border-t border-border/40 space-y-2">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Extended Nutrient Reference Bounds
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {EXTENDED_BOUND_KEYS.map((key) => {
                    const meta = EXTENDED_NUTRIENT_METADATA[key];
                    return (
                      <div key={key}>
                        <label
                          htmlFor={`micro-target-${key}`}
                          className="block text-[11px] font-medium text-muted-foreground mb-1"
                        >
                          {meta.name} ({meta.unit})
                        </label>
                        <input
                          id={`micro-target-${key}`}
                          aria-label={`${meta.name} (${meta.unit})`}
                          type="number"
                          step="any"
                          min={0}
                          value={
                            microTargets[key] ?? DEFAULT_EXTENDED_TARGETS[key] ?? 0
                          }
                          onChange={(e) =>
                            handleUpdateMicroTarget(key, e.target.value)
                          }
                          className="w-full h-9 px-2.5 text-xs tabular-nums rounded-xl bg-card border border-border/50 focus:outline-none focus:ring-1 focus:ring-ring text-foreground"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Primary Action Button */}
        <button
          type="submit"
          disabled={isSaving}
          className="tactile-press w-full h-11 px-4 rounded-full bg-foreground text-background font-semibold text-sm hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-xs"
        >
          {savedSuccess ? (
            <span className="animate-check-pop inline-flex items-center gap-1.5">
              <Check
                className="w-3.5 h-3.5 text-[var(--macro-carbs)]"
                aria-hidden="true"
              />
              <span>Goals &amp; Preferences Saved!</span>
            </span>
          ) : (
            <span>Save Nutrition Goals &amp; Preferences</span>
          )}
        </button>
      </form>
    </section>
  );
}
