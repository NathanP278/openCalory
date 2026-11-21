import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { db } from '@/lib/db/opencalory-db';
import { DEFAULT_RDA_MICROS } from '@/lib/nutrition/goals';
import { toLocalIsoDate } from '@/lib/nutrition/adaptive-tdee';
import { useLoggerStore } from '@/stores/logger-store';
import type { FoodLogEntry, UserGoals, WeightLogEntry } from '@/types/nutrition';

vi.mock('next/navigation', () => ({
  usePathname: () => '/trends',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import TrendsPage from '../page';
import HomePage from '../../page';

function offsetLocalIso(baseIso: string, deltaDays: number): string {
  const [y, m, d] = baseIso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function makeGoals(overrides: Partial<UserGoals> = {}): UserGoals {
  return {
    id: 'active',
    dailyCalories: 2200,
    proteinG: 160,
    carbsG: 230,
    fatG: 70,
    fiberG: 30,
    micronutrientTargets: { ...DEFAULT_RDA_MICROS },
    mealSlots: [],
    targetMode: 'calculator',
    goalDeltaKcal: -300,
    weightUnit: 'kg',
    profile: {
      sex: 'male',
      age: 30,
      weightKg: 80,
      heightCm: 180,
      activityMultiplier: 1.55,
      goalDeltaKcal: -300,
      proteinPerKg: 2.0,
    },
    updatedAt: 1700000000000,
    ...overrides,
  };
}

function makeFoodLog(date: string, index: number, calories = 2100): FoodLogEntry {
  return {
    id: `food-${date}-${index}`,
    date,
    foodId: `staple-${index}`,
    name: index === 0 ? 'Chicken Rice Bowl' : 'Greek Yogurt',
    source: 'staple',
    amount: 300,
    unit: 'g',
    createdAt: 1700000000000 + index * 1000,
    nutritionSnapshot: {
      calories,
      protein: 150,
      carbs: 220,
      fat: 60,
      fiber: 30,
      micros: {
        sodiumMg: 1400,
        potassiumMg: 2800,
        calciumMg: 600,
        ironMg: 10,
      },
    },
  };
}

function makeWeightLog(date: string, weightKg: number, index: number, note?: string): WeightLogEntry {
  const ts = 1700000000000 + index * 86_400_000;
  return {
    id: `weight-${date}`,
    date,
    weightKg,
    note,
    source: 'manual',
    recordedAt: new Date(ts).toISOString(),
    createdAt: ts,
    updatedAt: ts,
  };
}

async function seedTrendsData(today: string, goalsOverrides: Partial<UserGoals> = {}) {
  const goals = makeGoals(goalsOverrides);
  await db.userGoals.put(goals);

  // Seed 14 days of food logs (today - 13 .. today)
  const foodEntries: FoodLogEntry[] = [];
  for (let i = 13; i >= 0; i--) {
    const iso = offsetLocalIso(today, -i);
    foodEntries.push(makeFoodLog(iso, 0, 2100));
  }
  await db.foodLogs.bulkPut(foodEntries);

  // Seed 6 weigh-ins across 14 days showing steady slight loss (~80.5 -> 79.8 kg)
  const weighInOffsets = [-13, -11, -8, -5, -2, 0];
  const weighInValues = [80.5, 80.4, 80.2, 80.1, 79.9, 79.8];
  const weightEntries: WeightLogEntry[] = weighInOffsets.map((offset, idx) =>
    makeWeightLog(
      offsetLocalIso(today, offset),
      weighInValues[idx],
      idx,
      idx === weighInOffsets.length - 1 ? 'Fasted morning' : undefined,
    ),
  );
  await db.weightLogs.bulkPut(weightEntries);

  return { goals, foodEntries, weightEntries };
}

describe('TrendsPage workspace & Weekly Check-In', () => {
  const today = toLocalIsoDate(Date.now());

  beforeEach(async () => {
    await db.foodLogs.clear();
    await db.weightLogs.clear();
    await db.userGoals.clear();
    useLoggerStore.setState({
      activeDate: today,
      activeSheet: null,
      undoToast: null,
      editingEntry: null,
    });
  });

  it('renders /trends range controls, Weekly Calorie Bank, charts, and applies Weekly Check-In on Accept with Undo', async () => {
    await seedTrendsData(today);

    render(<TrendsPage />);

    // Range controls: 7D | 14D | 30D | 90D
    expect(await screen.findByRole('button', { name: '7D' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '14D' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30D' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '90D' })).toBeInTheDocument();

    // Quick Search Strip MUST NOT appear on /trends
    expect(screen.queryByTestId('quick-search-strip')).toBeNull();

    // Summary telemetry cards
    expect(await screen.findByText(/weekly calorie bank/i)).toBeInTheDocument();
    expect(screen.getByText(/daily avg intake/i)).toBeInTheDocument();
    expect(screen.getByText(/macro split/i)).toBeInTheDocument();

    // Switch range to 7D and back to 30D
    fireEvent.click(screen.getByRole('button', { name: '7D' }));
    expect(screen.getByRole('button', { name: '7D' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '30D' }));
    expect(screen.getByRole('button', { name: '30D' })).toHaveAttribute('aria-pressed', 'true');

    // Toggle IntakeTrendChart mode from Calories to Macros
    const macrosBtn = screen.getByRole('button', { name: /^macros$/i });
    fireEvent.click(macrosBtn);
    expect(macrosBtn).toHaveAttribute('aria-pressed', 'true');

    // Weekly Check-In Card should be visible with Accept and Dismiss buttons
    const checkInRegion = await screen.findByTestId('weekly-checkin-card');
    expect(within(checkInRegion).getByText(/observed tdee/i)).toBeInTheDocument();

    const acceptBtn = within(checkInRegion).getByRole('button', { name: /accept/i });
    fireEvent.click(acceptBtn);

    // Verify db.userGoals updated & lastCheckInAt set
    await waitFor(async () => {
      const updated = await db.userGoals.get('active');
      expect(updated?.lastCheckInAt).toBeDefined();
      expect(typeof updated?.lastCheckInAt).toBe('number');
    });

    // Card should disappear once accepted (within 7-day cooldown)
    await waitFor(() => {
      expect(screen.queryByTestId('weekly-checkin-card')).toBeNull();
    });

    // Undo toast should restore previous goals snapshot
    const toast = useLoggerStore.getState().undoToast;
    expect(toast).not.toBeNull();
    await toast!.onUndo();

    const restored = await db.userGoals.get('active');
    expect(restored?.dailyCalories).toBe(2200);
    expect(restored?.lastCheckInAt).toBeUndefined();
  });

  it('dismisses Weekly Check-In card and sets lastCheckInDismissedAt to snooze for 7 days', async () => {
    await seedTrendsData(today);

    render(<TrendsPage />);

    const checkInRegion = await screen.findByTestId('weekly-checkin-card');
    const dismissBtn = within(checkInRegion).getByRole('button', { name: /dismiss/i });
    fireEvent.click(dismissBtn);

    await waitFor(async () => {
      const updated = await db.userGoals.get('active');
      expect(updated?.lastCheckInDismissedAt).toBeDefined();
      expect(typeof updated?.lastCheckInDismissedAt).toBe('number');
    });

    await waitFor(() => {
      expect(screen.queryByTestId('weekly-checkin-card')).toBeNull();
    });
  });

  it('lists weight history, supports Delete with Undo, and opens WeighInDrawer on + Weigh In / Edit', async () => {
    await seedTrendsData(today);

    render(<TrendsPage />);

    // Weight history list shows the latest weigh-in note
    const historyList = await screen.findByTestId('weight-history-list');
    expect(await within(historyList).findByText(/fasted morning/i)).toBeInTheDocument();

    // Delete the latest weigh-in
    const deleteBtns = within(historyList).getAllByRole('button', { name: /delete weigh-in/i });
    const countBefore = await db.weightLogs.count();
    fireEvent.click(deleteBtns[0]);

    await waitFor(async () => {
      expect(await db.weightLogs.count()).toBe(countBefore - 1);
    });

    // Undo restores the deleted weigh-in
    const toast = useLoggerStore.getState().undoToast;
    expect(toast).not.toBeNull();
    await toast!.onUndo();

    await waitFor(async () => {
      expect(await db.weightLogs.count()).toBe(countBefore);
    });

    // Click + Weigh In opens WeighInDrawer in create mode
    fireEvent.click(screen.getByRole('button', { name: /\+ weigh in|weigh in/i }));
    expect(await screen.findByTestId('weigh-in-drawer')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /log weigh-in/i })).toBeInTheDocument();

    // Close drawer, then click Edit on a weight history row
    fireEvent.click(screen.getByRole('button', { name: /close weigh-in drawer/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('weigh-in-drawer')).toBeNull();
    });

    const editBtns = within(screen.getByTestId('weight-history-list')).getAllByRole('button', {
      name: /edit weigh-in/i,
    });
    fireEvent.click(editBtns[0]);
    expect(await screen.findByTestId('weigh-in-drawer')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /edit weigh-in/i })).toBeInTheDocument();
  });

  it('renders calm empty state with Log First Weigh-In button when no weigh-ins exist', async () => {
    await db.userGoals.put(makeGoals());

    render(<TrendsPage />);

    const logFirstBtn = await screen.findByRole('button', { name: /log first weigh-in/i });
    expect(logFirstBtn).toBeInTheDocument();
    fireEvent.click(logFirstBtn);
    expect(await screen.findByTestId('weigh-in-drawer')).toBeInTheDocument();
  });
});

describe('Dashboard refinements (cycling targets, AI Meal Ideas, Weight Trend)', () => {
  const today = toLocalIsoDate(Date.now());

  beforeEach(async () => {
    await db.foodLogs.clear();
    await db.weightLogs.clear();
    await db.userGoals.clear();
    useLoggerStore.setState({
      activeDate: today,
      activeSheet: null,
      undoToast: null,
      editingEntry: null,
    });
  });

  it('renders AI Meal Ideas and Latest Weight Trend triggers and resolves weekly cycling targets', async () => {
    await db.userGoals.put(
      makeGoals({
        dailyCalories: 2000,
        weeklyCyclingEnabled: true,
        weeklySchedule: {
          mon: { calories: 2450, proteinG: 160, carbsG: 290, fatG: 70, fiberG: 34 },
          tue: { calories: 2450, proteinG: 160, carbsG: 290, fatG: 70, fiberG: 34 },
          wed: { calories: 2450, proteinG: 160, carbsG: 290, fatG: 70, fiberG: 34 },
          thu: { calories: 2450, proteinG: 160, carbsG: 290, fatG: 70, fiberG: 34 },
          fri: { calories: 2450, proteinG: 160, carbsG: 290, fatG: 70, fiberG: 34 },
          sat: { calories: 2450, proteinG: 160, carbsG: 290, fatG: 70, fiberG: 34 },
          sun: { calories: 2450, proteinG: 160, carbsG: 290, fatG: 70, fiberG: 34 },
        },
      }),
    );
    await db.weightLogs.put(makeWeightLog(today, 79.4, 1));

    render(<HomePage />);

    // Resolved cycling target (2,450 kcal instead of base 2,000)
    await waitFor(() => {
      expect(screen.getAllByText(/2,450/).length).toBeGreaterThan(0);
    });

    // Latest Weight Trend trigger displays trend/scale weight
    expect(await screen.findByText(/79\.4 kg/i)).toBeInTheDocument();

    // AI Meal Ideas trigger opens the meal-ideas sheet
    const mealIdeasBtn = screen.getByRole('button', { name: /ai meal ideas/i });
    fireEvent.click(mealIdeasBtn);
    expect(useLoggerStore.getState().activeSheet).toBe('meal-ideas');
  });
});
