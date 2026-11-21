import { db } from '@/lib/db/opencalory-db';
import type { DailyMacroTargets, UserGoals, WeekdayKey } from '@/types/nutrition';

export const WEEKDAY_KEYS: WeekdayKey[] = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
];

const WEEKDAY_FROM_GET_DAY: WeekdayKey[] = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
];

export const DEFAULT_RDA_MICROS: Record<string, number> = {
  sodiumMg: 2300,
  potassiumMg: 3400,
  calciumMg: 1000,
  ironMg: 18,
  magnesiumMg: 400,
  zincMg: 11,
  vitaminAMcg: 900,
  vitaminCMg: 90,
  vitaminDMcg: 15,
  vitaminB6Mg: 1.7,
  vitaminB12Mcg: 2.4,
  folateMcg: 400,
};

export interface MifflinStJeorInput {
  sex: 'male' | 'female';
  age: number;
  weightKg: number;
  heightCm: number;
  activityMultiplier: number;
  goalDeltaKcal: number;
  proteinPerKg: number;
}

export const ACTIVITY_LEVELS = [
  { value: 1.2, label: 'Sedentary (desk job, minimal exercise)' },
  { value: 1.375, label: 'Lightly Active (1-3 days/week)' },
  { value: 1.55, label: 'Moderately Active (3-5 days/week)' },
  { value: 1.725, label: 'Very Active (6-7 days/week hard exercise)' },
  { value: 1.9, label: 'Extremely Active (endurance / heavy physical work)' },
];

export const GOAL_DELTAS = [
  { value: -500, label: 'Moderate Deficit (-500 kcal/day)' },
  { value: -300, label: 'Mild Deficit (-300 kcal/day)' },
  { value: 0, label: 'Maintenance (0 kcal/day)' },
  { value: 250, label: 'Lean Gain (+250 kcal/day)' },
  { value: 500, label: 'Surplus (+500 kcal/day)' },
];

/**
 * Calculates Mifflin-St Jeor BMR, TDEE, and macro split targets.
 */
export function calculateMifflinStJeorTargets(
  input: MifflinStJeorInput,
): Pick<UserGoals, 'dailyCalories' | 'proteinG' | 'carbsG' | 'fatG' | 'fiberG'> {
  const safeWeight =
    typeof input.weightKg === 'number' && Number.isFinite(input.weightKg) && input.weightKg > 0
      ? input.weightKg
      : 70;
  const safeHeight =
    typeof input.heightCm === 'number' && Number.isFinite(input.heightCm) && input.heightCm > 0
      ? input.heightCm
      : 170;
  const safeAge =
    typeof input.age === 'number' && Number.isFinite(input.age) && input.age > 0
      ? input.age
      : 30;
  const safeActivity =
    typeof input.activityMultiplier === 'number' &&
    Number.isFinite(input.activityMultiplier) &&
    input.activityMultiplier > 0
      ? input.activityMultiplier
      : 1.55;
  const safeDelta =
    typeof input.goalDeltaKcal === 'number' && Number.isFinite(input.goalDeltaKcal)
      ? input.goalDeltaKcal
      : 0;
  const safeProteinPerKg =
    typeof input.proteinPerKg === 'number' &&
    Number.isFinite(input.proteinPerKg) &&
    input.proteinPerKg > 0
      ? input.proteinPerKg
      : 2.0;

  // Mifflin-St Jeor BMR formula
  const sexOffset = input.sex === 'male' ? 5 : -161;
  const bmr = 10 * safeWeight + 6.25 * safeHeight - 5 * safeAge + sexOffset;
  const tdee = Math.max(0, bmr) * safeActivity;

  // Target calories (bounded by at least 500 kcal for safety)
  const dailyCalories = Math.round(Math.max(500, tdee + safeDelta));

  // Protein targets
  const proteinG = Math.round(Math.max(0, safeWeight * safeProteinPerKg));
  const proteinKcal = proteinG * 4;

  // Fat targets: 25% of total calories
  const fatKcal = Math.max(0, dailyCalories * 0.25);
  const fatG = Math.round(fatKcal / 9);

  // Carbs targets: remaining calories
  const remainingKcal = Math.max(0, dailyCalories - proteinKcal - fatG * 9);
  const carbsG = Math.round(remainingKcal / 4);

  // Fiber targets: ~14g per 1000 kcal
  const fiberG = Math.max(0, Math.round((dailyCalories / 1000) * 14));

  return {
    dailyCalories,
    proteinG,
    carbsG,
    fatG,
    fiberG,
  };
}

/**
 * Idempotently seeds default user goals into Dexie DB when missing.
 */
export async function ensureDefaultUserGoals(): Promise<UserGoals> {
  const existing = await db.userGoals.get('active');
  if (existing) {
    return existing;
  }

  const defaultGoals: UserGoals = {
    id: 'active',
    dailyCalories: 2000,
    proteinG: 150,
    carbsG: 200,
    fatG: 65,
    fiberG: 30,
    micronutrientTargets: { ...DEFAULT_RDA_MICROS },
    mealSlots: [],
    targetMode: 'calculator',
    goalDeltaKcal: 0,
    weightUnit: 'kg',
    updatedAt: 0,
  };

  await db.userGoals.put(defaultGoals);
  return defaultGoals;
}

/**
 * Resolves a local calendar ISO date (YYYY-MM-DD) to its WeekdayKey without UTC drift.
 */
