import 'fake-indexeddb/auto';
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { db } from '@/lib/db/opencalory-db';
import {
  calculateMifflinStJeorTargets,
  DEFAULT_RDA_MICROS,
  ensureDefaultUserGoals,
} from '@/lib/nutrition/goals';
import { QuickAddDrawer } from '../quick-add-drawer';
import { useLoggerStore } from '@/stores/logger-store';

describe('QuickAddDrawer and Goals Calculator', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    useLoggerStore.setState({
      activeDate: '2026-11-14',
      activeMealSlot: 'log',
      activeSheet: null,
      aiDraft: null,
    });
  });

  test('auto-calculates 4P+4C+9F calories and preserves manual calorie override', async () => {
    render(<QuickAddDrawer open date="2026-11-14" mealSlot="dinner" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/protein/i), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText(/carbs/i), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/fat/i), { target: { value: '10' } });
    expect(screen.getByLabelText(/calories/i)).toHaveValue(450);

    fireEvent.change(screen.getByLabelText(/calories/i), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText(/protein/i), { target: { value: '45' } });
    expect(screen.getByLabelText(/calories/i)).toHaveValue(500);

    fireEvent.click(screen.getByRole('button', { name: /log quick add/i }));
    await waitFor(async () => expect(await db.foodLogs.count()).toBe(1));
    const [entry] = await db.foodLogs.toArray();
    expect(entry.nutritionSnapshot.calories).toBe(500);
  });

  test('computes Mifflin-St Jeor targets', () => {
    const res = calculateMifflinStJeorTargets({
      sex: 'male',
      age: 30,
      weightKg: 80,
      heightCm: 180,
      activityMultiplier: 1.55,
      goalDeltaKcal: -300,
      proteinPerKg: 2,
    });
    expect(res.proteinG).toBe(160);
    expect(res.dailyCalories).toBeGreaterThan(2000);
  });

  test('"Sync to macros" button resets calorie override and recalculates', async () => {
    render(<QuickAddDrawer open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/protein/i), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText(/carbs/i), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/fat/i), { target: { value: '10' } });
    expect(screen.getByLabelText(/calories/i)).toHaveValue(450);

    // Override calories
    fireEvent.change(screen.getByLabelText(/calories/i), { target: { value: '600' } });
    expect(screen.getByLabelText(/calories/i)).toHaveValue(600);

    // Click "Sync to macros"
    const syncBtn = screen.getByRole('button', { name: /sync to macros/i });
    fireEvent.click(syncBtn);
    expect(screen.getByLabelText(/calories/i)).toHaveValue(450);

    // Changing protein now auto-updates calories again
    fireEvent.change(screen.getByLabelText(/protein/i), { target: { value: '50' } });
    // 50*4 + 50*4 + 10*9 = 200 + 200 + 90 = 490
    expect(screen.getByLabelText(/calories/i)).toHaveValue(490);
  });

  test('clamps negative, empty, or 0 inputs safely to 0 without NaN', async () => {
    const handleClose = vi.fn();
    render(<QuickAddDrawer open date="2026-11-14" mealSlot="breakfast" onClose={handleClose} />);

    fireEvent.change(screen.getByLabelText(/protein/i), { target: { value: '-15' } });
    fireEvent.change(screen.getByLabelText(/carbs/i), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/fat/i), { target: { value: '0' } });
    expect(screen.getByLabelText(/calories/i)).toHaveValue(0);

    fireEvent.click(screen.getByRole('button', { name: /log quick add/i }));
    await waitFor(async () => expect(await db.foodLogs.count()).toBe(1));
    const [entry] = await db.foodLogs.toArray();
    expect(entry.nutritionSnapshot.calories).toBe(0);
    expect(entry.nutritionSnapshot.protein).toBe(0);
    expect(entry.nutritionSnapshot.carbs).toBe(0);
    expect(entry.nutritionSnapshot.fat).toBe(0);
    expect(entry.nutritionSnapshot.fiber).toBe(0);
    expect(entry.source).toBe('quick_add');
    expect(handleClose).toHaveBeenCalled();
  });

  test('ensureDefaultUserGoals seeds default goals idempotently', async () => {
    const goals1 = await ensureDefaultUserGoals();
    expect(goals1.id).toBe('active');
    expect(goals1.mealSlots).toEqual([]);
    expect(goals1.targetMode).toBe('calculator');
    expect(goals1.goalDeltaKcal).toBe(0);
    expect(goals1.weightUnit).toBe('kg');
    expect(goals1.micronutrientTargets).toEqual(DEFAULT_RDA_MICROS);
    expect(await db.userGoals.count()).toBe(1);

    // Modify a field in db
    await db.userGoals.update('active', { dailyCalories: 2500 });
    const goals2 = await ensureDefaultUserGoals();
    expect(goals2.dailyCalories).toBe(2500);
    expect(await db.userGoals.count()).toBe(1);
  });

  test('useLoggerStore manages sheets, dates, meal slots, and AI draft state', () => {
    const store = useLoggerStore.getState();
    expect(store.activeSheet).toBeNull();
    expect(store.activeMealSlot).toBe('log');
    expect(store.aiDraft).toBeNull();

    store.openSheet('search');
    expect(useLoggerStore.getState().activeSheet).toBe('search');
    expect(useLoggerStore.getState().activeMealSlot).toBe('log');

    store.openSheet('quick-add', 'dinner');
    expect(useLoggerStore.getState().activeSheet).toBe('quick-add');
    expect(useLoggerStore.getState().activeMealSlot).toBe('dinner');

    store.closeSheet();
    expect(useLoggerStore.getState().activeSheet).toBeNull();

    store.setActiveDate('2026-11-20');
    expect(useLoggerStore.getState().activeDate).toBe('2026-11-20');

    store.setAiDraft({
      imageDataUrl: 'data:image/png;base64,123',
      contextPrompt: 'chicken rice',
      items: [
        {
          id: '1',
          name: 'Chicken Breast',
          grams: 150,
          per100g: { calories: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 },
          verifiedSource: 'staple',
        },
      ],
    });
    expect(useLoggerStore.getState().aiDraft?.items).toHaveLength(1);

    store.resetDraft();
    expect(useLoggerStore.getState().aiDraft).toBeNull();
  });

  test('closes on Escape key press', () => {
    const handleClose = vi.fn();
    render(<QuickAddDrawer open date="2026-11-14" mealSlot="breakfast" onClose={handleClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  test('displays adherence-neutral error banner if db.foodLogs.add fails', async () => {
    const handleClose = vi.fn();
    vi.spyOn(db.foodLogs, 'add').mockRejectedValueOnce(new Error('IndexedDB quota error'));

    render(<QuickAddDrawer open date="2026-11-14" mealSlot="lunch" onClose={handleClose} />);

    fireEvent.change(screen.getByLabelText(/protein/i), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: /log quick add/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/unable to save log entry offline/i)).toBeInTheDocument();
    });

    expect(handleClose).not.toHaveBeenCalled();
  });

  test('persists draft inputs in localStorage across remount and clears on submit', async () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <QuickAddDrawer open date="2026-11-14" mealSlot="lunch" onClose={onClose} />
    );

    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Whey Isolate' } });
    fireEvent.change(screen.getByLabelText(/protein/i), { target: { value: '30' } });
    expect(screen.getByLabelText(/calories/i)).toHaveValue(120);

    unmount();

    render(<QuickAddDrawer open date="2026-11-14" mealSlot="lunch" onClose={onClose} />);
    expect(screen.getByLabelText(/description/i)).toHaveValue('Whey Isolate');
    expect(screen.getByLabelText(/protein/i)).toHaveValue(30);
    expect(screen.getByLabelText(/calories/i)).toHaveValue(120);

    fireEvent.click(screen.getByRole('button', { name: /log quick add/i }));
    await waitFor(async () => expect(await db.foodLogs.count()).toBe(1));
    expect(window.localStorage.getItem('macro_quick_add_draft_v1')).toBeNull();
  });
});
