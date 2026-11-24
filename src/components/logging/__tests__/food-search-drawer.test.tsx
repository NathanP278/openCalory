import 'fake-indexeddb/auto';
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { db } from '@/lib/db/opencalory-db';
import { useLoggerStore } from '@/stores/logger-store';
import { FoodSearchDrawer, clearOnlineSearchCache } from '../food-search-drawer';
import { filterStaples } from '@/lib/foods/staples-search';
import { saveCustomRecipe } from '@/lib/recipes/recipe-builder';
import {
  computeRecentEntries,
  computeFrequentEntries,
  computePinnedEntries,
  togglePinEntry,
} from '@/lib/foods/search-history';
import { lookupBarcodeWaterfall } from '@/hooks/use-barcode-lookup';
import { AppShell } from '@/components/shell/app-shell';
import * as clientCatalog from '@/lib/foods/client-catalog';
import type {
  CustomRecipeIngredient,
  FoodItem,
  FoodLogEntry,
  PinnedFood,
} from '@/types/nutrition';

vi.mock('@/lib/foods/client-catalog', async () => {
  const actual = await vi.importActual<typeof import('@/lib/foods/client-catalog')>(
    '@/lib/foods/client-catalog'
  );
  return {
    ...actual,
    initClientCatalog: vi.fn(),
    getCatalogSyncState: vi.fn(() => ({ status: 'ready' as const, foodCount: 3 })),
    subscribeCatalogSync: vi.fn(() => () => {}),
    searchClientCatalog: vi.fn(),
    lookupClientCatalogBarcode: vi.fn(async () => null),
    resolveClientLegacyIds: vi.fn(async () => new Map<string, FoodItem>()),
  };
});

vi.mock('@/lib/foods/search-history', async () => {
  const actual = await vi.importActual<typeof import('@/lib/foods/search-history')>(
    '@/lib/foods/search-history'
  );
  return {
    ...actual,
    computeRecentEntries: vi.fn(actual.computeRecentEntries),
    computeFrequentEntries: vi.fn(actual.computeFrequentEntries),
    computePinnedEntries: vi.fn(actual.computePinnedEntries),
  };
});

