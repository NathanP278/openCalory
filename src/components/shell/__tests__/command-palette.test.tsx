import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CommandPalette } from '../command-palette';
import { useLoggerStore } from '@/stores/logger-store';
import { db } from '@/lib/db/opencalory-db';

describe('CommandPalette', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.delete();
    await db.open();
    useLoggerStore.setState({
      activeDate: '2026-11-14',
      dateDirection: null,
      activeMealSlot: 'log',
      activeSheet: null,
      searchInitialQuery: '',
      aiDraft: null,
      undoToast: null,
      isCommandPaletteOpen: true,
      syncAuthLocked: false,
    });
  });

  it('includes Go to Trends (/trends) link and Log Weight action opening weight sheet', () => {
    render(<CommandPalette />);

    const trendsLink = screen.getByRole('option', { name: /go to trends/i });
    expect(trendsLink).toHaveAttribute('href', '/trends');

    const logWeightBtn = screen.getByRole('option', { name: /log weight/i });
    fireEvent.click(logWeightBtn);

    expect(useLoggerStore.getState().activeSheet).toBe('weight');
    expect(useLoggerStore.getState().isCommandPaletteOpen).toBe(false);
  });

  it("copies yesterday's logs and Undo deletes only the inserted clones via bulkDelete", async () => {
    await db.foodLogs.bulkAdd([
      {
        id: 'yest-1',
        date: '2026-11-13',
        mealSlot: 'log',
        foodId: 'staple:eggs',
        name: 'Boiled Eggs',
        source: 'staple',
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
      },
      {
        id: 'yest-2',
        date: '2026-11-13',
        mealSlot: 'log',
        foodId: 'staple:rice',
        name: 'White Rice',
        source: 'staple',
        amount: 150,
        unit: 'g',
        nutritionSnapshot: {
          calories: 195,
          protein: 4,
          carbs: 42,
          fat: 0.4,
          fiber: 0.6,
          micros: {},
        },
        createdAt: 2000,
      },
    ]);

    render(<CommandPalette />);

    const copyBtn = screen.getByRole('option', { name: /copy yesterday's logs/i });
    fireEvent.click(copyBtn);

    await waitFor(async () => {
      const todayEntries = await db.foodLogs.where('date').equals('2026-11-14').toArray();
      expect(todayEntries).toHaveLength(2);
    });

    const bulkDeleteSpy = vi.spyOn(db.foodLogs, 'bulkDelete');
    const clonedIds = (
      await db.foodLogs.where('date').equals('2026-11-14').toArray()
    ).map((e) => e.id);

    const toast = useLoggerStore.getState().undoToast;
    expect(toast).not.toBeNull();
    expect(toast?.message).toBe('Copied 2 items from yesterday');

    await toast!.onUndo();

    expect(bulkDeleteSpy).toHaveBeenCalledTimes(1);
    expect(bulkDeleteSpy).toHaveBeenCalledWith(expect.arrayContaining(clonedIds));

    const todayAfterUndo = await db.foodLogs.where('date').equals('2026-11-14').toArray();
    const yesterdayAfterUndo = await db.foodLogs.where('date').equals('2026-11-13').toArray();
    expect(todayAfterUndo).toHaveLength(0);
    expect(yesterdayAfterUndo).toHaveLength(2);
  });

  it("reports when yesterday has no logs without throwing", async () => {
    render(<CommandPalette />);

    const copyBtn = screen.getByRole('option', { name: /copy yesterday's logs/i });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      const toast = useLoggerStore.getState().undoToast;
      expect(toast).not.toBeNull();
      expect(toast?.message).toBe('No entries found for yesterday');
    });
  });
});
