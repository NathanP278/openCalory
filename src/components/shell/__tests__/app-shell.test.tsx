import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AppShell } from '../app-shell';
import { useLoggerStore, type LogSheetType } from '@/stores/logger-store';
import { db } from '@/lib/db/opencalory-db';
import HomePage from '@/app/page';
import LogPage from '@/app/log/page';
import RecipesPage from '@/app/recipes/page';
import TrendsPage from '@/app/trends/page';

const { mockUsePathname } = vi.hoisted(() => ({
  mockUsePathname: vi.fn<() => string | null>(() => null),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));

describe('AppShell', () => {
  beforeEach(async () => {
    mockUsePathname.mockReturnValue(null);
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all([
      db.foodLogs.clear(),
      db.customRecipes.clear(),
      db.userGoals.clear(),
    ]);
    useLoggerStore.setState({
      activeDate: '2026-11-14',
      dateDirection: null,
      activeMealSlot: 'breakfast',
      activeSheet: null,
      searchInitialQuery: '',
      aiDraft: null,
      editingEntry: null,
      recipeSeedIngredients: null,
      isCommandPaletteOpen: false,
      undoToast: null,
      syncAuthLocked: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('toggles quick-action dock with all four logging entry points', () => {
    render(
      <AppShell>
        <div>Body</div>
      </AppShell>
    );

    expect(screen.getByText('Body')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open quick actions/i }));
    expect(screen.getByRole('button', { name: /ai meal scan/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /barcode scan/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /quick search/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /quick add macros/i })).toBeInTheDocument();
  });

  it('triggers onQuickAction callback and closes dock when an action is clicked', () => {
    const handleQuickAction = vi.fn();
    render(
      <AppShell onQuickAction={handleQuickAction}>
        <div>Body Content</div>
      </AppShell>
    );

    fireEvent.click(screen.getByRole('button', { name: /open quick actions/i }));
    const aiScanButton = screen.getByRole('button', { name: /ai meal scan/i });
    fireEvent.click(aiScanButton);

    expect(handleQuickAction).toHaveBeenCalledWith('ai-scan');
    // Dock should close
    expect(screen.queryByRole('button', { name: /ai meal scan/i })).not.toBeInTheDocument();
  });

  it('closes quick-action dock when close button or backdrop is clicked', () => {
    render(
      <AppShell>
        <div>Main Area</div>
      </AppShell>
    );

    fireEvent.click(screen.getByRole('button', { name: /open quick actions/i }));
    expect(screen.getByRole('button', { name: /ai meal scan/i })).toBeInTheDocument();

    const closeButton = screen.getByRole('button', { name: /close quick actions/i });
    fireEvent.click(closeButton);
    expect(screen.queryByRole('button', { name: /ai meal scan/i })).not.toBeInTheDocument();
  });

  it('opens QuickAddDrawer when quick-add is clicked in QuickActionDock', () => {
    render(
      <AppShell>
        <div>Body Content</div>
      </AppShell>
    );

    fireEvent.click(screen.getByRole('button', { name: /open quick actions/i }));
    const quickAddButton = screen.getByRole('button', { name: /quick add macros/i });
    fireEvent.click(quickAddButton);

    expect(screen.getByTestId('quick-add-drawer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log quick add/i })).toBeInTheDocument();
  });

  it('opens Command Palette with Ctrl/Cmd + K, filters commands, and closes on Escape', () => {
    render(
      <AppShell>
        <div>Workspace</div>
      </AppShell>
    );

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();

    const searchInput = screen.getByLabelText(/search commands or staple foods/i);
    fireEvent.change(searchInput, { target: { value: 'quick add' } });
    expect(screen.getByText('Quick Add Macros')).toBeInTheDocument();
    expect(screen.queryByText('Scan Barcode')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });

  it('triggers UndoToast callback on Undo click and Ctrl+Z shortcut', async () => {
    const onUndoClick = vi.fn().mockResolvedValue(undefined);
    const onUndoKey = vi.fn().mockResolvedValue(undefined);

    render(
      <AppShell>
        <div>Workspace</div>
      </AppShell>
    );

    act(() => {
      useLoggerStore.getState().showUndoToast({
        message: 'Removed Chicken Breast',
        onUndo: onUndoClick,
      });
    });

    await waitFor(() => {
      const toast = screen.getByTestId('undo-toast');
      expect(toast).toBeInTheDocument();
      expect(screen.getByText('Removed Chicken Breast')).toBeInTheDocument();
      // Centering lives on the outer Notifications region (not -translate-x-1/2 on the animated card)
      expect(toast.className).not.toContain('-translate-x-1/2');
      const region = screen.getByRole('region', { name: /notifications/i });
      expect(region.className).toContain('inset-x-0');
      expect(region.className).toContain('lg:left-[220px]');
      expect(region.className).toContain('justify-center');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(onUndoClick).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument();
    });

    act(() => {
      useLoggerStore.getState().showUndoToast({
        message: 'Removed Brown Rice',
        onUndo: onUndoKey,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('undo-toast')).toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => {
      expect(onUndoKey).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument();
    });
  });

  it('renders Dashboard, Food Log, Trends, Recipes in bottom nav and Log Weigh-In in quick actions dock', () => {
    const handleQuickAction = vi.fn();
    render(
      <AppShell onQuickAction={handleQuickAction}>
        <div>Body</div>
      </AppShell>
    );

    const nav = screen.getByTestId('bottom-nav');
    expect(nav).toHaveTextContent(/dashboard/i);
    expect(nav).toHaveTextContent(/food log/i);
    expect(nav).toHaveTextContent(/trends/i);
    expect(nav).toHaveTextContent(/recipes/i);
    expect(nav).not.toHaveTextContent(/settings/i);

    expect(screen.getByRole('link', { name: /trends/i })).toHaveAttribute('href', '/trends');
    expect(screen.getByRole('link', { name: /recipes/i })).toHaveAttribute('href', '/recipes');

    fireEvent.click(screen.getByRole('button', { name: /open quick actions/i }));
    const weighInBtn = screen.getByRole('button', { name: /log weigh-in/i });
    expect(weighInBtn).toBeInTheDocument();

    fireEvent.click(weighInBtn);
    expect(handleQuickAction).toHaveBeenCalledWith('weight');
    expect(useLoggerStore.getState().activeSheet).toBe('weight');
    expect(screen.queryByTestId('quick-action-dock')).not.toBeInTheDocument();
  });

  it('extends useLoggerStore with v2 sheet types, editingEntry, recipeSeedIngredients, and resets activeMealSlot on closeSheet', () => {
    const mealIdeasSheet: LogSheetType = 'meal-ideas';
    const weightSheet: LogSheetType = 'weight';

    const store = useLoggerStore.getState();
    store.openSheet(mealIdeasSheet, 'dinner');
    expect(useLoggerStore.getState().activeSheet).toBe('meal-ideas');
    expect(useLoggerStore.getState().activeMealSlot).toBe('dinner');

    store.closeSheet();
    expect(useLoggerStore.getState().activeSheet).toBeNull();
    expect(useLoggerStore.getState().activeMealSlot).toBe('log');

    store.openSheet(weightSheet);
    expect(useLoggerStore.getState().activeSheet).toBe('weight');

    const sampleEntry = {
      id: 'entry-1',
      date: '2026-11-14',
      mealSlot: 'log',
      foodId: 'staple:eggs',
      name: 'Boiled Eggs',
      source: 'staple' as const,
      amount: 100,
      unit: 'g',
      nutritionSnapshot: {
        calories: 155,
        protein: 13,
        carbs: 1.1,
        fat: 11,
        fiber: 0,
        micros: {},
      },
      createdAt: 1000,
    };
    store.setEditingEntry(sampleEntry);
    expect(useLoggerStore.getState().editingEntry).toEqual(sampleEntry);
    store.setEditingEntry(null);
    expect(useLoggerStore.getState().editingEntry).toBeNull();

    const seedIngredients = [
      {
        foodId: 'staple:eggs',
        name: 'Boiled Eggs',
        amount: 100,
        unit: 'g',
        nutritionSnapshot: {
          calories: 155,
          protein: 13,
          carbs: 1.1,
          fat: 11,
          fiber: 0,
          micros: {},
        },
      },
    ];
    store.openRecipeBuilderWithIngredients(seedIngredients);
    expect(useLoggerStore.getState().recipeSeedIngredients).toEqual(seedIngredients);
    store.setRecipeSeedIngredients(null);
    expect(useLoggerStore.getState().recipeSeedIngredients).toBeNull();
  });

  it('renders non-blocking Liquid Glass Cloud Sync login modal when syncAuthLocked is true and supports Local Mode + passphrase unlock', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ authenticated: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AppShell>
        <div>Offline Workspace Content</div>
      </AppShell>
    );

    expect(screen.queryByTestId('sync-auth-modal')).not.toBeInTheDocument();

    act(() => {
      useLoggerStore.getState().setSyncAuthLocked(true);
    });

    const modal = await screen.findByTestId('sync-auth-modal');
    expect(modal).toBeInTheDocument();
    expect(screen.getByText('Offline Workspace Content')).toBeInTheDocument();
    expect(modal.innerHTML).not.toMatch(/#ef4444|text-red|bg-red|border-red/i);
    expect(screen.getByTestId('sync-unlock-card')).toBeInTheDocument();

    // Continuing in Local Mode dismisses modal while keeping workspace accessible
    fireEvent.click(screen.getByRole('button', { name: /continue in local mode/i }));
    expect(screen.queryByTestId('sync-auth-modal')).not.toBeInTheDocument();
    expect(screen.getByText('Offline Workspace Content')).toBeInTheDocument();

    // Cycling false -> true resurfaces modal
    act(() => {
      useLoggerStore.getState().setSyncAuthLocked(false);
    });
    act(() => {
      useLoggerStore.getState().setSyncAuthLocked(true);
    });

    expect(await screen.findByTestId('sync-auth-modal')).toBeInTheDocument();

    // Entering valid passphrase unlocks Cloud Sync and closes modal
    fireEvent.change(screen.getByLabelText(/sync access passphrase/i), {
      target: { value: 'secret-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^unlock$/i }));

    await waitFor(() => {
      expect(useLoggerStore.getState().syncAuthLocked).toBe(false);
      expect(screen.queryByTestId('sync-auth-modal')).not.toBeInTheDocument();
    });
  });

  it('hides Quick Search Strip on /trends and marks Trends nav tab active', () => {
    mockUsePathname.mockReturnValue('/trends');

    render(<TrendsPage />);

    expect(screen.getByRole('heading', { name: /^trends$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /search for a food/i })).not.toBeInTheDocument();

    const trendsLink = screen.getByRole('link', { name: /trends/i });
    expect(trendsLink).toHaveAttribute('aria-current', 'page');

    const settingsLink = screen.getByRole('link', { name: /^settings$/i });
    expect(settingsLink).toHaveAttribute('href', '/settings');
  });

  it('renders top-right Settings link (/settings) on /, /log, and /recipes headers and keeps Quick Search Strip only on / and /log', () => {
    const pages = [
      { name: 'Dashboard', node: <HomePage />, path: '/', hasSearchStrip: true },
      { name: 'Food Log', node: <LogPage />, path: '/log', hasSearchStrip: true },
      { name: 'Recipes', node: <RecipesPage />, path: '/recipes', hasSearchStrip: false },
    ];

    for (const page of pages) {
      mockUsePathname.mockReturnValue(page.path);
      const { unmount } = render(page.node);
      const settingsLink = screen.getByRole('link', { name: /^settings$/i });
      expect(settingsLink).toHaveAttribute('href', '/settings');

      const searchStripBtn = screen.queryByRole('button', { name: /search for a food/i });
      if (page.hasSearchStrip) {
        expect(searchStripBtn).toBeInTheDocument();
      } else {
        expect(searchStripBtn).not.toBeInTheDocument();
      }
      unmount();
    }
  });

  it('debounces sessionStorage scroll persistence instead of writing synchronously on scroll and flushes on pagehide', () => {
    vi.useFakeTimers();
    try {
      mockUsePathname.mockReturnValue('/log');
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
      const scrollWrites = () =>
        setItemSpy.mock.calls.filter(([k]) => String(k) === 'macro_scroll_/log');

      const { unmount } = render(
        <AppShell>
          <div>Scrollable Body</div>
        </AppShell>
      );
      setItemSpy.mockClear();

      Object.defineProperty(window, 'scrollY', { configurable: true, value: 120 });
      for (let i = 0; i < 5; i++) {
        window.dispatchEvent(new Event('scroll'));
      }

      // Never writes synchronously inside the scroll event handler
      expect(scrollWrites()).toHaveLength(0);

      // Debounced flush after idle (~250ms)
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(scrollWrites()).toHaveLength(1);
      expect(scrollWrites()[0][1]).toBe('120');

      // Immediate flush on pagehide
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 340 });
      window.dispatchEvent(new Event('scroll'));
      expect(scrollWrites()).toHaveLength(1);

      window.dispatchEvent(new Event('pagehide'));
      expect(scrollWrites()).toHaveLength(2);
      expect(scrollWrites()[1][1]).toBe('340');

      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