const mockCatalogFoods: FoodItem[] = [
  {
    id: 'staple:101',
    source: 'staple',
    accuracyTier: 1,
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
    accuracyTier: 1,
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
    accuracyTier: 3,
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

const canonicalWholeEgg: FoodItem = {
  id: 'usda:171287',
  source: 'usda',
  accuracyTier: 1,
  name: 'Whole Egg (Raw)',
  category: 'Dairy and Egg Products',
  basis: 'per100g',
  servingSize: 100,
  servingUnit: 'g',
  servingOptions: [
    { id: 'large', label: 'large (50g)', unit: 'large', grams: 50, defaultAmount: 1 },
    { id: 'pc', label: 'pc (50g)', unit: 'pc', grams: 50, defaultAmount: 1 },
    { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
    { id: 'oz', label: 'oz (28g)', unit: 'oz', grams: 28.35, defaultAmount: 1 },
  ],
  nutrientsPerBasis: { calories: 143, protein: 12.6, carbs: 0.7, fat: 9.5, fiber: 0 },
  micronutrientsPerBasis: { potassiumMg: 138, sodiumMg: 142 },
  updatedAt: 2000,
};

const fiveEggCatalogMatches: FoodItem[] = [
  canonicalWholeEgg,
  {
    id: 'usda:173424',
    source: 'usda',
    accuracyTier: 1,
    name: 'Whole Egg (Hard-Boiled)',
    category: 'Dairy and Egg Products',
    basis: 'per100g',
    servingSize: 100,
    servingUnit: 'g',
    servingOptions: [
      { id: 'large', label: 'large (50g)', unit: 'large', grams: 50, defaultAmount: 1 },
      { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
    ],
    nutrientsPerBasis: { calories: 155, protein: 12.6, carbs: 1.1, fat: 10.6, fiber: 0 },
    micronutrientsPerBasis: {},
    updatedAt: 2000,
  },
  {
    id: 'usda:172187',
    source: 'usda',
    accuracyTier: 1,
    name: 'Whole Egg (Scrambled)',
    category: 'Dairy and Egg Products',
    basis: 'per100g',
    servingSize: 100,
    servingUnit: 'g',
    servingOptions: [
      { id: 'large', label: 'large (61g)', unit: 'large', grams: 61, defaultAmount: 1 },
      { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
    ],
    nutrientsPerBasis: { calories: 149, protein: 10, carbs: 1.6, fat: 11, fiber: 0 },
    micronutrientsPerBasis: {},
    updatedAt: 2000,
  },
  {
    id: 'usda:172185',
    source: 'usda',
    accuracyTier: 1,
    name: 'Egg White (Raw)',
    category: 'Dairy and Egg Products',
    basis: 'per100g',
    servingSize: 100,
    servingUnit: 'g',
    servingOptions: [
      { id: 'large', label: 'large (33g)', unit: 'large', grams: 33, defaultAmount: 1 },
      { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
    ],
    nutrientsPerBasis: { calories: 52, protein: 10.9, carbs: 0.7, fat: 0.2, fiber: 0 },
    micronutrientsPerBasis: {},
    updatedAt: 2000,
  },
  {
    id: 'usda:172184',
    source: 'usda',
    accuracyTier: 1,
    name: 'Egg Yolk (Raw)',
    category: 'Dairy and Egg Products',
    basis: 'per100g',
    servingSize: 100,
    servingUnit: 'g',
    servingOptions: [
      { id: 'large', label: 'large (17g)', unit: 'large', grams: 17, defaultAmount: 1 },
      { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
    ],
    nutrientsPerBasis: { calories: 322, protein: 15.9, carbs: 3.6, fat: 26.5, fiber: 0 },
    micronutrientsPerBasis: {},
    updatedAt: 2000,
  },
];

describe('FoodSearchDrawer component', () => {
  beforeEach(async () => {
    clearOnlineSearchCache();
    vi.clearAllMocks();
    await db.delete();
    await db.open();
    await db.foodsCache.bulkPut(mockCatalogFoods);

    vi.mocked(clientCatalog.getCatalogSyncState).mockReturnValue({
      status: 'ready',
      foodCount: mockCatalogFoods.length,
    });
    vi.mocked(clientCatalog.subscribeCatalogSync).mockReturnValue(() => {});
    vi.mocked(clientCatalog.searchClientCatalog).mockImplementation(async (q: string) => ({
      items: filterStaples(mockCatalogFoods, q, 35),
      source: 'opfs',
    }));
    vi.mocked(clientCatalog.lookupClientCatalogBarcode).mockResolvedValue(null);
    vi.mocked(clientCatalog.resolveClientLegacyIds).mockResolvedValue(new Map());

    useLoggerStore.setState({
      activeDate: '2026-11-14',
      activeMealSlot: 'lunch',
      activeSheet: null,
      undoToast: null,
      searchInitialQuery: '',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('renders drawer when open and displays cached/local foods on empty query', async () => {
    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);

    expect(screen.getByTestId('food-search-drawer')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search foods, brands, or staples/i)).toBeInTheDocument();
    expect(clientCatalog.initClientCatalog).toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
      expect(screen.getByText('Brown rice, medium-grain, cooked')).toBeInTheDocument();
    });
  });

  test('filters local catalog & cached foods on query input', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [], source: 'catalog+live' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });

    const input = screen.getByLabelText(/search foods/i);
    fireEvent.change(input, { target: { value: 'rice' } });

    await waitFor(() => {
      expect(screen.getByText('Brown rice, medium-grain, cooked')).toBeInTheDocument();
      expect(screen.queryByText('Chicken breast, raw')).not.toBeInTheDocument();
    });
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

  test('sparse query (< 5 local matches) automatically triggers /api/foods/search?online=1, deduplicates, and allows logging', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/foods/search') && urlStr.includes('online=1')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'usda:555',
                source: 'usda',
                accuracyTier: 1,
                name: 'Wild Alaskan Salmon',
                basis: 'per100g',
                servingSize: 100,
                servingUnit: 'g',
                nutrientsPerBasis: { calories: 182, protein: 25, carbs: 0, fat: 8, fiber: 0 },
                micronutrientsPerBasis: {},
                updatedAt: 2000,
              },
              {
                // Duplicate of the same food from crowdsourced source — must be deduplicated
                id: 'off:dup-salmon',
                source: 'off',
                accuracyTier: 4,
                name: 'Wild Alaskan Salmon',
                basis: 'per100g',
                servingSize: 100,
                servingUnit: 'g',
                nutrientsPerBasis: { calories: 182, protein: 25, carbs: 0, fat: 8, fiber: 0 },
                micronutrientsPerBasis: {},
                updatedAt: 2000,
              },
            ],
            source: 'catalog+live',
            providersUsed: ['catalog', 'off'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });

    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="dinner" onClose={() => {}} />);

    const input = screen.getByLabelText(/search foods/i);
    fireEvent.change(input, { target: { value: 'salmon' } });

    await waitFor(() => {
      expect(screen.getByText('Wild Alaskan Salmon')).toBeInTheDocument();
    });

    // Must have auto-fired /api/foods/search?online=1 because local results < 5
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/foods\/search\?.*q=salmon.*online=1/),
      expect.any(Object)
    );
    // Zero duplicates
    expect(screen.getAllByText('Wild Alaskan Salmon')).toHaveLength(1);

    // Select and log the online result
    fireEvent.click(screen.getByText('Wild Alaskan Salmon'));
    fireEvent.click(screen.getByRole('button', { name: /log food/i }));

    await waitFor(async () => {
      expect(await db.foodLogs.count()).toBe(1);
    });

    const [logged] = await db.foodLogs.toArray();
    expect(logged.name).toBe('Wild Alaskan Salmon');
    expect(logged.source).toBe('usda');
    expect(logged.nutritionSnapshot.calories).toBe(182);

    const cached = await db.foodsCache.get('usda:555');
    expect(cached).toBeDefined();
    expect(cached?.name).toBe('Wild Alaskan Salmon');
  });

  test('searching "egg" with >= 5 local matches shows zero duplicates, defaults to natural unit (1 large), does NOT auto-fire online search, and Search online button fetches on demand', async () => {
    // Seed a duplicate egg in Dexie foodsCache alongside the 5 catalog matches
    await db.foodsCache.put({
      id: 'off:cached-egg-dup',
      source: 'off',
      accuracyTier: 4,
      name: 'Whole Egg (Raw)',
      basis: 'per100g',
      servingSize: 100,
      servingUnit: 'g',
      nutrientsPerBasis: { calories: 143, protein: 12.6, carbs: 0.7, fat: 9.5, fiber: 0 },
      micronutrientsPerBasis: {},
      updatedAt: 1500,
    });

    vi.mocked(clientCatalog.searchClientCatalog).mockImplementation(async (q: string) => {
      if (q.toLowerCase().includes('egg')) {
        return { items: fiveEggCatalogMatches, source: 'opfs' };
      }
      return { items: [], source: 'opfs' };
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/foods/search') && urlStr.includes('online=1')) {
        return new Response(
          JSON.stringify({
            items: [
              // Duplicate of canonicalWholeEgg — must not duplicate
              { ...canonicalWholeEgg, id: 'off:live-egg-dup', source: 'off', accuracyTier: 4 },
              // Brand-new branded item from online search
              {
                id: 'off:4800999888',
                source: 'off',
                accuracyTier: 4,
                name: 'Organic Pasture-Raised Eggs',
                brand: 'Vital Farms',
                basis: 'per100g',
                servingSize: 100,
                servingUnit: 'g',
                nutrientsPerBasis: { calories: 145, protein: 12.5, carbs: 1, fat: 10, fiber: 0 },
                micronutrientsPerBasis: {},
                updatedAt: 2500,
              },
            ],
            source: 'catalog+live',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });

    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="breakfast" onClose={() => {}} />);

    const input = screen.getByLabelText(/search foods/i);
    fireEvent.change(input, { target: { value: 'egg' } });

    await waitFor(() => {
      expect(screen.getByText('Whole Egg (Raw)')).toBeInTheDocument();
      expect(screen.getByText('Egg Yolk (Raw)')).toBeInTheDocument();
    });

    // Zero duplicate rows for "Whole Egg (Raw)" across catalog + foodsCache
    expect(screen.getAllByText('Whole Egg (Raw)')).toHaveLength(1);

    // Must NOT auto-fire /api/foods/search?online=1 when >= 5 local matches exist
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchSpy).not.toHaveBeenCalled();

    // Explicit "Search online" button is visible at the bottom of results
    const searchOnlineBtn = screen.getByRole('button', { name: /search online/i });
    expect(searchOnlineBtn).toBeInTheDocument();

    // Clicking "Search online" fires /api/foods/search?online=1 on demand and deduplicates
    fireEvent.click(searchOnlineBtn);

    await waitFor(() => {
      expect(screen.getByText('Organic Pasture-Raised Eggs')).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/foods\/search\?.*q=egg.*online=1/),
      expect.any(Object)
    );
    expect(screen.getAllByText('Whole Egg (Raw)')).toHaveLength(1);
    expect(screen.getByText('Branded')).toBeInTheDocument();

    // Selecting "Whole Egg (Raw)" defaults to natural household unit (1 large) with g & oz selectable
    fireEvent.click(screen.getByText('Whole Egg (Raw)'));
    expect(screen.getByLabelText(/portion amount/i)).toHaveValue(1);
    expect(screen.getByLabelText(/portion unit/i)).toHaveValue('large');
    expect(screen.getByRole('button', { name: 'g' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /oz/i })).toBeInTheDocument();
  });

  test('Review Focus #5: legacy foodLogs and pinnedFoods (staple:323604) resolve lazily to canonical Whole Egg (Raw) without duplicates', async () => {
    const now = Date.now();
    // Seed legacy foodLog + canonical foodLog + legacy pinnedFood + canonical pinnedFood
    const legacyLog: FoodLogEntry = {
      id: 'log-legacy-egg',
      date: '2026-11-18',
      foodId: 'staple:323604',
      name: 'Egg, whole, raw, fresh',
      source: 'staple',
      amount: 3,
      unit: 'large',
      nutritionSnapshot: { calories: 215, protein: 18.9, carbs: 1.1, fat: 14.3, fiber: 0, micros: {} },
      createdAt: now - 1000,
    };
    const olderCanonicalLog: FoodLogEntry = {
      id: 'log-canon-egg',
      date: '2026-11-17',
      foodId: 'usda:171287',
      name: 'Whole Egg (Raw)',
      source: 'usda',
      amount: 2,
      unit: 'large',
      nutritionSnapshot: { calories: 143, protein: 12.6, carbs: 0.7, fat: 9.5, fiber: 0, micros: {} },
      createdAt: now - 5000,
    };
    const legacyPin: PinnedFood = {
      id: 'food:staple:323604',
      kind: 'food',
      refId: 'staple:323604',
      pinnedAt: now - 2000,
    };
    const canonPin: PinnedFood = {
      id: 'food:usda:171287',
      kind: 'food',
      refId: 'usda:171287',
      pinnedAt: now - 3000,
    };

    // 1. Unit-test search-history helpers with legacyAliasMap directly
    const aliasMap = new Map<string, string>([['staple:323604', 'usda:171287']]);
    const foodsById = new Map<string, FoodItem>([['usda:171287', canonicalWholeEgg]]);
    const recipesById = new Map();

    const recents = computeRecentEntries(
      [legacyLog, olderCanonicalLog],
      foodsById,
      recipesById,
      25,
      aliasMap
    );
    expect(recents).toHaveLength(1);
    expect(recents[0].kind).toBe('food');
    if (recents[0].kind === 'food') {
      expect(recents[0].food.id).toBe('usda:171287');
      expect(recents[0].food.name).toBe('Whole Egg (Raw)');
      expect(recents[0].food.servingOptions?.map((o) => o.unit)).toEqual(['large', 'pc', 'g', 'oz']);
      expect(recents[0].lastAmount).toBe(3);
      expect(recents[0].lastUnit).toBe('large');
    }

    const frequent = computeFrequentEntries(
      [legacyLog, olderCanonicalLog],
      foodsById,
      recipesById,
      60,
      25,
      aliasMap
    );
    expect(frequent).toHaveLength(1);
    if (frequent[0].kind === 'food') {
      expect(frequent[0].food.id).toBe('usda:171287');
      expect(frequent[0].lastAmount).toBe(3);
      expect(frequent[0].lastUnit).toBe('large');
    }

    const pinned = computePinnedEntries(
      [legacyPin, canonPin],
      foodsById,
      recipesById,
      [legacyLog, olderCanonicalLog],
      aliasMap
    );
    expect(pinned).toHaveLength(1);
    if (pinned[0].kind === 'food') {
      expect(pinned[0].food.id).toBe('usda:171287');
      expect(pinned[0].lastAmount).toBe(3);
      expect(pinned[0].lastUnit).toBe('large');
    }

    // 2. Full FoodSearchDrawer integration test via resolveClientLegacyIds
    await db.foodLogs.bulkAdd([legacyLog, olderCanonicalLog]);
    await db.pinnedFoods.bulkPut([legacyPin, canonPin]);

    vi.mocked(clientCatalog.resolveClientLegacyIds).mockImplementation(async (ids: string[]) => {
      const map = new Map<string, FoodItem>();
      if (ids.includes('staple:323604')) {
        map.set('staple:323604', canonicalWholeEgg);
      }
      if (ids.includes('usda:171287')) {
        map.set('usda:171287', canonicalWholeEgg);
      }
      return map;
    });

    render(<FoodSearchDrawer open date="2026-11-20" mealSlot="breakfast" onClose={() => {}} />);

    // Recents tab resolves staple:323604 -> Whole Egg (Raw) with no duplicate and preserves Last: 3 large
    await waitFor(() => {
      expect(screen.getByText('Whole Egg (Raw)')).toBeInTheDocument();
      expect(screen.queryByText('Egg, whole, raw, fresh')).not.toBeInTheDocument();
    });
    expect(screen.getAllByText('Whole Egg (Raw)')).toHaveLength(1);
    expect(screen.getByText(/last: 3 large/i)).toBeInTheDocument();

    // Frequent tab also has single deduplicated Whole Egg (Raw)
    fireEvent.click(screen.getByRole('tab', { name: /frequent/i }));
    expect(screen.getAllByText('Whole Egg (Raw)')).toHaveLength(1);

    // Pinned tab also has single deduplicated Whole Egg (Raw) with Last: 3 large
    fireEvent.click(screen.getByRole('tab', { name: /pinned/i }));
    expect(screen.getAllByText('Whole Egg (Raw)')).toHaveLength(1);
    expect(screen.getByText(/last: 3 large/i)).toBeInTheDocument();

    // Clicking the resolved item opens portion editor with preserved 3 large and servingOptions
    fireEvent.click(screen.getByText('Whole Egg (Raw)'));
    expect(screen.getByLabelText(/portion amount/i)).toHaveValue(3);
    expect(screen.getByLabelText(/portion unit/i)).toHaveValue('large');
    expect(screen.getByRole('button', { name: 'g' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /oz/i })).toBeInTheDocument();

    // Ensure Dexie foodLogs and pinnedFoods were NOT destructively rewritten
    const storedLog = await db.foodLogs.get('log-legacy-egg');
    expect(storedLog?.foodId).toBe('staple:323604');
  });

  test('Review Focus #2: lookupBarcodeWaterfall resolves UPC-A/EAN-13 from lookupClientCatalogBarcode offline with 0 network calls before falling back to /api/foods/barcode/[code]', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const catalogBarcodeItem: FoodItem = {
      id: 'off:0012345678905',
      barcode: '0012345678905',
      source: 'off',
      accuracyTier: 4,
      name: 'Oat Milk Barista',
      brand: 'Oatly',
      basis: 'per100ml',
      servingSize: 100,
      servingUnit: 'ml',
      nutrientsPerBasis: { calories: 59, protein: 1, carbs: 6.6, fat: 3, fiber: 0.8 },
      micronutrientsPerBasis: {},
      updatedAt: 2000,
    };

    // 1. Offline OPFS catalog hit (0 network calls)
    vi.mocked(clientCatalog.getCatalogSyncState).mockReturnValue({ status: 'ready', foodCount: 100 });
    vi.mocked(clientCatalog.lookupClientCatalogBarcode).mockResolvedValueOnce(catalogBarcodeItem);

    const hitRes = await lookupBarcodeWaterfall('012345678905');
    expect(hitRes).toEqual({ status: 'hit', item: catalogBarcodeItem });
    expect(clientCatalog.lookupClientCatalogBarcode).toHaveBeenCalledWith('012345678905');
    expect(fetchSpy).not.toHaveBeenCalled();

    // Cached into Dexie foodsCache for future instant hits
    const cached = await db.foodsCache.get('off:0012345678905');
    expect(cached?.name).toBe('Oat Milk Barista');

    // 2. Miss in Dexie + miss in OPFS catalog -> falls back to GET /api/foods/barcode/[code]
    vi.mocked(clientCatalog.lookupClientCatalogBarcode).mockResolvedValueOnce(null);
    const serverItem: FoodItem = {
      id: 'off:4800016644801',
      barcode: '4800016644801',
      source: 'off',
      accuracyTier: 4,
      name: 'Pancit Canton Kalamansi',
      brand: 'Lucky Me!',
      basis: 'per100g',
      servingSize: 100,
      servingUnit: 'g',
      nutrientsPerBasis: { calories: 462, protein: 10, carbs: 62, fat: 18, fiber: 2 },
      micronutrientsPerBasis: {},
      updatedAt: 2000,
    };
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'hit', item: serverItem, source: 'live' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const fallbackRes = await lookupBarcodeWaterfall('4800016644801');
    expect(fallbackRes).toEqual({ status: 'hit', item: serverItem });
    expect(fetchSpy).toHaveBeenCalledWith('/api/foods/barcode/4800016644801');
    expect(await db.foodsCache.get('off:4800016644801')).toBeDefined();
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

  test('typo-tolerant search suggests close foods like "eg mcmufin" and "chiken"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    render(<FoodSearchDrawer open date="2026-11-14" mealSlot="breakfast" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Egg McMuffin')).toBeInTheDocument();
    });

    const input = screen.getByLabelText(/search foods/i);
    fireEvent.change(input, { target: { value: 'eg mcmufin' } });
    await waitFor(() => {
      expect(screen.getByText('Egg McMuffin')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'chiken' } });
    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });
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

    const foodsById = new Map(mockCatalogFoods.map((f) => [f.id, f]));
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

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

    // Returns to search list and shows sticky multi-add tray with 1 item · 180 kcal
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

  test('renders food-search-row containment class and omits stagger-item animation during active search typing', async () => {
    render(
      <FoodSearchDrawer
        open
        date="2026-11-14"
        mealSlot="lunch"
        onClose={vi.fn()}
      />
    );

    const searchInput = screen.getByLabelText(/search foods/i);
    fireEvent.change(searchInput, { target: { value: 'chicken' } });

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });

    const resultsList = screen.getByTestId('food-search-results');
    const rowEl = resultsList.querySelector('.food-search-row');
    expect(rowEl).not.toBeNull();
    expect(rowEl?.className).not.toContain('stagger-item');
  });

  test('isolates history memos so typing and receiving catalogResults never recomputes 60-day history', async () => {
    const recentSpy = vi.mocked(computeRecentEntries);
    const frequentSpy = vi.mocked(computeFrequentEntries);
    const pinnedSpy = vi.mocked(computePinnedEntries);

    render(
      <FoodSearchDrawer
        open
        date="2026-11-14"
        mealSlot="lunch"
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });

    recentSpy.mockClear();
    frequentSpy.mockClear();
    pinnedSpy.mockClear();

    const searchInput = screen.getByLabelText(/search foods/i);
    fireEvent.change(searchInput, { target: { value: 'chicken' } });

    await waitFor(() => {
      expect(clientCatalog.searchClientCatalog).toHaveBeenCalledWith(
        'chicken',
        expect.any(Object)
      );
    });

    expect(recentSpy).not.toHaveBeenCalled();
    expect(frequentSpy).not.toHaveBeenCalled();
    expect(pinnedSpy).not.toHaveBeenCalled();
  });

  test('Review Focus #2: retains previous search results while next query is in-flight, shows empty state only after settle, and clears instantly on empty input', async () => {
    let resolveSecondQuery!: (res: { items: FoodItem[]; source: 'opfs' }) => void;
    vi.mocked(clientCatalog.searchClientCatalog).mockImplementation((q: string) => {
      if (q === 'chicken') {
        return Promise.resolve({ items: [mockCatalogFoods[0]], source: 'opfs' });
      }
      return new Promise((resolve) => {
        resolveSecondQuery = resolve;
      });
    });

    render(
      <FoodSearchDrawer
        open
        date="2026-11-14"
        mealSlot="lunch"
        onClose={vi.fn()}
      />
    );

    const searchInput = screen.getByLabelText(/search foods/i);
    fireEvent.change(searchInput, { target: { value: 'chicken' } });
    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });

    // Type a non-matching query whose worker promise stays pending
    fireEvent.change(searchInput, { target: { value: 'zzzznonexistentfood' } });

    // Previous result stays visible without flashing "No matching foods found."
    expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    expect(screen.queryByText(/no matching foods found/i)).not.toBeInTheDocument();

    // Once the pending query settles with 0 items (and offline so online fallback does not trigger), show empty state
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    await act(async () => {
      resolveSecondQuery({ items: [], source: 'opfs' });
    });

    await waitFor(() => {
      expect(screen.getByText(/no matching foods found/i)).toBeInTheDocument();
    });

    // Clearing query immediately restores Recents tab
    fireEvent.change(searchInput, { target: { value: '' } });
    expect(screen.getByRole('tablist', { name: /food history tabs/i })).toBeInTheDocument();
    expect(screen.queryByText(/no matching foods found/i)).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  test('debounces rapid typing when searchDebounceMs is configured and only queries the final text', async () => {
    vi.mocked(clientCatalog.searchClientCatalog).mockClear();

    render(
      <FoodSearchDrawer
        open
        date="2026-11-14"
        mealSlot="lunch"
        onClose={vi.fn()}
        searchDebounceMs={70}
      />
    );

    const searchInput = screen.getByLabelText(/search foods/i);
    fireEvent.change(searchInput, { target: { value: 'c' } });
    fireEvent.change(searchInput, { target: { value: 'ch' } });
    fireEvent.change(searchInput, { target: { value: 'chi' } });

    expect(clientCatalog.searchClientCatalog).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(clientCatalog.searchClientCatalog).toHaveBeenCalledTimes(1);
    });
    expect(clientCatalog.searchClientCatalog).toHaveBeenCalledWith('chi', expect.any(Object));
  });

  test('Review Focus #3: preserves scroll position on Back from portion panel but resets scrollTop to 0 when a new query settles', async () => {
    render(
      <FoodSearchDrawer
        open
        date="2026-11-14"
        mealSlot="lunch"
        onClose={vi.fn()}
      />
    );

    const searchInput = screen.getByLabelText(/search foods/i);
    fireEvent.change(searchInput, { target: { value: 'chicken' } });
    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });

    const resultsContainer = screen.getByTestId('food-search-results');
    resultsContainer.scrollTop = 180;

    // Open portion selector and come Back -> scrollTop restored to 180
    fireEvent.click(screen.getByText('Chicken breast, raw'));
    fireEvent.click(screen.getByRole('button', { name: /back to search results/i }));

    await waitFor(() => {
      expect(screen.getByTestId('food-search-results').scrollTop).toBe(180);
    });

    // Search a different query -> scrollTop resets to 0
    fireEvent.change(screen.getByLabelText(/search foods/i), { target: { value: 'rice' } });
    await waitFor(() => {
      expect(screen.getByText('Brown rice, medium-grain, cooked')).toBeInTheDocument();
      expect(screen.getByTestId('food-search-results').scrollTop).toBe(0);
    });
  });

  test('mounts global keydown listener once across keystrokes and clamps highlightedIndex when results shrink', async () => {
    const addListenerSpy = vi.spyOn(window, 'addEventListener');

    render(
      <FoodSearchDrawer
        open
        date="2026-11-14"
        mealSlot="lunch"
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });

    const keydownMounts = () =>
      addListenerSpy.mock.calls.filter(([type]) => type === 'keydown').length;
    const initialCount = keydownMounts();
    expect(initialCount).toBe(1);

    const searchInput = screen.getByLabelText(/search foods/i);
    fireEvent.change(searchInput, { target: { value: 'c' } });
    fireEvent.change(searchInput, { target: { value: 'ch' } });
    fireEvent.change(searchInput, { target: { value: 'chi' } });
    fireEvent.change(searchInput, { target: { value: 'chick' } });

    expect(keydownMounts()).toBe(1);

    // Highlight index 0 and ensure narrowing doesn't break keyboard selection
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    await waitFor(() => {
      const highlighted = screen
        .getByTestId('food-search-results')
        .querySelectorAll('[data-highlighted="true"]');
      expect(highlighted).toHaveLength(1);
    });
  });

  test('Review Focus #5: bounds mount Dexie foodLogs query via createdAt index and handles quick-log + Undo incrementally without full-table rescans', async () => {
    const toArraySpy = vi.spyOn(db.foodLogs, 'toArray');
    const orderBySpy = vi.spyOn(db.foodLogs, 'orderBy');

    render(
      <FoodSearchDrawer
        open
        date="2026-11-14"
        mealSlot="lunch"
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Chicken breast, raw')).toBeInTheDocument();
    });

    expect(orderBySpy).toHaveBeenCalledWith('createdAt');
    expect(toArraySpy).not.toHaveBeenCalled();

    // Quick-log Egg McMuffin without scanning db.foodLogs.toArray()
    fireEvent.click(screen.getByRole('button', { name: /quick log egg mcmuffin/i }));
    await waitFor(async () => {
      expect(await db.foodLogs.count()).toBe(1);
      expect(useLoggerStore.getState().undoToast).not.toBeNull();
    });
    expect(toArraySpy).not.toHaveBeenCalled();

    // Undo removes from both Dexie and in-memory Recents without full-table rescan
    const undo = useLoggerStore.getState().undoToast?.onUndo;
    expect(undo).toBeDefined();
    await act(async () => {
      await undo?.();
    });

    expect(await db.foodLogs.count()).toBe(0);
    expect(toArraySpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/Last: 1 pc/i)).not.toBeInTheDocument();
  });
});
