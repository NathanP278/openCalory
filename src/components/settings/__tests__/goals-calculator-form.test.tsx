import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { db } from '@/lib/db/opencalory-db';
import { GoalsCalculatorForm } from '../goals-calculator-form';
import {
  DEFAULT_RDA_MICROS,
  calculateMifflinStJeorTargets,
  computeWeeklyScheduleAverage,
  ensureDefaultUserGoals,
} from '@/lib/nutrition/goals';

describe('GoalsCalculatorForm', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('renders calculator form, computes Mifflin-St Jeor targets, and saves to Dexie', async () => {
    render(<GoalsCalculatorForm />);

    // Check presence of form inputs
    expect(screen.getByLabelText(/biological sex/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/age/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/weight/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/height/i)).toBeInTheDocument();

    // Fill in custom profile
    fireEvent.change(screen.getByLabelText(/biological sex/i), { target: { value: 'female' } });
    fireEvent.change(screen.getByLabelText(/age/i), { target: { value: '28' } });
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText(/height/i), { target: { value: '165' } });

    // Save button click
    const saveBtn = screen.getByRole('button', { name: /save nutrition goals/i });
    fireEvent.click(saveBtn);

    await waitFor(async () => {
      const activeGoals = await db.userGoals.get('active');
      expect(activeGoals).toBeDefined();
      expect(activeGoals?.profile?.sex).toBe('female');
      expect(activeGoals?.profile?.weightKg).toBe(60);
      expect(activeGoals?.dailyCalories).toBeGreaterThan(1200);
      expect(activeGoals?.proteinG).toBeGreaterThan(0);
    });
  });

  it('loads existing profile if present in Dexie', async () => {
    await db.userGoals.put({
      id: 'active',
      dailyCalories: 2350,
      proteinG: 170,
      carbsG: 240,
      fatG: 70,
      fiberG: 32,
      micronutrientTargets: { ...DEFAULT_RDA_MICROS },
      mealSlots: [],
      profile: {
        sex: 'male',
        age: 35,
        weightKg: 85,
        heightCm: 182,
        activityMultiplier: 1.55,
        goalDeltaKcal: 0,
        proteinPerKg: 2,
      },
      updatedAt: Date.now(),
    });

    render(<GoalsCalculatorForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/weight/i)).toHaveValue(85);
      expect(screen.getByLabelText(/age/i)).toHaveValue(35);
      expect(screen.getByLabelText(/height/i)).toHaveValue(182);
    });
  });

  it('preserves coached targets when toggling weight unit and saving preferences', async () => {
    const coachedAt = Date.now() - 86_400_000;
    await db.userGoals.put({
      id: 'active',
      dailyCalories: 2350,
      proteinG: 175,
      carbsG: 255,
      fatG: 70,
      fiberG: 33,
      micronutrientTargets: { ...DEFAULT_RDA_MICROS },
      mealSlots: [],
      targetMode: 'calculator',
      goalDeltaKcal: -250,
      weightUnit: 'kg',
      lastCheckInAt: coachedAt,
      profile: {
        sex: 'male',
        age: 30,
        weightKg: 75,
        heightCm: 175,
        activityMultiplier: 1.55,
        goalDeltaKcal: -250,
        proteinPerKg: 2.0,
      },
      updatedAt: Date.now(),
    });

    render(<GoalsCalculatorForm />);

    await waitFor(() => {
      expect(screen.getByText(/coached/i)).toBeInTheDocument();
      expect(screen.getByText(/2,350 kcal/i)).toBeInTheDocument();
    });

    // Toggle Weight Display Unit to lb
    fireEvent.click(screen.getByRole('button', { name: /^lb$/i }));

    // Save preferences without clicking Recalculate
    fireEvent.click(screen.getByRole('button', { name: /save nutrition goals/i }));

    await waitFor(async () => {
      const saved = await db.userGoals.get('active');
      expect(saved?.weightUnit).toBe('lb');
      expect(saved?.dailyCalories).toBe(2350);
      expect(saved?.proteinG).toBe(175);
      expect(saved?.carbsG).toBe(255);
      expect(saved?.fatG).toBe(70);
      expect(saved?.fiberG).toBe(33);
      expect(saved?.lastCheckInAt).toBe(coachedAt);
      expect(saved?.targetMode).toBe('calculator');
    });
  });

  it('recalculates and saves Mifflin-St Jeor targets only when explicitly requested', async () => {
    await db.userGoals.put({
      id: 'active',
      dailyCalories: 2350,
      proteinG: 175,
      carbsG: 255,
      fatG: 70,
      fiberG: 33,
      micronutrientTargets: { ...DEFAULT_RDA_MICROS },
      mealSlots: [],
      targetMode: 'calculator',
      goalDeltaKcal: 0,
      weightUnit: 'kg',
      lastCheckInAt: Date.now() - 86_400_000,
      profile: {
        sex: 'male',
        age: 30,
        weightKg: 80,
        heightCm: 180,
        activityMultiplier: 1.55,
        goalDeltaKcal: 0,
        proteinPerKg: 2.0,
      },
      updatedAt: Date.now(),
    });

    const expected = calculateMifflinStJeorTargets({
      sex: 'male',
      age: 30,
      weightKg: 80,
      heightCm: 180,
      activityMultiplier: 1.55,
      goalDeltaKcal: 0,
      proteinPerKg: 2.0,
    });

    render(<GoalsCalculatorForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/weight/i)).toHaveValue(80);
    });

    fireEvent.click(
      screen.getByRole('button', { name: /recalculate from mifflin-st jeor/i })
    );
    fireEvent.click(screen.getByRole('button', { name: /save nutrition goals/i }));

    await waitFor(async () => {
      const saved = await db.userGoals.get('active');
      expect(saved?.dailyCalories).toBe(expected.dailyCalories);
      expect(saved?.proteinG).toBe(expected.proteinG);
      expect(saved?.carbsG).toBe(expected.carbsG);
      expect(saved?.fatG).toBe(expected.fatG);
      expect(saved?.fiberG).toBe(expected.fiberG);
    });
  });

  it('saves direct custom targets, shared goalDeltaKcal, weekly calorie cycling, and custom micro/extended targets', async () => {
    render(<GoalsCalculatorForm />);

    // Switch to Custom Targets mode
    fireEvent.click(screen.getByRole('tab', { name: /custom targets/i }));

    fireEvent.change(screen.getByLabelText(/daily calories/i), {
      target: { value: '2150' },
    });
    fireEvent.change(screen.getByLabelText(/^protein \(g\)$/i), {
      target: { value: '165' },
    });
    fireEvent.change(screen.getByLabelText(/^carbs \(g\)$/i), {
      target: { value: '220' },
    });
    fireEvent.change(screen.getByLabelText(/^fat \(g\)$/i), {
      target: { value: '65' },
    });
    fireEvent.change(screen.getByLabelText(/^fiber \(g\)$/i), {
      target: { value: '32' },
    });

    // Set shared goal rate
    fireEvent.change(screen.getByLabelText(/goal rate/i), {
      target: { value: '-250' },
    });

    // Open Weekly Calorie Cycling editor and enable cycling
    fireEvent.click(screen.getByRole('button', { name: /weekly calorie cycling/i }));
    fireEvent.click(screen.getByLabelText(/enable weekly calorie cycling/i));
    fireEvent.click(screen.getByRole('button', { name: /higher weekend/i }));
    fireEvent.change(screen.getByLabelText(/fri calories/i), {
      target: { value: '2450' },
    });

    // Open Custom Micronutrient Targets editor and customize Sodium + Caffeine
    fireEvent.click(screen.getByRole('button', { name: /custom micronutrient targets/i }));
    fireEvent.change(screen.getByLabelText(/sodium \(mg\)/i), {
      target: { value: '2000' },
    });
    fireEvent.change(screen.getByLabelText(/caffeine \(mg\)/i), {
      target: { value: '300' },
    });

    // Save
    fireEvent.click(screen.getByRole('button', { name: /save nutrition goals/i }));

    await waitFor(async () => {
      const saved = await db.userGoals.get('active');
      const expectedAvg = computeWeeklyScheduleAverage(saved!.weeklySchedule!);
      expect(saved?.targetMode).toBe('custom');
      expect(saved?.dailyCalories).toBe(expectedAvg.calories);
      expect(saved?.dailyCalories).toBe(2157);
      expect(saved?.proteinG).toBe(expectedAvg.proteinG);
      expect(saved?.carbsG).toBe(expectedAvg.carbsG);
      expect(saved?.fatG).toBe(expectedAvg.fatG);
      expect(saved?.fiberG).toBe(expectedAvg.fiberG);
      expect(saved?.goalDeltaKcal).toBe(-250);
      expect(saved?.weeklyCyclingEnabled).toBe(true);
      expect(saved?.weeklySchedule?.fri?.calories).toBe(2450);
      expect(saved?.micronutrientTargets?.sodiumMg).toBe(2000);
      expect(saved?.micronutrientTargets?.caffeineMg).toBe(300);
    });
  });

  it('resets custom micronutrient and extended targets back to Adult RDA defaults', async () => {
    await db.userGoals.put({
      id: 'active',
      dailyCalories: 2100,
      proteinG: 160,
      carbsG: 210,
      fatG: 65,
      fiberG: 30,
      micronutrientTargets: {
        ...DEFAULT_RDA_MICROS,
        sodiumMg: 1500,
        caffeineMg: 150,
      },
      mealSlots: [],
      updatedAt: Date.now(),
    });

    render(<GoalsCalculatorForm />);

    fireEvent.click(screen.getByRole('button', { name: /custom micronutrient targets/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/sodium \(mg\)/i)).toHaveValue(1500);
      expect(screen.getByLabelText(/caffeine \(mg\)/i)).toHaveValue(150);
    });

    fireEvent.click(screen.getByRole('button', { name: /reset to adult rda defaults/i }));

    expect(screen.getByLabelText(/sodium \(mg\)/i)).toHaveValue(2300);
    expect(screen.getByLabelText(/caffeine \(mg\)/i)).toHaveValue(400);
  });

  it('does not lock onto 2000 kcal seed from ensureDefaultUserGoals and saves computed Mifflin-St Jeor targets', async () => {
    await ensureDefaultUserGoals();

    const defaultExpected = calculateMifflinStJeorTargets({
      sex: 'male',
      age: 30,
      weightKg: 75,
      heightCm: 175,
      activityMultiplier: 1.55,
      goalDeltaKcal: -300,
      proteinPerKg: 2.0,
    });

    const editedExpected = calculateMifflinStJeorTargets({
      sex: 'female',
      age: 28,
      weightKg: 60,
      heightCm: 165,
      activityMultiplier: 1.55,
      goalDeltaKcal: -250,
      proteinPerKg: 2.0,
    });

    render(<GoalsCalculatorForm />);

    // Flush async loadGoals() effect and verify Active Daily Targets does NOT lock onto 2,000 kcal seed
    await waitFor(async () => {
      const seed = await db.userGoals.get('active');
      expect(seed?.updatedAt).toBe(0);
      expect(screen.getByTestId('active-targets-calories')).toHaveTextContent(
        new RegExp(`${defaultExpected.dailyCalories.toLocaleString()} kcal`, 'i')
      );
    });

    fireEvent.change(screen.getByLabelText(/biological sex/i), { target: { value: 'female' } });
    fireEvent.change(screen.getByLabelText(/age/i), { target: { value: '28' } });
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText(/height/i), { target: { value: '165' } });
    fireEvent.change(screen.getByLabelText(/goal rate/i), { target: { value: '-250' } });

    await waitFor(() => {
      expect(screen.getByTestId('active-targets-calories')).toHaveTextContent(
        new RegExp(`${editedExpected.dailyCalories.toLocaleString()} kcal`, 'i')
      );
    });

    fireEvent.click(screen.getByRole('button', { name: /save nutrition goals/i }));

    await waitFor(async () => {
      const saved = await db.userGoals.get('active');
      expect(saved?.dailyCalories).toBe(editedExpected.dailyCalories);
      expect(saved?.dailyCalories).not.toBe(2000);
      expect(saved?.proteinG).toBe(editedExpected.proteinG);
      expect(saved?.carbsG).toBe(editedExpected.carbsG);
      expect(saved?.fatG).toBe(editedExpected.fatG);
      expect(saved?.fiberG).toBe(editedExpected.fiberG);
      expect(saved?.updatedAt).toBeGreaterThan(0);
    });
  });

  it('syncs weekly cycling average to Active Daily Targets and saved top-level dailyCalories when toggling and editing weekday rows', async () => {
    await db.userGoals.put({
      id: 'active',
      dailyCalories: 2350,
      proteinG: 175,
      carbsG: 255,
      fatG: 70,
      fiberG: 33,
      micronutrientTargets: { ...DEFAULT_RDA_MICROS },
      mealSlots: [],
      targetMode: 'custom',
      goalDeltaKcal: 0,
      weightUnit: 'kg',
      updatedAt: Date.now(),
    });

    render(<GoalsCalculatorForm />);

    await waitFor(() => {
      expect(screen.getByTestId('active-targets-calories')).toHaveTextContent(/2,350 kcal/i);
    });

    fireEvent.click(screen.getByRole('button', { name: /weekly calorie cycling/i }));
    fireEvent.click(screen.getByLabelText(/enable weekly calorie cycling/i));

    // Initializes from active 2350 kcal (not 2000 kcal placeholder) even when hasSavedGoals is true
    expect(screen.getByLabelText(/mon calories/i)).toHaveValue(2350);

    // Edit Mon to 2700 -> 7-day average becomes (2350 * 6 + 2700) / 7 = 2400 kcal
    fireEvent.change(screen.getByLabelText(/mon calories/i), { target: { value: '2700' } });

    await waitFor(() => {
      expect(screen.getByTestId('active-targets-calories')).toHaveTextContent(/2,400 kcal/i);
    });

    fireEvent.click(screen.getByRole('button', { name: /save nutrition goals/i }));

    await waitFor(async () => {
      const saved = await db.userGoals.get('active');
      const expectedAvg = computeWeeklyScheduleAverage(saved!.weeklySchedule!);
      expect(expectedAvg.calories).toBe(2400);
      expect(saved?.dailyCalories).toBe(2400);
      expect(saved?.proteinG).toBe(expectedAvg.proteinG);
      expect(saved?.carbsG).toBe(expectedAvg.carbsG);
      expect(saved?.fatG).toBe(expectedAvg.fatG);
      expect(saved?.fiberG).toBe(expectedAvg.fiberG);
    });
  });
});
