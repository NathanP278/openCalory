import 'fake-indexeddb/auto';
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { db } from '@/lib/db/opencalory-db';
import { useLoggerStore } from '@/stores/logger-store';
import { FoodSearchDrawer, clearOnlineSearchCache } from '../food-search-drawer';
import { setStaplesCache } from '@/lib/foods/staples-search';
import { saveCustomRecipe } from '@/lib/recipes/recipe-builder';
import {
  computeRecentEntries,
  computeFrequentEntries,
  togglePinEntry,
} from '@/lib/foods/search-history';
import { AppShell } from '@/components/shell/app-shell';
import type { CustomRecipeIngredient, FoodItem, FoodLogEntry } from '@/types/nutrition';

const mockStaples: FoodItem[] = [
  {
    id: 'staple:101',
    source: 'staple',
    name: 'Chicken breast, raw',
    basis: 'per100g',
    servingSize: 100,
    servingUnit: 'g',
    nutrientsPerBasis: { calories: 120, protein: 22.5, carbs: 0, fat: 2.6, fiber: 0 },
    micronutrientsPerBasis: { potassiumMg: 350, sodiumMg: 65 },
    updatedAt: 1000,
  },
  {
    id: 'staple:102',
    source: 'staple',
    name: 'Brown rice, medium-grain, cooked',
    basis: 'per100g',
    servingSize: 100,
    servingUnit: 'g',
    nutrientsPerBasis: { calories: 112, protein: 2.3, carbs: 23.5, fat: 0.8, fiber: 1.8 },
    micronutrientsPerBasis: { magnesiumMg: 43 },
    updatedAt: 1000,
  },
  {
    id: 'staple:ph-mcdo-egg-mcmuffin',
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
  },
];

