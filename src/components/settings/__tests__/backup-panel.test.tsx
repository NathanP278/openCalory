import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BackupPanel } from '../backup-panel';
import * as backupModule from '@/lib/db/backup';
import * as csvExportModule from '@/lib/db/csv-export';
import { db } from '@/lib/db/opencalory-db';

describe('BackupPanel', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.delete();
    await db.open();
  });

  it('renders backup export, CSV export, and import controls', () => {
    render(<BackupPanel />);

    expect(screen.getByRole('button', { name: /export backup/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /food logs csv/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /daily summary csv/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /weigh-ins csv/i })).toBeInTheDocument();
    expect(screen.getByText(/data backup & restore/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^merge$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^replace$/i })).toBeInTheDocument();
  });

  it('triggers export and creates a downloadable JSON file', async () => {
    const mockJson = JSON.stringify({ version: 2, exportedAt: 1000, tables: {} });
    vi.spyOn(backupModule, 'exportBackupJson').mockResolvedValue(mockJson);

    // Mock URL.createObjectURL and URL.revokeObjectURL
    const createObjectURLSpy = vi.fn().mockReturnValue('blob:mock-url');
    const revokeObjectURLSpy = vi.fn();
    window.URL.createObjectURL = createObjectURLSpy;
    window.URL.revokeObjectURL = revokeObjectURLSpy;

    render(<BackupPanel />);

    const exportBtn = screen.getByRole('button', { name: /export backup/i });
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(backupModule.exportBackupJson).toHaveBeenCalled();
      expect(createObjectURLSpy).toHaveBeenCalled();
      expect(screen.getByText(/backup exported successfully/i)).toBeInTheDocument();
    });
  });

  it('downloads Food Logs CSV, Daily Summary CSV, and Weigh-Ins CSV from IndexedDB', async () => {
    await db.foodLogs.put({
      id: 'log-csv-1',
      date: '2026-11-20',
      foodId: 'staple:oats',
      name: '=SUM(1,2) Oats',
      source: 'staple',
      amount: 80,
      unit: 'g',
      nutritionSnapshot: {
        calories: 300,
        protein: 10,
        carbs: 54,
        fat: 5,
        fiber: 8,
        micros: { sodiumMg: 5 },
      },
      createdAt: 1000,
    });
    await db.weightLogs.put({
      id: 'weight-csv-1',
      date: '2026-11-20',
      weightKg: 76.2,
      source: 'manual',
      recordedAt: '2026-11-20T07:00:00.000Z',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const foodCsvSpy = vi.spyOn(csvExportModule, 'buildFoodLogsCsv');
    const summaryCsvSpy = vi.spyOn(csvExportModule, 'buildDailySummaryCsv');
    const weightCsvSpy = vi.spyOn(csvExportModule, 'buildWeightLogsCsv');

    const createObjectURLSpy = vi.fn().mockReturnValue('blob:mock-csv');
    const revokeObjectURLSpy = vi.fn();
    window.URL.createObjectURL = createObjectURLSpy;
    window.URL.revokeObjectURL = revokeObjectURLSpy;

    render(<BackupPanel />);

    fireEvent.click(screen.getByRole('button', { name: /food logs csv/i }));
    await waitFor(() => {
      expect(foodCsvSpy).toHaveBeenCalledTimes(1);
      expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/food logs csv exported/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /daily summary csv/i }));
    await waitFor(() => {
      expect(summaryCsvSpy).toHaveBeenCalledTimes(1);
      expect(createObjectURLSpy).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/daily summary csv exported/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /weigh-ins csv/i }));
    await waitFor(() => {
      expect(weightCsvSpy).toHaveBeenCalledTimes(1);
      expect(createObjectURLSpy).toHaveBeenCalledTimes(3);
      expect(screen.getByText(/weigh-ins csv exported/i)).toBeInTheDocument();
    });
  });

  it('imports valid backup file in merge mode and shows imported counts', async () => {
    vi.spyOn(backupModule, 'importBackupJson').mockResolvedValue({
      importedCounts: {
        foodLogs: 5,
        foodsCache: 2,
        customRecipes: 1,
        userGoals: 1,
        weightLogs: 3,
        pinnedFoods: 2,
      },
    });

    render(<BackupPanel />);

    const file = new File(['{"version": 2}'], 'opencalory-backup.json', {
      type: 'application/json',
    });

    const fileInput = screen.getByTestId('backup-file-input');
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(backupModule.importBackupJson).toHaveBeenCalledWith(
        expect.any(String),
        'merge'
      );
      expect(
        screen.getByText(/imported: 5 logs, 2 foods, 1 recipe, 1 goal, 3 weigh-ins, 2 pinned/i)
      ).toBeInTheDocument();
    });
  });

  it('displays error message when importing corrupt backup file', async () => {
    vi.spyOn(backupModule, 'importBackupJson').mockRejectedValue(
      new Error('Invalid backup schema')
    );

    render(<BackupPanel />);

    const file = new File(['bad json'], 'corrupt.json', {
      type: 'application/json',
    });

    const fileInput = screen.getByTestId('backup-file-input');
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText(/invalid backup schema/i)).toBeInTheDocument();
    });
  });

  it('handles replace mode with branded confirmation modal', async () => {
    const importSpy = vi.spyOn(backupModule, 'importBackupJson').mockResolvedValue({
      importedCounts: {
        foodLogs: 1,
        foodsCache: 0,
        customRecipes: 0,
        userGoals: 0,
        weightLogs: 0,
        pinnedFoods: 0,
      },
    });

    render(<BackupPanel />);

    // Switch to replace mode
    const replaceBtn = screen.getByRole('button', { name: /^replace$/i });
    fireEvent.click(replaceBtn);

    expect(screen.getByText(/replace mode:/i)).toBeInTheDocument();

    const file = new File(['{"version": 1}'], 'replace.json', { type: 'application/json' });
    const fileInput = screen.getByTestId('backup-file-input');

    // 1. User cancels confirmation modal
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByTestId('replace-confirm-modal')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByTestId('replace-confirm-modal')).not.toBeInTheDocument();
    expect(importSpy).not.toHaveBeenCalled();

    // 2. User confirms replace in modal
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByTestId('replace-confirm-modal')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /replace all data/i }));

    await waitFor(() => {
      expect(importSpy).toHaveBeenCalledWith(expect.any(String), 'replace');
      expect(screen.getByText(/imported: 1 log, 0 foods, 0 recipes, 0 goals/i)).toBeInTheDocument();
    });
  });

  it('shows neutral pending cloud sync note when importBackupJson reports syncPending', async () => {
    vi.spyOn(backupModule, 'importBackupJson').mockResolvedValue({
      importedCounts: {
        foodLogs: 1,
        foodsCache: 0,
        customRecipes: 0,
        userGoals: 0,
        weightLogs: 0,
        pinnedFoods: 0,
      },
      syncPending: true,
    });

    render(<BackupPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^replace$/i }));

    const file = new File(['{"version": 2}'], 'replace.json', { type: 'application/json' });
    fireEvent.change(screen.getByTestId('backup-file-input'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByTestId('replace-confirm-modal')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /replace all data/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/imported: 1 log, 0 foods, 0 recipes, 0 goals.*cloud replace queued until unlock\/reconnect/i)
      ).toBeInTheDocument();
    });
  });
});
