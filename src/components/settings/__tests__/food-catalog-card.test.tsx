import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { db } from '@/lib/db/opencalory-db';
import type { CatalogSyncState } from '@/lib/foods/client-catalog';

const mockInitClientCatalog = vi.fn();
const mockGetCatalogSyncState = vi.fn<() => CatalogSyncState>();
const listeners = new Set<(state: CatalogSyncState) => void>();

vi.mock('@/lib/foods/client-catalog', () => ({
  initClientCatalog: () => mockInitClientCatalog(),
  getCatalogSyncState: () => mockGetCatalogSyncState(),
  subscribeCatalogSync: (cb: (state: CatalogSyncState) => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
}));

import { FoodCatalogCard } from '../food-catalog-card';

describe('FoodCatalogCard', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    listeners.clear();
    await db.foodsCache.clear();
    mockGetCatalogSyncState.mockReturnValue({
      status: 'ready',
      tier: 'core',
      foodCount: 24500,
      version: '2026.11.0',
    });
  });

  afterEach(async () => {
    await db.foodsCache.clear();
  });

  it('renders Core catalog tier, formatted food count, OPFS ready status, and ODbL attribution', () => {
    render(<FoodCatalogCard />);

    expect(mockInitClientCatalog).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Core')).toBeInTheDocument();
    expect(screen.getByText('24,500')).toBeInTheDocument();
    expect(screen.getByText(/Offline Ready \(OPFS\)/i)).toBeInTheDocument();

    // ODbL-1.0 attribution checks
    expect(screen.getByText(/Data Sources & Licenses/i)).toBeInTheDocument();
    expect(screen.getByText(/Open Food Facts/i)).toBeInTheDocument();
    expect(screen.getByText(/OpenNutrition/i)).toBeInTheDocument();
    expect(screen.getByText(/FoodRepo/i)).toBeInTheDocument();
    expect(screen.getByText(/USDA/i)).toBeInTheDocument();
    expect(screen.getByText(/BLS 4\.0/i)).toBeInTheDocument();
    expect(screen.getByText(/Anuvaad INDB/i)).toBeInTheDocument();
    expect(screen.getAllByText(/ODbL-1\.0/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/DATA_LICENSES\.md/i)).toBeInTheDocument();
  });

  it('renders Expanded tier and Server Fallback status with reason when OPFS falls back', () => {
    mockGetCatalogSyncState.mockReturnValue({
      status: 'fallback',
      tier: 'expanded',
      foodCount: 185000,
      version: '2026.11.0-expanded',
      reason: 'OPFS is unavailable in private browsing.',
    });

    render(<FoodCatalogCard />);

    expect(screen.getByText('Expanded')).toBeInTheDocument();
    expect(screen.getByText('185,000')).toBeInTheDocument();
    expect(screen.getByText(/Server Fallback/i)).toBeInTheDocument();
    expect(screen.getByText(/OPFS is unavailable in private browsing\./i)).toBeInTheDocument();
  });

  it('renders Syncing status when catalog is downloading', () => {
    mockGetCatalogSyncState.mockReturnValue({
      status: 'syncing',
      tier: 'core',
      foodCount: 24500,
      progressPct: 45,
    });

    render(<FoodCatalogCard />);

    expect(screen.getByText(/Syncing\.\.\./i)).toBeInTheDocument();
  });

  it('imports a valid .csv file into db.foodsCache with source custom_food and shows imported count', async () => {
    render(<FoodCatalogCard />);

    const csvContent = [
      'name,calories,protein,carbs,fat,fiber,brand',
      'Chicken Adobo,215,24,4,11,0.5,Home Kitchen',
      'Garlic Fried Rice,178,3.5,31,4.2,1.1,Home Kitchen',
    ].join('\n');

    const file = new File([csvContent], 'my-foods.csv', { type: 'text/csv' });
    const input = screen.getByTestId('food-catalog-file-input');

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText(/Imported 2 foods/i)).toBeInTheDocument();
    });

    const cached = await db.foodsCache.toArray();
    expect(cached).toHaveLength(2);
    expect(cached.every((item) => item.source === 'custom_food')).toBe(true);
    expect(cached.map((item) => item.name).sort()).toEqual([
      'Chicken Adobo',
      'Garlic Fried Rice',
    ]);
  });

  it('imports valid rows from a CSV with a malformed row and displays the row error message', async () => {
    render(<FoodCatalogCard />);

    const csvContent = [
      'name,calories,protein,carbs,fat',
      'Valid Oats,389,16.9,66.3,6.9',
      'Broken Entry,-50,10,20,5',
    ].join('\n');

    const file = new File([csvContent], 'partial.csv', { type: 'text/csv' });
    const input = screen.getByTestId('food-catalog-file-input');

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText(/Imported 1 food/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Row 3:.*calories/i)).toBeInTheDocument();

    const cached = await db.foodsCache.toArray();
    expect(cached).toHaveLength(1);
    expect(cached[0].name).toBe('Valid Oats');
    expect(cached[0].source).toBe('custom_food');
  });

  it('imports a valid .json file via parseFoodJson into db.foodsCache with source custom_food', async () => {
    render(<FoodCatalogCard />);

    const jsonContent = JSON.stringify([
      {
        name: 'Taho',
        calories: 92,
        protein: 4.5,
        carbs: 15,
        fat: 1.5,
        region: 'PH',
        source: 'usda',
      },
      {
        name: 'Pandesal',
        calories: 274,
        protein: 8.5,
        carbs: 52,
        fat: 3.5,
        region: 'PH',
      },
    ]);

    const file = new File([jsonContent], 'custom-foods.json', {
      type: 'application/json',
    });
    const input = screen.getByTestId('food-catalog-file-input');

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText(/Imported 2 foods/i)).toBeInTheDocument();
    });

    const cached = await db.foodsCache.toArray();
    expect(cached).toHaveLength(2);
    expect(cached.every((item) => item.source === 'custom_food')).toBe(true);
    expect(cached.map((item) => item.name).sort()).toEqual(['Pandesal', 'Taho']);
  });

  it('shows a clear message when uploading an empty valid CSV file', async () => {
    render(<FoodCatalogCard />);

    const emptyCsv = 'name,calories,protein,carbs,fat\n';
    const file = new File([emptyCsv], 'empty.csv', { type: 'text/csv' });
    const input = screen.getByTestId('food-catalog-file-input');

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText(/No foods found in file\./i)).toBeInTheDocument();
    });
  });
});