describe('FoodSearchDrawer component', () => {
  beforeEach(async () => {
    clearOnlineSearchCache();
    await db.delete();
    await db.open();
    setStaplesCache(mockStaples);
    useLoggerStore.setState({
      activeDate: '2026-11-14',
      activeMealSlot: 'lunch',
      activeSheet: null,
      undoToast: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('renders drawer when open and displays staples', async () => {
    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);

    expect(screen.getByTestId('food-search-drawer')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search foods, brands, or staples/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
      expect(screen.getByText('Brown rice, medium-grain, cooked')).toBeInTheDocument();
    });
  });

  test('filters staples on query input', async () => {
    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });

    const input = screen.getByLabelText(/search foods/i);
    fireEvent.change(input, { target: { value: 'rice' } });

    expect(screen.getByText('Brown rice, medium-grain, cooked')).toBeInTheDocument();
    expect(screen.queryByText('Chicken breast, raw')).not.toBeInTheDocument();
  });

  test('selects food, configures grams portion, and logs food entry to Dexie', async () => {
    const handleClose = vi.fn();
    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="lunch" onClose={handleClose} />);

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });

    // Select Chicken breast
    fireEvent.click(screen.getByText('Chicken breast, raw'));

    // Should now show portion editor
    expect(screen.getByText(/portion amount/i)).toBeInTheDocument();
    const amountInput = screen.getByLabelText(/portion amount/i);
    expect(amountInput).toHaveValue(100);

    // Change amount to 200g
    fireEvent.change(amountInput, { target: { value: '200' } });

    // Live scaled calories should be 120 * 2 = 240 kcal
    expect(screen.getByText('240 kcal')).toBeInTheDocument();
    // Scaled protein should be 22.5 * 2 = 45g
    expect(screen.getByText('45g')).toBeInTheDocument();

    // Log food
    const logButton = screen.getByRole('button', { name: /log food/i });
    fireEvent.click(logButton);

    await waitFor(async () => {
      expect(await db.foodLogs.count()).toBe(1);
    });

    const [logged] = await db.foodLogs.toArray();
    expect(logged.name).toBe('Chicken breast, raw');
    expect(logged.amount).toBe(200);
    expect(logged.unit).toBe('g');
    expect(logged.mealSlot).toBe('lunch');
    expect(logged.nutritionSnapshot.calories).toBe(240);
    expect(logged.nutritionSnapshot.protein).toBe(45);
    expect(logged.nutritionSnapshot.micros.potassiumMg).toBe(700);

    // Verify it also cached the food item
    const cached = await db.foodsCache.get('staple:101');
    expect(cached).toBeDefined();
    expect(handleClose).toHaveBeenCalled();
  });

  test('USDA online tab triggers search and allows logging online result', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes('/api/usda/foods/search')) {
        return new Response(
          JSON.stringify({
            foods: [
              {
                fdcId: 555,
                description: 'Wild Alaskan Salmon',
                foodNutrients: [
                  { nutrientId: 1008, nutrientName: 'Energy', unitName: 'kcal', value: 182 },
                  { nutrientId: 1003, nutrientName: 'Protein', unitName: 'g', value: 25 },
                  { nutrientId: 1004, nutrientName: 'Total lipid (fat)', unitName: 'g', value: 8 },
                  { nutrientId: 1005, nutrientName: 'Carbohydrate', unitName: 'g', value: 0 },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    });

    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="dinner" onClose={() => {}} />);

    const input = screen.getByLabelText(/search foods/i);
    fireEvent.change(input, { target: { value: 'salmon' } });

    await waitFor(() => {
      expect(screen.getByText('Wild Alaskan Salmon')).toBeInTheDocument();
    });

    // Select the online result
    fireEvent.click(screen.getByText('Wild Alaskan Salmon'));
    expect(screen.getByText(/wild alaskan salmon/i)).toBeInTheDocument();

    // Log food
    fireEvent.click(screen.getByRole('button', { name: /log food/i }));

    await waitFor(async () => {
      expect(await db.foodLogs.count()).toBe(1);
    });

    const [logged] = await db.foodLogs.toArray();
    expect(logged.name).toBe('Wild Alaskan Salmon');
    expect(logged.source).toBe('usda');
    expect(logged.nutritionSnapshot.calories).toBe(182);

    // Verify it was saved to Dexie foodsCache
    const cached = await db.foodsCache.get('usda:555');
    expect(cached).toBeDefined();
    expect(cached?.name).toBe('Wild Alaskan Salmon');
  });

  test('AppShell mounts FoodSearchDrawer when activeSheet is search', () => {
    useLoggerStore.setState({ activeSheet: 'search' });

    render(
      <AppShell>
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getByTestId('food-search-drawer')).toBeInTheDocument();
  });

  test('Egg McMuffin defaults to 1 pc, toggles to g, scales macros, and logs 2 pcs', async () => {
    const handleClose = vi.fn();
    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="breakfast" onClose={handleClose} />);

    await waitFor(() => {
      expect(screen.getByText('Egg McMuffin')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Egg McMuffin'));

    const amountInput = screen.getByLabelText(/portion amount/i);
    const unitInput = screen.getByLabelText(/portion unit/i);
    expect(amountInput).toHaveValue(1);
    expect(unitInput).toHaveValue('pc');
    expect(screen.getByText('310 kcal')).toBeInTheDocument();

    // Toggle and piece presets are rendered because countable options apply
    expect(screen.getByRole('group', { name: /serving unit options/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '0.5 pc' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 pc' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1.5 pcs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 pcs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3 pcs' })).toBeInTheDocument();

    // Switch to grams and verify half weight (68g = 155 kcal)
    fireEvent.click(screen.getByRole('button', { name: 'g' }));
    expect(unitInput).toHaveValue('g');
    fireEvent.change(amountInput, { target: { value: '68' } });
    expect(screen.getByText('155 kcal')).toBeInTheDocument();

    // Switch back to pieces and select 2 pcs
    fireEvent.click(screen.getByRole('button', { name: 'pc (136g)' }));
    fireEvent.click(screen.getByRole('button', { name: '2 pcs' }));
    expect(amountInput).toHaveValue(2);
    expect(unitInput).toHaveValue('pcs');
    expect(screen.getByText('620 kcal')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /log food/i }));

    await waitFor(async () => {
      expect(await db.foodLogs.count()).toBe(1);
    });

    const [logged] = await db.foodLogs.toArray();
    expect(logged.name).toBe('Egg McMuffin');
    expect(logged.amount).toBe(2);
    expect(logged.unit).toBe('pcs');
    expect(logged.nutritionSnapshot.calories).toBe(620);
    expect(handleClose).toHaveBeenCalled();
  });

  test('plain per100g staple omits serving unit toggle and keeps gram presets', async () => {
    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Chicken breast, raw'));

    expect(screen.queryByRole('group', { name: /serving unit options/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '100g' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1 pc' })).not.toBeInTheDocument();
  });

  test('online tab merges Open Food Facts PH/Global and USDA results', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/off/search') && urlStr.includes('country=ph')) {
        return new Response(
          JSON.stringify({
            products: [
              {
                code: '4800016644801',
                product_name: 'Pancit Canton Kalamansi',
                brands: 'Lucky Me!',
                serving_size: '1 pack (80 g)',
                nutriments: {
                  'energy-kcal_100g': 462.5,
                  proteins_100g: 10,
                  carbohydrates_100g: 62.5,
                  fat_100g: 18.75,
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('/api/off/search')) {
        return new Response(JSON.stringify({ products: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('/api/usda/foods/search')) {
        return new Response(
          JSON.stringify({
            foods: [
              {
                fdcId: 888,
                description: 'Noodles, egg, cooked',
                foodNutrients: [{ nutrientId: 1008, unitName: 'kcal', value: 138 }],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    });

    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="snack" onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText(/search foods/i), { target: { value: 'pancit' } });

    await waitFor(() => {
      expect(screen.getByText('Pancit Canton Kalamansi')).toBeInTheDocument();
      expect(screen.getByText('Noodles, egg, cooked')).toBeInTheDocument();
    });

    expect(screen.getByText('Lucky Me!')).toBeInTheDocument();
    expect(screen.getByText('PH')).toBeInTheDocument();
  });

  test('typo-tolerant search suggests close foods like "eg mcmufin" and "chiken"', async () => {
    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="breakfast" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Egg McMuffin')).toBeInTheDocument();
    });

    const input = screen.getByLabelText(/search foods/i);
    fireEvent.change(input, { target: { value: 'eg mcmufin' } });
    expect(screen.getByText('Egg McMuffin')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'chiken' } });
    expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
  });

  test('streams fast online results immediately while slower providers are still pending alongside local items', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/off/search') && urlStr.includes('country=ph')) {
        return new Response(
          JSON.stringify({
            products: [
              {
                code: '4800111222333',
                product_name: 'Chooks-to-Go Chicken Belly',
                brands: 'Chooks-to-Go',
                nutriments: {
                  'energy-kcal_100g': 220,
                  proteins_100g: 21,
                  carbohydrates_100g: 2,
                  fat_100g: 14,
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Keep world OFF & USDA pending indefinitely
      return new Promise<Response>(() => {});
    });

    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/search foods/i), { target: { value: 'chicken' } });

    // Local chicken item displays immediately without blocking on pending providers
    expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();

    // Fast PH Open Food Facts result streams in immediately while USDA/World OFF remain pending
    await waitFor(() => {
      expect(screen.getByText('Chooks-to-Go Chicken Belly')).toBeInTheDocument();
    });
    expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    expect(screen.getByText(/searching open food facts & usda/i)).toBeInTheDocument();
  });

  test('preserves results scroll position when returning Back from portion selector', async () => {
    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });

    const resultsEl = screen.getByTestId('food-search-results');
    resultsEl.scrollTop = 180;

    fireEvent.click(screen.getByText('Chicken breast, raw'));
    expect(screen.getByRole('button', { name: /log food/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /back to search results/i }));
    await waitFor(() => {
      expect(screen.getByTestId('food-search-results')).toBeInTheDocument();
    });
    expect(screen.getByTestId('food-search-results').scrollTop).toBe(180);
  });

  test('supports ArrowDown, Enter, and Escape keyboard navigation across results and portion view', async () => {
    const handleClose = vi.fn();
    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="lunch" onClose={handleClose} />);

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    const highlighted = screen.getByTestId('food-search-results').querySelector('[data-highlighted="true"]');
    expect(highlighted).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByRole('button', { name: /log food/i })).toBeInTheDocument();

    // First Escape returns to results instead of closing the drawer
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.getByTestId('food-search-results')).toBeInTheDocument();
    });
    expect(handleClose).not.toHaveBeenCalled();

    // Second Escape closes the drawer
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  test('computeRecentEntries, computeFrequentEntries, and togglePinEntry rank and persist history accurately', async () => {
    const sampleIngredient: CustomRecipeIngredient = {
      foodId: 'staple:101',
      name: 'Chicken breast, raw',
      amount: 150,
      unit: 'g',
      nutritionSnapshot: {
        calories: 180,
        protein: 33.75,
        carbs: 0,
        fat: 3.9,
        fiber: 0,
        micros: { potassiumMg: 525 },
      },
    };
    const recipe = await saveCustomRecipe({
      name: 'Chicken Rice Bowl',
      ingredients: [sampleIngredient],
      basis: 'perServing',
      defaultServings: 1,
    });

    const foodsById = new Map(mockStaples.map((f) => [f.id, f]));
    const recipesById = new Map([[recipe.id, recipe]]);
    const now = Date.now();

    const logs: FoodLogEntry[] = [
      {
        id: 'log-1',
        date: '2026-11-18',
        foodId: 'staple:101',
        name: 'Chicken breast, raw',
        source: 'staple',
        amount: 120,
        unit: 'g',
        nutritionSnapshot: { calories: 144, protein: 27, carbs: 0, fat: 3.1, fiber: 0, micros: {} },
        createdAt: now - 3000,
      },
      {
        id: 'log-2',
        date: '2026-11-19',
        foodId: 'staple:102',
        name: 'Brown rice, medium-grain, cooked',
        source: 'staple',
        amount: 200,
        unit: 'g',
        nutritionSnapshot: { calories: 224, protein: 4.6, carbs: 47, fat: 1.6, fiber: 3.6, micros: {} },
        createdAt: now - 2000,
      },
      {
        id: 'log-3',
        date: '2026-11-19',
        foodId: 'staple:102',
        name: 'Brown rice, medium-grain, cooked',
        source: 'staple',
        amount: 250,
        unit: 'g',
        nutritionSnapshot: { calories: 280, protein: 5.75, carbs: 58.75, fat: 2, fiber: 4.5, micros: {} },
        createdAt: now - 1500,
      },
      {
        id: 'log-4',
        date: '2026-11-20',
        foodId: `recipe:${recipe.id}`,
        name: 'Chicken Rice Bowl',
        source: 'recipe',
        amount: 2,
        unit: 'servings',
        nutritionSnapshot: { calories: 360, protein: 68, carbs: 0, fat: 8, fiber: 0, micros: {} },
        createdAt: now - 500,
      },
    ];

    const recents = computeRecentEntries(logs, foodsById, recipesById);
    expect(recents).toHaveLength(3);
    expect(recents[0].kind).toBe('recipe');
    expect(recents[0].lastAmount).toBe(2);
    expect(recents[0].lastUnit).toBe('servings');
    expect(recents[1].kind).toBe('food');
    if (recents[1].kind === 'food') {
      expect(recents[1].food.id).toBe('staple:102');
      expect(recents[1].lastAmount).toBe(250);
    }

    const frequent = computeFrequentEntries(logs, foodsById, recipesById, 60);
    expect(frequent[0].kind).toBe('food');
    if (frequent[0].kind === 'food') {
      expect(frequent[0].food.id).toBe('staple:102');
      expect(frequent[0].lastAmount).toBe(250);
    }

    const pinned1 = await togglePinEntry('food', 'staple:101');
    expect(pinned1).toBe(true);
    expect(await db.pinnedFoods.get('food:staple:101')).toBeDefined();

    const pinned2 = await togglePinEntry('food', 'staple:101');
    expect(pinned2).toBe(false);
    expect(await db.pinnedFoods.get('food:staple:101')).toBeUndefined();
  });

  test('shows Recents, Frequent, and Pinned tabs on empty query and finds Custom Recipes in unified search', async () => {
    const sampleIngredient: CustomRecipeIngredient = {
      foodId: 'staple:102',
      name: 'Rolled Oats',
      amount: 80,
      unit: 'g',
      nutritionSnapshot: {
        calories: 300,
        protein: 10,
        carbs: 54,
        fat: 5,
        fiber: 8,
        micros: { magnesiumMg: 110 },
      },
    };
    await saveCustomRecipe({
      name: 'Protein Overnight Oats',
      ingredients: [sampleIngredient],
      basis: 'perServing',
      defaultServings: 1,
    });

    const handleClose = vi.fn();
    render(<FoodSearchDrawer open date="2026-11-20" onClose={handleClose} />);

    expect(screen.getByRole('tab', { name: /recents/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /frequent/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /pinned/i })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/search foods/i), {
      target: { value: 'Overnight Oats' },
    });

    await waitFor(() => {
      expect(screen.getByText('Protein Overnight Oats')).toBeInTheDocument();
    });
    expect(screen.getByText(/^recipe$/i)).toBeInTheDocument();

    // Pin the custom recipe and verify it appears under Pinned tab when query is cleared
    fireEvent.click(screen.getByRole('button', { name: /pin protein overnight oats/i }));
    fireEvent.change(screen.getByLabelText(/search foods/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('tab', { name: /pinned/i }));

    await waitFor(() => {
      expect(screen.getByText('Protein Overnight Oats')).toBeInTheDocument();
    });

    // Open portion screen for the recipe and log 2 servings
    fireEvent.click(screen.getByText('Protein Overnight Oats'));
    const amountInput = screen.getByLabelText(/portion amount/i);
    fireEvent.change(amountInput, { target: { value: '2' } });
    expect(screen.getByText('600 kcal')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /log food/i }));

    await waitFor(async () => {
      expect(await db.foodLogs.count()).toBe(1);
    });
    const [loggedRecipe] = await db.foodLogs.toArray();
    expect(loggedRecipe.name).toBe('Protein Overnight Oats');
    expect(loggedRecipe.source).toBe('recipe');
    expect(loggedRecipe.amount).toBe(2);
    expect(loggedRecipe.nutritionSnapshot.calories).toBe(600);
    expect(handleClose).toHaveBeenCalled();
  });

  test('supports 1-tap quick log (+) with Undo toast and multi-add staging tray logging multiple foods atomically', async () => {
    const handleClose = vi.fn();
    render(<FoodSearchDrawer open date="2026-11-20" mealSlot="lunch" onClose={handleClose} />);

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
      expect(screen.getByText('Brown rice, medium-grain, cooked')).toBeInTheDocument();
    });

    // 1-tap quick log (+) on Egg McMuffin logs immediately without closing drawer
    const quickLogMcMuffin = screen.getByRole('button', { name: /quick log egg mcmuffin/i });
    fireEvent.click(quickLogMcMuffin);

    await waitFor(async () => {
      expect(await db.foodLogs.count()).toBe(1);
      expect(useLoggerStore.getState().undoToast).not.toBeNull();
    });
    expect(handleClose).not.toHaveBeenCalled();

    const undoToastAfterQuick = useLoggerStore.getState().undoToast;
    expect(undoToastAfterQuick?.message).toMatch(/egg mcmuffin/i);

    // Undo the quick-logged entry
    await act(async () => {
      await undoToastAfterQuick?.onUndo();
    });
    expect(await db.foodLogs.count()).toBe(0);

    // Stage item 1: Chicken breast 150g (180 kcal)
    fireEvent.click(screen.getByText('Chicken breast, raw'));
    fireEvent.change(screen.getByLabelText(/portion amount/i), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /stage & add another/i }));

    // Returns to search list and shows sticky multi-add tray with 1 item Â· 180 kcal
    await waitFor(() => {
      expect(screen.getByTestId('multi-add-tray')).toBeInTheDocument();
    });
    expect(screen.getByTestId('multi-add-tray')).toHaveTextContent(/1 item/i);
    expect(screen.getByTestId('multi-add-tray')).toHaveTextContent(/180 kcal/i);

    // Stage item 2: Brown rice 200g (224 kcal)
    fireEvent.click(screen.getByText('Brown rice, medium-grain, cooked'));
    fireEvent.change(screen.getByLabelText(/portion amount/i), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: /stage & add another/i }));

    await waitFor(() => {
      expect(screen.getByTestId('multi-add-tray')).toHaveTextContent(/2 items/i);
    });
    expect(screen.getByTestId('multi-add-tray')).toHaveTextContent(/404 kcal/i);

    // Commit staged tray atomically via Log All
    fireEvent.click(screen.getByRole('button', { name: /log all/i }));

    await waitFor(async () => {
      expect(await db.foodLogs.count()).toBe(2);
    });
    expect(handleClose).toHaveBeenCalledTimes(1);

    const allLogs = await db.foodLogs.toArray();
    const names = allLogs.map((l) => l.name).sort();
    expect(names).toEqual(['Brown rice, medium-grain, cooked', 'Chicken breast, raw']);

    // Verify Undo toast can bulk-delete both staged items
    const batchUndo = useLoggerStore.getState().undoToast;
    expect(batchUndo).not.toBeNull();
    await act(async () => {
      await batchUndo?.onUndo();
    });
    expect(await db.foodLogs.count()).toBe(0);
  });
});
