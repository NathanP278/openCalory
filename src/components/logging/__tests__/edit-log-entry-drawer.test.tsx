import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { db } from '@/lib/db/opencalory-db';
import {
  flushPendingMutationsForTests,
  setCloudSyncEnabledForTests,
} from '@/lib/db/cloud-sync';
import { setStaplesCache } from '@/lib/foods/staples-search';
import { useLoggerStore } from '@/stores/logger-store';
import { EditLogEntryDrawer } from '../edit-log-entry-drawer';
import { AppShell } from '@/components/shell/app-shell';
import HomePage from '@/app/page';
import { MealSlotsView } from '@/components/log/meal-slots-view';
import type { CustomRecipe, FoodItem, FoodLogEntry } from '@/types/nutrition';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

function makeEntry(overrides: {
  id?: string;
  date?: string;
  foodId?: string;
  name?: string;
  source?: FoodLogEntry['source'];
  amount?: number;
  unit?: string;
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  sodiumMg?: number;
  micros?: FoodLogEntry['nutritionSnapshot']['micros'];
  note?: string;
  createdAt?: number;
} = {}): FoodLogEntry {
  const micros = {
    ...(overrides.sodiumMg !== undefined ? { sodiumMg: overrides.sodiumMg } : {}),
    ...(overrides.micros ?? {}),
  };
  return {
    id: overrides.id ?? 'entry-1',
    date: overrides.date ?? '2026-11-20',
    mealSlot: 'log',
    foodId: overrides.foodId ?? 'unresolved:food-1',
    name: overrides.name ?? 'Grilled Chicken Bowl',
    source: overrides.source ?? 'usda',
    amount: overrides.amount ?? 100,
    unit: overrides.unit ?? 'g',
    nutritionSnapshot: {
      calories: overrides.calories ?? 200,
      protein: overrides.protein ?? 20,
      carbs: overrides.carbs ?? 10,
      fat: overrides.fat ?? 5,
      fiber: overrides.fiber ?? 2,
      micros,
    },
    ...(overrides.note !== undefined ? { note: overrides.note } : {}),
    createdAt: overrides.createdAt ?? 1000,
  };
}

