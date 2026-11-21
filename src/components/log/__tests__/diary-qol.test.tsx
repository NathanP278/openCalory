import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { db } from '@/lib/db/opencalory-db';
import { setStaplesCache } from '@/lib/foods/staples-search';
import {
  foodLogEntriesToRecipeIngredients,
  foodLogEntryToRecipeIngredient,
} from '@/lib/recipes/recipe-builder';
import { useLoggerStore } from '@/stores/logger-store';
import { DatePickerPopover } from '../date-picker-popover';
import { CopyFromDateDrawer } from '../copy-from-date-drawer';
import { MealSlotsView } from '../meal-slots-view';
import { RecipeBuilderModal } from '@/components/recipes/recipe-builder-modal';
import HomePage from '@/app/page';
import LogPage from '@/app/log/page';
import type { CustomRecipe, CustomRecipeIngredient, FoodItem, FoodLogEntry } from '@/types/nutrition';

vi.mock('next/navigation', () => ({
  usePathname: () => '/log',
}));

function makeEntry(
  id: string,
  date: string,
  name: string,
  overrides: Partial<{
    foodId: string;
    source: FoodLogEntry['source'];
    amount: number;
    unit: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    fiber: number;
    micros: FoodLogEntry['nutritionSnapshot']['micros'];
    createdAt: number;
  }> = {}
): FoodLogEntry {
  return {
    id,
    date,
    mealSlot: 'log',
    foodId: overrides.foodId ?? `food:${id}`,
    name,
    source: overrides.source ?? 'staple',
    amount: overrides.amount ?? 100,
    unit: overrides.unit ?? 'g',
    nutritionSnapshot: {
      calories: overrides.calories ?? 200,
      protein: overrides.protein ?? 15,
      carbs: overrides.carbs ?? 20,
      fat: overrides.fat ?? 6,
      fiber: overrides.fiber ?? 3,
      micros: overrides.micros ?? { sodiumMg: 120 },
    },
    createdAt: overrides.createdAt ?? 1000,
  };
}

function getTodayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('Task 6: Calendar Date Picker, Copy From Date & Multi-Select Save as Recipe', () => {
  beforeEach(async () => {
    setStaplesCache([]);
    window.localStorage.clear();
    await db.delete();
    await db.open();
    useLoggerStore.setState({
      activeDate: '2026-11-20',
      dateDirection: null,
      activeMealSlot: 'log',
      activeSheet: null,
      searchInitialQuery: '',
      aiDraft: null,
      editingEntry: null,
      recipeSeedIngredients: null,
      undoToast: null,
      isCommandPaletteOpen: false,
      syncAuthLocked: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('DatePickerPopover', () => {
    it('queries month foodLogs, renders Cornflower dots on logged days, navigates months, jumps to Today, and closes cleanly', async () => {
      await db.foodLogs.bulkPut([
        makeEntry('nov-10', '2026-11-10', 'Oats'),
        makeEntry('nov-18', '2026-11-18', 'Salmon'),
        makeEntry('oct-05', '2026-10-05', 'Chicken'),
      ]);

      const onSelectDate = vi.fn();
      render(
        <div>
          <div data-testid="outside-area">Outside</div>
          <DatePickerPopover
            activeDate="2026-11-20"
            onSelectDate={onSelectDate}
            trigger={<button type="button">Nov 20, 2026</button>}
          />
        </div>
      );

      // Initially closed
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      // Open via trigger
      fireEvent.click(screen.getByRole('button', { name: /nov 20, 2026/i }));

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toBeInTheDocument();
      expect(within(dialog).getByText(/november 2026/i)).toBeInTheDocument();

      // Selected day has aria-current="date"
      const selectedDayBtn = within(dialog).getByRole('button', { name: /2026-11-20/i });
      expect(selectedDayBtn).toHaveAttribute('aria-current', 'date');

      // Cornflower dot renders only on logged days in November 2026
      await waitFor(() => {
        expect(screen.getByTestId('calendar-dot-2026-11-10')).toBeInTheDocument();
        expect(screen.getByTestId('calendar-dot-2026-11-18')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('calendar-dot-2026-11-15')).not.toBeInTheDocument();
      expect(screen.getByTestId('calendar-dot-2026-11-10').style.backgroundColor).toBe(
        'var(--macro-calories)'
      );

      // Prev month shows October 2026 and its logged dot
      fireEvent.click(within(dialog).getByRole('button', { name: /previous month/i }));
      expect(within(dialog).getByText(/october 2026/i)).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByTestId('calendar-dot-2026-10-05')).toBeInTheDocument();
      });

      // Next month across year boundary: Oct -> Nov -> Dec 2026 -> Jan 2027 -> Dec 2026 -> Nov 2026
      fireEvent.click(within(dialog).getByRole('button', { name: /next month/i }));
      expect(within(dialog).getByText(/november 2026/i)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: /next month/i }));
      expect(within(dialog).getByText(/december 2026/i)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: /next month/i }));
      expect(within(dialog).getByText(/january 2027/i)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: /previous month/i }));
      expect(within(dialog).getByText(/december 2026/i)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: /previous month/i }));
      expect(within(dialog).getByText(/november 2026/i)).toBeInTheDocument();

      fireEvent.click(within(dialog).getByRole('button', { name: /2026-11-10/i }));
      expect(onSelectDate).toHaveBeenCalledWith('2026-11-10');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      // Reopen and test Today button
      fireEvent.click(screen.getByRole('button', { name: /nov 20, 2026/i }));
      const reopened = await screen.findByRole('dialog');
      fireEvent.click(within(reopened).getByRole('button', { name: /^today$/i }));
      expect(onSelectDate).toHaveBeenCalledWith(getTodayIso());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      // Reopen and close via Escape
      fireEvent.click(screen.getByRole('button', { name: /nov 20, 2026/i }));
      await screen.findByRole('dialog');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      // Reopen and close via outside click
      fireEvent.click(screen.getByRole('button', { name: /nov 20, 2026/i }));
      await screen.findByRole('dialog');
      fireEvent.mouseDown(screen.getByTestId('outside-area'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('wires DatePickerPopover onto header date triggers in both HomePage (/) and LogPage (/log) while keeping Prev/Next day buttons', async () => {
      await db.foodLogs.put(makeEntry('nov-08', '2026-11-08', 'Yogurt'));

      const { unmount } = render(<HomePage />);
      const homeTrigger = screen.getByRole('button', { name: /november 20/i });
      fireEvent.click(homeTrigger);

      const homeDialog = await screen.findByRole('dialog');
      await waitFor(() => {
        expect(screen.getByTestId('calendar-dot-2026-11-08')).toBeInTheDocument();
      });
      fireEvent.click(within(homeDialog).getByRole('button', { name: /2026-11-08/i }));
      expect(useLoggerStore.getState().activeDate).toBe('2026-11-08');
      expect(screen.getByRole('button', { name: /previous day/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /next day/i })).toBeInTheDocument();
      unmount();

      useLoggerStore.setState({ activeDate: '2026-11-20' });
      render(<LogPage />);
      const logTrigger = screen.getByRole('button', { name: /nov 20/i });
      fireEvent.click(logTrigger);

      const logDialog = await screen.findByRole('dialog');
      await waitFor(() => {
        expect(screen.getByTestId('calendar-dot-2026-11-08')).toBeInTheDocument();
      });
      fireEvent.click(within(logDialog).getByRole('button', { name: /2026-11-08/i }));
      expect(useLoggerStore.getState().activeDate).toBe('2026-11-08');
      expect(screen.getByRole('button', { name: /previous day/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /next day/i })).toBeInTheDocument();
    });
  });

  describe('CopyFromDateDrawer', () => {
    it('defaults to yesterday, copies only checked entries from any past date, and undoes exact cloned IDs', async () => {
      await db.foodLogs.bulkPut([
        makeEntry('y-1', '2026-11-19', 'Yesterday Toast', { calories: 180 }),
        makeEntry('a', '2026-11-10', 'Oats', { calories: 300, protein: 10, carbs: 54, fat: 5 }),
        makeEntry('b', '2026-11-10', 'Eggs', { calories: 140, protein: 12, carbs: 1, fat: 10 }),
      ]);

      const onClose = vi.fn();
      const { container } = render(
        <CopyFromDateDrawer open targetDate="2026-11-20" onClose={onClose} />
      );

      const sourceDateInput = screen.getByLabelText(/source date/i) as HTMLInputElement;
      expect(sourceDateInput.value).toBe('2026-11-19');
      await waitFor(() => expect(screen.getByText('Yesterday Toast')).toBeInTheDocument());

      // Switch to 2026-11-10
      fireEvent.change(sourceDateInput, { target: { value: '2026-11-10' } });
      await waitFor(() => expect(screen.getByText('Oats')).toBeInTheDocument());
      expect(screen.getByText('Eggs')).toBeInTheDocument();

      // Uncheck Eggs
      fireEvent.click(screen.getByLabelText(/select eggs/i));
      expect(screen.getByLabelText(/select oats/i)).toBeChecked();
      expect(screen.getByLabelText(/select eggs/i)).not.toBeChecked();

      // Copy Selected
      fireEvent.click(screen.getByRole('button', { name: /copy selected/i }));

      await waitFor(async () => {
        const target = await db.foodLogs.where('date').equals('2026-11-20').toArray();
        expect(target).toHaveLength(1);
        expect(target[0].name).toBe('Oats');
        expect(target[0].id).not.toBe('a');
      });
      expect(onClose).toHaveBeenCalledTimes(1);

      // Adherence neutrality: no punitive red styling
      expect(container.innerHTML).not.toMatch(/#ef4444|text-red|bg-red|border-red/i);

      // Undo removes exact cloned IDs while keeping source 2026-11-10 entries intact
      const toast = useLoggerStore.getState().undoToast;
      expect(toast).not.toBeNull();
      await act(async () => {
        await toast?.onUndo();
      });

      expect(await db.foodLogs.where('date').equals('2026-11-20').count()).toBe(0);
      expect(await db.foodLogs.where('date').equals('2026-11-10').count()).toBe(2);
    });

    it('supports 1-tap Copy All with Undo even if an entry was unchecked', async () => {
      await db.foodLogs.bulkPut([
        makeEntry('y-1', '2026-11-19', 'Chicken Rice', { calories: 520 }),
        makeEntry('y-2', '2026-11-19', 'Whey Shake', { calories: 130 }),
      ]);

      const onClose = vi.fn();
      render(<CopyFromDateDrawer open targetDate="2026-11-20" onClose={onClose} />);

      await waitFor(() => expect(screen.getByText('Chicken Rice')).toBeInTheDocument());
      fireEvent.click(screen.getByLabelText(/select whey shake/i));

      fireEvent.click(screen.getByRole('button', { name: /copy all/i }));

      await waitFor(async () => {
        const target = await db.foodLogs.where('date').equals('2026-11-20').toArray();
        expect(target.map((e) => e.name).sort()).toEqual(['Chicken Rice', 'Whey Shake']);
      });

      const toast = useLoggerStore.getState().undoToast;
      await act(async () => {
        await toast?.onUndo();
      });
      expect(await db.foodLogs.where('date').equals('2026-11-20').count()).toBe(0);
    });
  });

  describe('RecipeBuilderModal initialIngredients', () => {
    it('populates ingredients from initialIngredients without mutating saved recipes and resets on close/reopen', async () => {
      const existingRecipe: CustomRecipe = {
        id: 'existing-rec',
        name: 'Existing Chili',
        ingredients: [],
        basis: 'perServing',
        totalGrams: 400,
        nutrientsPerBasis: { calories: 450, protein: 40, carbs: 30, fat: 15, fiber: 8 },
        micronutrientsPerBasis: {},
        defaultServings: 1,
        createdAt: 100,
      };
      await db.customRecipes.put(existingRecipe);

      const seedA: CustomRecipeIngredient[] = [
        {
          foodId: 'staple:oats',
          name: 'Rolled Oats',
          amount: 80,
          unit: 'g',
          gramWeight: 80,
          gramsPerUnit: 1,
          baseBasis: 'per100g',
          nutritionSnapshot: {
            calories: 300,
            protein: 10,
            carbs: 54,
            fat: 5,
            fiber: 8,
            micros: { ironMg: 3 },
          },
        },
        {
          foodId: 'staple:egg',
          name: 'Whole Egg',
          amount: 2,
          unit: 'pcs',
          gramWeight: 100,
          gramsPerUnit: 50,
          baseBasis: 'perServing',
          nutritionSnapshot: {
            calories: 144,
            protein: 12.6,
            carbs: 0.8,
            fat: 9.6,
            fiber: 0,
            micros: { ironMg: 1.8 },
          },
        },
      ];

      const onClose = vi.fn();
      const { rerender } = render(
        <RecipeBuilderModal
          isOpen={true}
          onClose={onClose}
          initialIngredients={seedA}
        />
      );

      expect(screen.getByText('Rolled Oats')).toBeInTheDocument();
      expect(screen.getByText('Whole Egg')).toBeInTheDocument();
      expect(screen.getByText(/180g total weight/i)).toBeInTheDocument();

      fireEvent.change(screen.getByPlaceholderText(/recipe title/i), {
        target: { value: 'Morning Oats & Eggs' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save recipe/i }));
      });

      await waitFor(async () => {
        const all = await db.customRecipes.toArray();
        expect(all).toHaveLength(2);
      });

      // Existing recipe untouched
      const unchanged = await db.customRecipes.get('existing-rec');
      expect(unchanged?.name).toBe('Existing Chili');

      // New recipe has accurate nutrients and micros
      const created = (await db.customRecipes.toArray()).find(
        (r) => r.name === 'Morning Oats & Eggs'
      );
      expect(created).toBeDefined();
      expect(created?.totalGrams).toBe(180);
      expect(created?.nutrientsPerBasis.calories).toBe(444);
      expect(created?.micronutrientsPerBasis.ironMg).toBe(4.8);

      // Reopen cleanly without seedA -> should NOT leak seedA ingredients
      rerender(
        <RecipeBuilderModal isOpen={false} onClose={onClose} initialIngredients={null} />
      );
      rerender(
        <RecipeBuilderModal isOpen={true} onClose={onClose} initialIngredients={null} />
      );
      expect(screen.queryByText('Rolled Oats')).not.toBeInTheDocument();
      expect(screen.queryByText('Whole Egg')).not.toBeInTheDocument();
    });

    it('scales seeded initialIngredients cleanly on edit and resolves staples/recipes in foodLogEntriesToRecipeIngredients', async () => {
      await db.customRecipes.put({
        id: 'sauce-1',
        name: 'Teriyaki Glaze',
        ingredients: [],
        basis: 'perServing',
        totalGrams: 120,
        cookedWeightGrams: 90,
        nutrientsPerBasis: { calories: 80, protein: 2, carbs: 18, fat: 0, fiber: 0 },
        micronutrientsPerBasis: { sodiumMg: 600 },
        defaultServings: 2,
        createdAt: 100,
      });

      setStaplesCache([
        {
          id: 'staple:banana',
          source: 'staple',
          name: 'Banana',
          basis: 'perServing',
          servingSize: 1,
          servingUnit: 'pc',
          servingWeightGrams: 118,
          servingOptions: [
            { id: 'pc', label: 'pc (118g)', unit: 'pc', grams: 118, defaultAmount: 1 },
            { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
          ],
          nutrientsPerBasis: { calories: 105, protein: 1.3, carbs: 27, fat: 0.4, fiber: 3.1 },
          micronutrientsPerBasis: { potassiumMg: 422 },
          updatedAt: 100,
        },
      ]);

      const entries: FoodLogEntry[] = [
        makeEntry('e-banana', '2026-11-20', 'Banana', {
          foodId: 'staple:banana',
          amount: 2,
          unit: 'pcs',
          calories: 210,
          protein: 2.6,
          carbs: 54,
          fat: 0.8,
          fiber: 6.2,
          micros: { potassiumMg: 844 },
        }),
        makeEntry('e-sauce', '2026-11-20', 'Teriyaki Glaze', {
          foodId: 'recipe:sauce-1',
          source: 'recipe',
          amount: 1,
          unit: 'serving',
          calories: 80,
          protein: 2,
          carbs: 18,
          fat: 0,
          fiber: 0,
          micros: { sodiumMg: 600 },
        }),
        makeEntry('e-oil', '2026-11-20', 'Olive Oil', {
          foodId: 'manual:oil',
          amount: 1,
          unit: 'tbsp',
          calories: 120,
          protein: 0,
          carbs: 0,
          fat: 14,
          fiber: 0,
          micros: {},
        }),
      ];

      const converted = await foodLogEntriesToRecipeIngredients(entries);
      expect(converted).toHaveLength(3);
      // 2 bananas * 118g = 236g
      expect(converted[0].gramWeight).toBe(236);
      // 1 serving of Teriyaki Glaze with 90g cookedWeightGrams / 2 servings = 45g
      expect(converted[1].gramWeight).toBe(45);
      // 1 tbsp Olive Oil fallback = 15g
      expect(converted[2].gramWeight).toBe(15);

      const syncIng = foodLogEntryToRecipeIngredient(
        makeEntry('e-rice', '2026-11-20', 'White Rice', {
          amount: 150,
          unit: 'g',
          calories: 195,
          protein: 4,
          carbs: 42,
          fat: 0.4,
          fiber: 0.6,
        })
      );
      expect(syncIng.gramWeight).toBe(150);
      expect(syncIng.baseNutrients?.calories).toBe(130);

      render(
        <RecipeBuilderModal
          isOpen={true}
          onClose={vi.fn()}
          initialIngredients={[converted[0]]}
        />
      );
      // Edit banana amount from 2 -> 1 -> should halve calories (210 -> 105) and weight (236g -> 118g)
      const amountInput = screen.getByDisplayValue('2');
      fireEvent.change(amountInput, { target: { value: '1' } });
      expect(screen.getByText(/105 kcal/)).toBeInTheDocument();
      expect(screen.getByText(/118g total weight/i)).toBeInTheDocument();
    });
  });

  describe('/log Multi-Select Mode & MealSlotsView Integration', () => {
    it('supports Select mode -> Save as Recipe (separate explicit button) with resolved serving weights and micros', async () => {
      const eggFood: FoodItem = {
        id: 'staple:egg',
        source: 'staple',
        name: 'Boiled Egg',
        basis: 'perServing',
        servingSize: 1,
        servingUnit: 'pc',
        servingWeightGrams: 50,
        servingOptions: [
          { id: 'pc', label: 'pc (50g)', unit: 'pc', grams: 50, defaultAmount: 1 },
          { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
        ],
        nutrientsPerBasis: { calories: 72, protein: 6.3, carbs: 0.4, fat: 4.8, fiber: 0 },
        micronutrientsPerBasis: { ironMg: 0.9 },
        updatedAt: 100,
      };
      await db.foodsCache.put(eggFood);

      await db.foodLogs.bulkPut([
        makeEntry('log-1', '2026-11-20', 'Rolled Oats', {
          foodId: 'staple:oats',
          amount: 80,
          unit: 'g',
          calories: 300,
          protein: 10,
          carbs: 54,
          fat: 5,
          fiber: 8,
          micros: { magnesiumMg: 110 },
          createdAt: 100,
        }),
        makeEntry('log-2', '2026-11-20', 'Boiled Egg', {
          foodId: 'staple:egg',
          amount: 2,
          unit: 'pcs',
          calories: 144,
          protein: 12.6,
          carbs: 0.8,
          fat: 9.6,
          fiber: 0,
          micros: { ironMg: 1.8 },
          createdAt: 200,
        }),
        makeEntry('log-3', '2026-11-20', 'Black Coffee', {
          foodId: 'staple:coffee',
          amount: 250,
          unit: 'ml',
          calories: 5,
          protein: 0,
          carbs: 0,
          fat: 0,
          fiber: 0,
          micros: { caffeineMg: 95 },
          createdAt: 300,
        }),
      ]);

      render(<MealSlotsView />);

      await screen.findByText('Rolled Oats');
      fireEvent.click(screen.getByRole('button', { name: /^select$/i }));

      // Check Oats and Boiled Egg, leave Black Coffee unchecked
      fireEvent.click(screen.getByLabelText(/select rolled oats/i));
      fireEvent.click(screen.getByLabelText(/select boiled egg/i));

      const saveRecipeBtn = screen.getByRole('button', { name: /save as recipe/i });
      expect(saveRecipeBtn).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /copy to date/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /delete selected/i })).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(saveRecipeBtn);
      });

      const modal = await screen.findByRole('dialog');
      expect(within(modal).getByText('Rolled Oats')).toBeInTheDocument();
      expect(within(modal).getByText('Boiled Egg')).toBeInTheDocument();
      expect(within(modal).queryByText('Black Coffee')).not.toBeInTheDocument();
      // 80g oats + 2 * 50g egg = 180g total weight
      expect(within(modal).getByText(/180g total weight/i)).toBeInTheDocument();

      fireEvent.change(within(modal).getByPlaceholderText(/recipe title/i), {
        target: { value: 'Oats & Eggs Combo' },
      });
      await act(async () => {
        fireEvent.click(within(modal).getByRole('button', { name: /save recipe/i }));
      });

      await waitFor(async () => {
        const recipes = await db.customRecipes.toArray();
        expect(recipes).toHaveLength(1);
        expect(recipes[0].name).toBe('Oats & Eggs Combo');
        expect(recipes[0].totalGrams).toBe(180);
        expect(recipes[0].nutrientsPerBasis.calories).toBe(444);
        expect(recipes[0].micronutrientsPerBasis.magnesiumMg).toBe(110);
        expect(recipes[0].micronutrientsPerBasis.ironMg).toBe(1.8);
      });
    });

    it('supports Select mode -> Copy to Date and Delete Selected with bulk Undo and no red styling', async () => {
      await db.foodLogs.bulkPut([
        makeEntry('m-1', '2026-11-20', 'Chicken Breast', { calories: 250, createdAt: 100 }),
        makeEntry('m-2', '2026-11-20', 'Jasmine Rice', { calories: 220, createdAt: 200 }),
        makeEntry('m-3', '2026-11-20', 'Broccoli', { calories: 45, createdAt: 300 }),
      ]);

      const { container } = render(<MealSlotsView />);

      await screen.findByText('Chicken Breast');
      fireEvent.click(screen.getByRole('button', { name: /^select$/i }));

      fireEvent.click(screen.getByLabelText(/select chicken breast/i));
      fireEvent.click(screen.getByLabelText(/select jasmine rice/i));

      // Copy to Date flow
      fireEvent.click(screen.getByRole('button', { name: /copy to date/i }));
      const targetDateInput = screen.getByLabelText(/target date/i);
      fireEvent.change(targetDateInput, { target: { value: '2026-11-22' } });
      fireEvent.click(screen.getByRole('button', { name: /^copy \d|^confirm copy/i }));

      await waitFor(async () => {
        const copied = await db.foodLogs.where('date').equals('2026-11-22').toArray();
        expect(copied.map((c) => c.name).sort()).toEqual(['Chicken Breast', 'Jasmine Rice']);
      });

      // Undo copy deletes exact cloned IDs
      await act(async () => {
        await useLoggerStore.getState().undoToast?.onUndo();
      });
      expect(await db.foodLogs.where('date').equals('2026-11-22').count()).toBe(0);

      // Re-select Broccoli & Chicken Breast and Delete Selected
      fireEvent.click(screen.getByRole('button', { name: /^select$/i }));
      fireEvent.click(screen.getByLabelText(/select chicken breast/i));
      fireEvent.click(screen.getByLabelText(/select broccoli/i));

      const deleteSelectedBtn = screen.getByRole('button', { name: /delete selected/i });
      expect(container.innerHTML).not.toMatch(/#ef4444|text-red|bg-red|border-red/i);
      fireEvent.click(deleteSelectedBtn);

      await waitFor(async () => {
        const remaining = await db.foodLogs.where('date').equals('2026-11-20').toArray();
        expect(remaining.map((r) => r.name)).toEqual(['Jasmine Rice']);
      });

      // Undo restores both deleted entries
      await act(async () => {
        await useLoggerStore.getState().undoToast?.onUndo();
      });
      await waitFor(async () => {
        const restored = await db.foodLogs.where('date').equals('2026-11-20').toArray();
        expect(restored.map((r) => r.name).sort()).toEqual([
          'Broccoli',
          'Chicken Breast',
          'Jasmine Rice',
        ]);
      });
    });

    it('opens CopyFromDateDrawer from MealSlotsView Copy From Date trigger', async () => {
      await db.foodLogs.put(makeEntry('past-1', '2026-11-12', 'Tuna Melt', { calories: 410 }));

      render(<MealSlotsView />);

      const trigger = await screen.findByRole('button', { name: /copy from date/i });
      fireEvent.click(trigger);

      const drawer = await screen.findByRole('dialog');
      fireEvent.change(within(drawer).getByLabelText(/source date/i), {
        target: { value: '2026-11-12' },
      });

      await waitFor(() => expect(within(drawer).getByText('Tuna Melt')).toBeInTheDocument());
      fireEvent.click(within(drawer).getByRole('button', { name: /copy all/i }));

      await waitFor(async () => {
        const target = await db.foodLogs.where('date').equals('2026-11-20').toArray();
        expect(target).toHaveLength(1);
        expect(target[0].name).toBe('Tuna Melt');
      });
    });

    it('supports Select All / Clear and exits selection mode when activeDate changes', async () => {
      await db.foodLogs.bulkPut([
        makeEntry('d1-a', '2026-11-20', 'Oats', { calories: 250, createdAt: 100 }),
        makeEntry('d1-b', '2026-11-20', 'Whey', { calories: 120, createdAt: 200 }),
        makeEntry('d2-a', '2026-11-21', 'Steak', { calories: 500, createdAt: 100 }),
      ]);

      render(<MealSlotsView />);

      await screen.findByText('Oats');
      fireEvent.click(screen.getByRole('button', { name: /^select$/i }));
      fireEvent.click(screen.getByRole('button', { name: /^select all$/i }));

      expect(screen.getByLabelText(/select oats/i)).toBeChecked();
      expect(screen.getByLabelText(/select whey/i)).toBeChecked();
      expect(screen.getByTestId('multi-select-action-bar')).toHaveTextContent('2 selected');

      // Clicking Clear deselects all
      fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
      expect(screen.getByLabelText(/select oats/i)).not.toBeChecked();
      expect(screen.queryByTestId('multi-select-action-bar')).not.toBeInTheDocument();

      // Re-select Oats, then navigate activeDate -> exits select mode cleanly
      fireEvent.click(screen.getByLabelText(/select oats/i));
      expect(screen.getByTestId('multi-select-action-bar')).toBeInTheDocument();

      act(() => {
        useLoggerStore.getState().setActiveDate('2026-11-21');
      });

      await screen.findByText('Steak');
      expect(screen.queryByTestId('multi-select-action-bar')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^select$/i })).toBeInTheDocument();
    });
  });
});