export function getWeekdayKey(isoDate: string): WeekdayKey {
  const match =
    typeof isoDate === 'string'
      ? isoDate.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
      : null;
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    const dt = new Date(y, m - 1, d);
    if (
      dt.getFullYear() === y &&
      dt.getMonth() === m - 1 &&
      dt.getDate() === d
    ) {
      return WEEKDAY_FROM_GET_DAY[dt.getDay()];
    }
  }
  return WEEKDAY_FROM_GET_DAY[new Date().getDay()];
}

/**
 * Returns date-specific UserGoals applying weekday calorie cycling when enabled.
 */
export function resolveGoalsForDate(goals: UserGoals, isoDate: string): UserGoals {
  if (!goals.weeklyCyclingEnabled || !goals.weeklySchedule) {
    return goals;
  }

  const dayKey = getWeekdayKey(isoDate);
  const dayTargets = goals.weeklySchedule[dayKey];
  if (!dayTargets) {
    return goals;
  }

  return {
    ...goals,
    dailyCalories: Number.isFinite(dayTargets.calories)
      ? dayTargets.calories
      : goals.dailyCalories,
    proteinG: Number.isFinite(dayTargets.proteinG)
      ? dayTargets.proteinG
      : goals.proteinG,
    carbsG: Number.isFinite(dayTargets.carbsG)
      ? dayTargets.carbsG
      : goals.carbsG,
    fatG: Number.isFinite(dayTargets.fatG) ? dayTargets.fatG : goals.fatG,
    fiberG: Number.isFinite(dayTargets.fiberG)
      ? dayTargets.fiberG
      : goals.fiberG,
  };
}

/**
 * Computes the 7-day average targets across a weekly calorie-cycling schedule.
 */
export function computeWeeklyScheduleAverage(
  schedule: Record<WeekdayKey, DailyMacroTargets>
): DailyMacroTargets {
  let calories = 0;
  let proteinG = 0;
  let carbsG = 0;
  let fatG = 0;
  let fiberG = 0;

  for (const key of WEEKDAY_KEYS) {
    const day = schedule[key];
    if (!day) continue;
    calories += Number.isFinite(day.calories) ? day.calories : 0;
    proteinG += Number.isFinite(day.proteinG) ? day.proteinG : 0;
    carbsG += Number.isFinite(day.carbsG) ? day.carbsG : 0;
    fatG += Number.isFinite(day.fatG) ? day.fatG : 0;
    fiberG += Number.isFinite(day.fiberG) ? day.fiberG : 0;
  }

  return {
    calories: Math.round(calories / 7),
    proteinG: Math.round(proteinG / 7),
    carbsG: Math.round(carbsG / 7),
    fatG: Math.round(fatG / 7),
    fiberG: Math.round(fiberG / 7),
  };
}

function scaleMacrosForDayCalories(
  base: DailyMacroTargets,
  targetCalories: number
): DailyMacroTargets {
  const safeCalories = Math.max(0, Math.round(targetCalories));
  const safeBaseCal = Math.max(0, Math.round(base.calories || 0));
  const proteinG = Math.max(0, Math.round(base.proteinG || 0));

  if (safeCalories === safeBaseCal) {
    return {
      calories: safeBaseCal,
      proteinG,
      carbsG: Math.max(0, Math.round(base.carbsG || 0)),
      fatG: Math.max(0, Math.round(base.fatG || 0)),
      fiberG: Math.max(0, Math.round(base.fiberG || 0)),
    };
  }

  const remainingKcal = Math.max(0, safeCalories - proteinG * 4);
  const baseCarbsKcal = Math.max(0, (base.carbsG || 0) * 4);
  const baseFatKcal = Math.max(0, (base.fatG || 0) * 9);
  const baseNonProtein = baseCarbsKcal + baseFatKcal;
  const carbsShare = baseNonProtein > 0 ? baseCarbsKcal / baseNonProtein : 0.7;

  const carbsG = Math.max(0, Math.round((remainingKcal * carbsShare) / 4));
  const fatG = Math.max(0, Math.round((remainingKcal - carbsG * 4) / 9));
  const fiberG =
    safeBaseCal > 0
      ? Math.max(0, Math.round((safeCalories / safeBaseCal) * (base.fiberG || 0)))
      : Math.max(0, Math.round((safeCalories / 1000) * 14));

  return {
    calories: safeCalories,
    proteinG,
    carbsG,
    fatG,
    fiberG,
  };
}

const CYCLING_PRESET_DELTAS: Record<
  'even' | 'weekend_plus_250' | 'training_split',
  Record<WeekdayKey, number>
> = {
  even: { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 },
  weekend_plus_250: {
    mon: -100,
    tue: -100,
    wed: -100,
    thu: -100,
    fri: 250,
    sat: 250,
    sun: -100,
  },
  training_split: {
    mon: 150,
    tue: 150,
    wed: -200,
    thu: 150,
    fri: 150,
    sat: -200,
    sun: -200,
  },
};

/**
 * Builds an isocaloric 7-day calorie-cycling schedule from base daily targets.
 */
export function buildCyclingPreset(
  base: DailyMacroTargets,
  preset: 'even' | 'weekend_plus_250' | 'training_split'
): Record<WeekdayKey, DailyMacroTargets> {
  const deltas = CYCLING_PRESET_DELTAS[preset];
  const schedule = {} as Record<WeekdayKey, DailyMacroTargets>;

  for (const key of WEEKDAY_KEYS) {
    const targetCalories = Math.max(0, Math.round((base.calories || 0) + deltas[key]));
    schedule[key] = scaleMacrosForDayCalories(base, targetCalories);
  }

  return schedule;
}