describe('EditLogEntryDrawer & Notes Display', () => {
  beforeEach(async () => {
    setStaplesCache([]);
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
    setCloudSyncEnabledForTests(false);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders nothing when entry is null', () => {
    const { container } = render(<EditLogEntryDrawer entry={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('rescales macros and micros proportionally when amount changes, moves date, and saves note', async () => {
    const onClose = vi.fn();
    const entry = makeEntry({
      id: 'e-1',
      date: '2026-11-20',
      amount: 100,
      calories: 200,
      protein: 20,
      carbs: 10,
      fat: 5,
      fiber: 2,
      sodiumMg: 100,
      micros: {
        sugarG: 4,
        saturatedFatG: 1.5,
        caffeineMg: 40,
      },
    });
    await db.foodLogs.put(entry);

    const { container } = render(<EditLogEntryDrawer entry={entry} onClose={onClose} />);

    fireEvent.change(screen.getByLabelText(/portion amount/i), { target: { value: '150' } });
    fireEvent.change(screen.getByLabelText(/log date/i), { target: { value: '2026-11-19' } });
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: 'Post-workout' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(async () => {
      const saved = await db.foodLogs.get('e-1');
      expect(saved?.amount).toBe(150);
      expect(saved?.date).toBe('2026-11-19');
      expect(saved?.note).toBe('Post-workout');
      expect(saved?.nutritionSnapshot.calories).toBe(300);
      expect(saved?.nutritionSnapshot.protein).toBe(30);
      expect(saved?.nutritionSnapshot.carbs).toBe(15);
      expect(saved?.nutritionSnapshot.fat).toBe(7.5);
      expect(saved?.nutritionSnapshot.fiber).toBe(3);
      expect(saved?.nutritionSnapshot.micros.sodiumMg).toBe(150);
      expect(saved?.nutritionSnapshot.micros.sugarG).toBe(6);
      expect(saved?.nutritionSnapshot.micros.saturatedFatG).toBe(2.25);
      expect(saved?.nutritionSnapshot.micros.caffeineMg).toBe(60);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useLoggerStore.getState().undoToast).not.toBeNull();

    // Adherence neutrality: never render red alert classes
    expect(container.innerHTML).not.toMatch(/#ef4444|text-red|bg-red|border-red|destructive/i);
  });

  it('resolves entry.foodId from db.foodsCache to show FoodServingOption pills and converts units', async () => {
    const eggMcMuffin: FoodItem = {
      id: 'ph:mcdo-egg-mcmuffin',
      source: 'staple',
      name: 'Egg McMuffin',
      brand: "McDonald's",
      region: 'PH',
      basis: 'perServing',
      servingSize: 1,
      servingUnit: 'pc',
      servingWeightGrams: 136,
      servingOptions: [
        { id: 'pc', label: 'pc (136g)', unit: 'pc', grams: 136, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
      nutrientsPerBasis: { calories: 310, protein: 17, carbs: 30, fat: 13, fiber: 2 },
      micronutrientsPerBasis: { sodiumMg: 770 },
      updatedAt: 1000,
    };
    await db.foodsCache.put(eggMcMuffin);

    const entry = makeEntry({
      id: 'e-cache',
      foodId: 'ph:mcdo-egg-mcmuffin',
      name: 'Egg McMuffin',
      source: 'staple',
      amount: 1,
      unit: 'pc',
      calories: 310,
      protein: 17,
      carbs: 30,
      fat: 13,
      fiber: 2,
      sodiumMg: 770,
    });
    await db.foodLogs.put(entry);

    render(<EditLogEntryDrawer entry={entry} onClose={vi.fn()} />);

    const group = await screen.findByRole('group', { name: /serving unit options/i });
    expect(within(group).getByRole('button', { name: 'pc (136g)' })).toHaveAttribute('aria-pressed', 'true');
    const gramsPill = within(group).getByRole('button', { name: 'g' });

    fireEvent.click(gramsPill);
    expect(screen.getByLabelText(/portion unit/i)).toHaveValue('g');
    expect(screen.getByLabelText(/portion amount/i)).toHaveValue(136);

    fireEvent.change(screen.getByLabelText(/portion amount/i), { target: { value: '68' } });
    expect(screen.getByText('155 kcal')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(async () => {
      const saved = await db.foodLogs.get('e-cache');
      expect(saved?.amount).toBe(68);
      expect(saved?.unit).toBe('g');
      expect(saved?.nutritionSnapshot.calories).toBe(155);
      expect(saved?.nutritionSnapshot.protein).toBe(8.5);
      expect(saved?.nutritionSnapshot.micros.sodiumMg).toBe(385);
    });
  });

  it('resolves entry.foodId from loadStaples() when not in foodsCache', async () => {
    const stapleItem: FoodItem = {
      id: 'staple:banana',
      source: 'staple',
      name: 'Banana, raw',
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
      updatedAt: 1000,
    };
    setStaplesCache([stapleItem]);

    const entry = makeEntry({
      id: 'e-staple',
      foodId: 'staple:banana',
      name: 'Banana, raw',
      source: 'staple',
      amount: 1,
      unit: 'pc',
      calories: 105,
      protein: 1.3,
      carbs: 27,
      fat: 0.4,
      fiber: 3.1,
      micros: { potassiumMg: 422 },
    });
    await db.foodLogs.put(entry);

    render(<EditLogEntryDrawer entry={entry} onClose={vi.fn()} />);

    await screen.findByRole('group', { name: /serving unit options/i });
    fireEvent.change(screen.getByLabelText(/portion amount/i), { target: { value: '2' } });
    expect(screen.getByLabelText(/portion unit/i)).toHaveValue('pcs');
    expect(screen.getByText('210 kcal')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(async () => {
      const saved = await db.foodLogs.get('e-staple');
      expect(saved?.amount).toBe(2);
      expect(saved?.unit).toBe('pcs');
      expect(saved?.nutritionSnapshot.calories).toBe(210);
      expect(saved?.nutritionSnapshot.micros.potassiumMg).toBe(844);
    });
  });

  it('resolves recipe entries from db.customRecipes and scales across servings and grams', async () => {
    const recipe: CustomRecipe = {
      id: 'rec-oats',
      name: 'Protein Oats',
      ingredients: [],
      basis: 'perServing',
      totalGrams: 300,
      nutrientsPerBasis: { calories: 400, protein: 30, carbs: 50, fat: 8, fiber: 6 },
      micronutrientsPerBasis: { ironMg: 3.6 },
      defaultServings: 1,
      createdAt: 1000,
    };
    await db.customRecipes.put(recipe);

    const entry = makeEntry({
      id: 'e-recipe',
      foodId: 'recipe:rec-oats',
      name: 'Protein Oats',
      source: 'recipe',
      amount: 1,
      unit: 'serving',
      calories: 400,
      protein: 30,
      carbs: 50,
      fat: 8,
      fiber: 6,
      micros: { ironMg: 3.6 },
    });
    await db.foodLogs.put(entry);

    render(<EditLogEntryDrawer entry={entry} onClose={vi.fn()} />);

    const group = await screen.findByRole('group', { name: /serving unit options/i });
    expect(within(group).getByRole('button', { name: /serving \(300g\)/i })).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: 'g' }));
    expect(screen.getByLabelText(/portion amount/i)).toHaveValue(300);

    fireEvent.change(screen.getByLabelText(/portion amount/i), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(async () => {
      const saved = await db.foodLogs.get('e-recipe');
      expect(saved?.amount).toBe(150);
      expect(saved?.unit).toBe('g');
      expect(saved?.nutritionSnapshot.calories).toBe(200);
      expect(saved?.nutritionSnapshot.protein).toBe(15);
      expect(saved?.nutritionSnapshot.micros.ironMg).toBe(1.8);
    });
  });

  it('guards against division by zero when entry.amount is 0 and invalid inputs', async () => {
    const entry = makeEntry({
      id: 'e-zero',
      amount: 0,
      calories: 200,
      protein: 20,
      carbs: 10,
      fat: 5,
      fiber: 2,
      sodiumMg: 100,
    });
    await db.foodLogs.put(entry);

    render(<EditLogEntryDrawer entry={entry} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/portion amount/i), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(async () => {
      const saved = await db.foodLogs.get('e-zero');
      expect(saved?.amount).toBe(100);
      expect(Number.isFinite(saved?.nutritionSnapshot.calories)).toBe(true);
      expect(saved?.nutritionSnapshot.calories).toBe(200);
      expect(saved?.nutritionSnapshot.micros.sodiumMg).toBe(100);
    });
  });

  it('defaults "Edit macros directly" ON for quick_add entries, supports direct edits, and trims empty notes', async () => {
    const entry = makeEntry({
      id: 'e-qa',
      foodId: 'quick-add-1',
      name: 'Protein Shake',
      source: 'quick_add',
      amount: 1,
      unit: 'serving',
      calories: 150,
      protein: 25,
      carbs: 5,
      fat: 2,
      fiber: 1,
      note: 'Morning shake',
    });
    await db.foodLogs.put(entry);

    render(<EditLogEntryDrawer entry={entry} onClose={vi.fn()} />);

    const toggle = screen.getByRole('switch', { name: /edit macros directly/i });
    expect(toggle).toBeChecked();

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Double Scoop Whey' } });
    fireEvent.change(screen.getByLabelText(/protein/i), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/carbs/i), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText(/fat/i), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/fiber/i), { target: { value: '1' } });
    // 50*4 + 4*4 + 2*9 = 234 kcal auto-recalculated from macros
    expect(screen.getByLabelText(/calories/i)).toHaveValue(234);
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: '   ' } });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(async () => {
      const saved = await db.foodLogs.get('e-qa');
      expect(saved?.name).toBe('Double Scoop Whey');
      expect(saved?.nutritionSnapshot.calories).toBe(234);
      expect(saved?.nutritionSnapshot.protein).toBe(50);
      expect(saved?.nutritionSnapshot.carbs).toBe(4);
      expect(saved?.nutritionSnapshot.fat).toBe(2);
      expect(saved?.nutritionSnapshot.fiber).toBe(1);
      expect(saved?.note).toBeUndefined();
    });
  });

  it('recalculates calories when editing macros and proportionally scales macros when editing calories (including clear & retype)', async () => {
    const entry = makeEntry({
      id: 'e-bidir',
      name: 'Chicken Bowl',
      source: 'usda',
      amount: 100,
      unit: 'g',
      calories: 200,
      protein: 20,
      carbs: 15,
      fat: 6,
      fiber: 2,
    });
    await db.foodLogs.put(entry);

    render(<EditLogEntryDrawer entry={entry} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('switch', { name: /edit macros directly/i }));

    // 1) Editing calories -> proportionally scales macros from anchor (200 -> 400 doubles macros)
    fireEvent.change(screen.getByLabelText(/calories/i), { target: { value: '' } });
    expect(screen.getByLabelText(/protein/i)).toHaveValue(0);
    fireEvent.change(screen.getByLabelText(/calories/i), { target: { value: '400' } });
    expect(screen.getByLabelText(/protein/i)).toHaveValue(40);
    expect(screen.getByLabelText(/carbs/i)).toHaveValue(30);
    expect(screen.getByLabelText(/fat/i)).toHaveValue(12);
    expect(screen.getByLabelText(/fiber/i)).toHaveValue(4);

    // 2) Editing a macro -> recalculates calories using 4-4-9 (30*4 + 30*4 + 12*9 = 348)
    fireEvent.change(screen.getByLabelText(/protein/i), { target: { value: '30' } });
    expect(screen.getByLabelText(/calories/i)).toHaveValue(348);

    // 3) Subsequent calorie edit scales from the updated macro anchor (348 -> 174 halves macros)
    fireEvent.change(screen.getByLabelText(/calories/i), { target: { value: '174' } });
    expect(screen.getByLabelText(/protein/i)).toHaveValue(15);
    expect(screen.getByLabelText(/carbs/i)).toHaveValue(15);
    expect(screen.getByLabelText(/fat/i)).toHaveValue(6);
    expect(screen.getByLabelText(/fiber/i)).toHaveValue(2);

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(async () => {
      const saved = await db.foodLogs.get('e-bidir');
      expect(saved?.nutritionSnapshot.calories).toBe(174);
      expect(saved?.nutritionSnapshot.protein).toBe(15);
      expect(saved?.nutritionSnapshot.carbs).toBe(15);
      expect(saved?.nutritionSnapshot.fat).toBe(6);
      expect(saved?.nutritionSnapshot.fiber).toBe(2);
    });
  });

  it('toggles "Edit macros directly" OFF->ON on standard entry, preserves micros, and restores previous snapshot on Undo', async () => {
    const entry = makeEntry({
      id: 'e-undo',
      date: '2026-11-20',
      name: 'Salmon Fillet',
      source: 'usda',
      amount: 100,
      unit: 'g',
      calories: 208,
      protein: 20,
      carbs: 0,
      fat: 13,
      fiber: 0,
      sodiumMg: 59,
      note: 'Air fried',
    });
    await db.foodLogs.put(entry);

    render(<EditLogEntryDrawer entry={entry} onClose={vi.fn()} />);

    const toggle = screen.getByRole('switch', { name: /edit macros directly/i });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();

    fireEvent.change(screen.getByLabelText(/calories/i), { target: { value: '245' } });
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: 'With olive oil' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(async () => {
      const saved = await db.foodLogs.get('e-undo');
      expect(saved?.nutritionSnapshot.calories).toBe(245);
      expect(saved?.nutritionSnapshot.micros.sodiumMg).toBe(59);
      expect(saved?.note).toBe('With olive oil');
    });

    const toast = useLoggerStore.getState().undoToast;
    expect(toast).not.toBeNull();

    await act(async () => {
      await toast?.onUndo();
    });

    const restored = await db.foodLogs.get('e-undo');
    expect(restored?.nutritionSnapshot.calories).toBe(208);
    expect(restored?.nutritionSnapshot.micros.sodiumMg).toBe(59);
    expect(restored?.note).toBe('Air fried');
  });

  it('resets local form state when switching entry prop and closes on Escape', () => {
    const onClose = vi.fn();
    const entryA = makeEntry({ id: 'a', name: 'Entry A', amount: 100, note: 'Note A' });
    const entryB = makeEntry({ id: 'b', name: 'Entry B', amount: 250, note: 'Note B' });

    const { rerender } = render(<EditLogEntryDrawer entry={entryA} onClose={onClose} />);
    expect(screen.getByLabelText(/portion amount/i)).toHaveValue(100);
    expect(screen.getByLabelText(/note/i)).toHaveValue('Note A');

    fireEvent.change(screen.getByLabelText(/portion amount/i), { target: { value: '999' } });
    rerender(<EditLogEntryDrawer entry={entryB} onClose={onClose} />);

    expect(screen.getByLabelText(/portion amount/i)).toHaveValue(250);
    expect(screen.getByLabelText(/note/i)).toHaveValue('Note B');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wires Edit button and note display on HomePage (/) through AppShell', async () => {
    const entry = makeEntry({
      id: 'home-e1',
      date: '2026-11-20',
      name: 'Beef Tapa',
      amount: 150,
      unit: 'g',
      calories: 320,
      protein: 28,
      carbs: 8,
      fat: 18,
      fiber: 0,
      note: 'Pre-lift meal',
    });
    await db.foodLogs.put(entry);

    render(<HomePage />);

    const rowTitle = await screen.findByText('Beef Tapa');
    const rowBtn = rowTitle.closest('button')!;
    fireEvent.click(rowBtn);

    expect(screen.getByText('Pre-lift meal')).toBeInTheDocument();
    const editBtn = screen.getByRole('button', { name: /^edit$/i });
    expect(editBtn).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log again/i })).toBeInTheDocument();

    fireEvent.click(editBtn);

    const dialog = await screen.findByTestId('edit-log-entry-drawer');
    expect(dialog).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/portion amount/i), { target: { value: '300' } });
    fireEvent.change(within(dialog).getByLabelText(/note/i), { target: { value: 'Updated home note' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(async () => {
      const saved = await db.foodLogs.get('home-e1');
      expect(saved?.amount).toBe(300);
      expect(saved?.nutritionSnapshot.calories).toBe(640);
      expect(saved?.note).toBe('Updated home note');
    });

    await waitFor(() => {
      expect(screen.queryByTestId('edit-log-entry-drawer')).not.toBeInTheDocument();
      expect(screen.getByText('Updated home note')).toBeInTheDocument();
    });

    // Undo toast in AppShell restores original entry
    const undoBtn = await screen.findByRole('button', { name: 'Undo' });
    fireEvent.click(undoBtn);

    await waitFor(async () => {
      const restored = await db.foodLogs.get('home-e1');
      expect(restored?.amount).toBe(150);
      expect(restored?.nutritionSnapshot.calories).toBe(320);
      expect(restored?.note).toBe('Pre-lift meal');
    });
  });

  it('wires Edit button and note display on MealSlotsView (/log) through AppShell', async () => {
    const entry = makeEntry({
      id: 'log-e1',
      date: '2026-11-20',
      name: 'Greek Yogurt',
      amount: 200,
      unit: 'g',
      calories: 140,
      protein: 20,
      carbs: 8,
      fat: 2,
      fiber: 0,
      note: 'With berries',
    });
    await db.foodLogs.put(entry);

    render(
      <AppShell>
        <MealSlotsView />
      </AppShell>
    );

    const rowTitle = await screen.findByText('Greek Yogurt');
    const rowBtn = rowTitle.closest('button')!;
    fireEvent.click(rowBtn);

    expect(screen.getByText('With berries')).toBeInTheDocument();
    const editBtn = screen.getByRole('button', { name: /^edit$/i });
    expect(editBtn).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log again/i })).toBeInTheDocument();

    fireEvent.click(editBtn);

    const dialog = await screen.findByTestId('edit-log-entry-drawer');
    fireEvent.change(within(dialog).getByLabelText(/portion amount/i), { target: { value: '100' } });
    fireEvent.change(within(dialog).getByLabelText(/note/i), { target: { value: 'Plain bowl' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(async () => {
      const saved = await db.foodLogs.get('log-e1');
      expect(saved?.amount).toBe(100);
      expect(saved?.nutritionSnapshot.calories).toBe(70);
      expect(saved?.note).toBe('Plain bowl');
    });

    await waitFor(() => {
      expect(screen.getByText('Plain bowl')).toBeInTheDocument();
    });
  });

  it('resolves per100g recipes with cookedWeightGrams and scales servings <-> grams cleanly', async () => {
    const recipe: CustomRecipe = {
      id: 'rec-chili',
      name: 'Turkey Chili',
      ingredients: [],
      basis: 'per100g',
      totalGrams: 500,
      cookedWeightGrams: 400,
      nutrientsPerBasis: { calories: 150, protein: 16, carbs: 12, fat: 4, fiber: 3 },
      micronutrientsPerBasis: { ironMg: 2 },
      defaultServings: 2,
      createdAt: 1000,
    };
    await db.customRecipes.put(recipe);

    const entry = makeEntry({
      id: 'e-chili',
      foodId: 'recipe:rec-chili',
      name: 'Turkey Chili',
      source: 'recipe',
      amount: 200,
      unit: 'g',
      calories: 300,
      protein: 32,
      carbs: 24,
      fat: 8,
      fiber: 6,
      micros: { ironMg: 4 },
    });
    await db.foodLogs.put(entry);

    render(<EditLogEntryDrawer entry={entry} onClose={vi.fn()} />);

    const group = await screen.findByRole('group', { name: /serving unit options/i });
    const servingPill = within(group).getByRole('button', { name: /serving \(200g\)/i });
    fireEvent.click(servingPill);
    expect(screen.getByLabelText(/portion amount/i)).toHaveValue(1);
    expect(screen.getByLabelText(/portion unit/i)).toHaveValue('serving');

    fireEvent.change(screen.getByLabelText(/portion amount/i), { target: { value: '1.5' } });
    expect(screen.getByText('450 kcal')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(async () => {
      const saved = await db.foodLogs.get('e-chili');
      expect(saved?.amount).toBe(1.5);
      expect(saved?.unit).toBe('servings');
      expect(saved?.nutritionSnapshot.calories).toBe(450);
      expect(saved?.nutritionSnapshot.protein).toBe(48);
      expect(saved?.nutritionSnapshot.micros.ironMg).toBe(6);
    });
  });

  it('supports Sync to macros in direct edit mode and pushes put mutations to cloud sync on save and undo', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    setCloudSyncEnabledForTests(true);

    const entry = makeEntry({
      id: 'e-sync',
      foodId: 'quick-add-sync',
      name: 'Post Workout Shake',
      source: 'quick_add',
      amount: 1,
      unit: 'serving',
      calories: 200,
      protein: 30,
      carbs: 10,
      fat: 2,
      fiber: 1,
    });
    await db.foodLogs.put(entry);
    await flushPendingMutationsForTests();
    fetchMock.mockClear();

    render(<EditLogEntryDrawer entry={entry} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/protein/i), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText(/carbs/i), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText(/fat/i), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /sync to macros/i }));
    // 40*4 + 25*4 + 5*9 = 160 + 100 + 45 = 305
    expect(screen.getByLabelText(/calories/i)).toHaveValue(305);

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(async () => {
      const saved = await db.foodLogs.get('e-sync');
      expect(saved?.nutritionSnapshot.calories).toBe(305);
    });
    await flushPendingMutationsForTests();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/db/sync',
      expect.objectContaining({ method: 'POST' })
    );
    const savePayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(savePayload).toMatchObject({
      action: 'mutate',
      table: 'foodLogs',
      op: 'put',
    });
    expect(savePayload.values[0].nutritionSnapshot.calories).toBe(305);

    fetchMock.mockClear();
    await act(async () => {
      await useLoggerStore.getState().undoToast?.onUndo();
    });
    await flushPendingMutationsForTests();

    const restored = await db.foodLogs.get('e-sync');
    expect(restored?.nutritionSnapshot.calories).toBe(200);
    const undoPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(undoPayload).toMatchObject({
      action: 'mutate',
      table: 'foodLogs',
      op: 'put',
    });
    expect(undoPayload.values[0].nutritionSnapshot.calories).toBe(200);
  });
});
