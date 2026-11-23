import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { db } from '@/lib/db/opencalory-db';
import { useLoggerStore } from '@/stores/logger-store';
import { WeighInDrawer } from '../weigh-in-drawer';
import { AppleHealthShortcutCard } from '@/components/settings/apple-health-shortcut-card';

describe('WeighInDrawer & AppleHealthShortcutCard', () => {
  beforeEach(async () => {
    await db.weightLogs.clear();
    await db.userGoals.clear();
    useLoggerStore.setState({
      activeDate: '2026-11-20',
      activeSheet: null,
      undoToast: null,
    });
  });

  it('converts lb input to canonical weightKg on save and supports Undo', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();

    render(
      <WeighInDrawer
        open={true}
        defaultDate="2026-11-20"
        onClose={onClose}
        onSaved={onSaved}
      />
    );

    const lbButton = screen.getByRole('button', { name: /lb/i });
    fireEvent.click(lbButton);

    const weightInput = screen.getByLabelText(/weight/i) as HTMLInputElement;
    fireEvent.change(weightInput, { target: { value: '168.65' } });

    const noteInput = screen.getByLabelText(/note/i);
    fireEvent.change(noteInput, { target: { value: 'Morning weigh-in' } });

    const submitBtn = screen.getByRole('button', { name: /save weigh-in/i });
    fireEvent.click(submitBtn);

    await waitFor(async () => {
      const all = await db.weightLogs.toArray();
      expect(all).toHaveLength(1);
      expect(all[0].weightKg).toBe(76.5);
      expect(all[0].date).toBe('2026-11-20');
      expect(all[0].note).toBe('Morning weigh-in');
      expect(all[0].source).toBe('manual');
      expect(all[0].recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    const undoToast = useLoggerStore.getState().undoToast;
    expect(undoToast).not.toBeNull();
    await undoToast?.onUndo();
    expect(await db.weightLogs.count()).toBe(0);
  });

  it('supports quick steppers, unit toggle display conversion, and editing an existing entry with Undo restore', async () => {
    const existingEntry = {
      id: 'w_existing',
      date: '2026-11-19',
      weightKg: 75.0,
      note: 'Initial note',
      source: 'manual' as const,
      recordedAt: '2026-11-19T07:30:00.000Z',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await db.weightLogs.put(existingEntry);

    const onClose = vi.fn();
    render(
      <WeighInDrawer
        open={true}
        initialEntry={existingEntry}
        onClose={onClose}
      />
    );

    const weightInput = screen.getByLabelText(/weight/i) as HTMLInputElement;
    expect(weightInput.value).toBe('75');

    const plusHalfBtn = screen.getByRole('button', { name: '+0.5' });
    fireEvent.click(plusHalfBtn);
    expect(weightInput.value).toBe('75.5');

    const submitBtn = screen.getByRole('button', { name: /update weigh-in/i });
    fireEvent.click(submitBtn);

    await waitFor(async () => {
      const updated = await db.weightLogs.get('w_existing');
      expect(updated?.weightKg).toBe(75.5);
    });

    const undoToast = useLoggerStore.getState().undoToast;
    expect(undoToast).not.toBeNull();
    await undoToast?.onUndo();

    const restored = await db.weightLogs.get('w_existing');
    expect(restored?.weightKg).toBe(75.0);
  });

  it('aligns recordedAt with the selected past Date when backfilling, and preserves recordedAt when editing without changing date', async () => {
    const onClose = vi.fn();

    const { unmount } = render(
      <WeighInDrawer
        open={true}
        defaultDate="2026-11-21"
        onClose={onClose}
      />
    );

    const weightInput = screen.getByLabelText(/weight/i) as HTMLInputElement;
    fireEvent.change(weightInput, { target: { value: '75.8' } });

    const dateInput = screen.getByLabelText(/^date$/i) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-11-18' } });

    fireEvent.click(screen.getByRole('button', { name: /save weigh-in/i }));

    await waitFor(async () => {
      const all = await db.weightLogs.toArray();
      expect(all).toHaveLength(1);
      expect(all[0].date).toBe('2026-11-18');
      expect(all[0].recordedAt.startsWith('2026-11-18T')).toBe(true);
    });

    unmount();

    const saved = (await db.weightLogs.toArray())[0];
    const originalRecordedAt = saved.recordedAt;

    render(
      <WeighInDrawer
        open={true}
        initialEntry={saved}
        onClose={onClose}
      />
    );

    const editWeightInput = screen.getByLabelText(/weight/i) as HTMLInputElement;
    fireEvent.change(editWeightInput, { target: { value: '75.9' } });
    fireEvent.click(screen.getByRole('button', { name: /update weigh-in/i }));

    await waitFor(async () => {
      const updated = await db.weightLogs.get(saved.id);
      expect(updated?.weightKg).toBe(75.9);
      expect(updated?.recordedAt).toBe(originalRecordedAt);
    });
  });

  it('renders AppleHealthShortcutCard with Awaiting Shortcut Setup before first call, then Connected after shortcut syncs', async () => {
    await db.weightLogs.put({
      id: 'w_200',
      date: '2026-11-20',
      weightKg: 76.5,
      source: 'manual',
      recordedAt: '2026-11-20T08:00:00.000Z',
      createdAt: 2000,
      updatedAt: 2000,
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            configured: true,
            connected: false,
            lastSyncedAt: null,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            configured: true,
            connected: true,
            lastSyncedAt: '2026-11-23T15:30:00.000Z',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );

    render(<AppleHealthShortcutCard />);

    await waitFor(() => {
      expect(screen.getByText(/apple health ios shortcut/i)).toBeInTheDocument();
      expect(screen.getByText(/^awaiting shortcut setup$/i)).toBeInTheDocument();
      expect(
        screen.getAllByText(/\/api\/weight\/latest\?tz=Asia\/Manila/i).length
      ).toBeGreaterThan(0);
      expect(screen.getByText(/backfilled/i)).toBeInTheDocument();
      expect(screen.getAllByText(/168\.65/).length).toBeGreaterThan(0);
      expect(screen.getByText(/5-step ios personal automation guide/i)).toBeInTheDocument();
      expect(screen.getAllByText(/opencalory-last-weight-id\.txt/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/automate daily sync/i)).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole('button', { name: /refresh shortcut api status/i })
    );

    await waitFor(() => {
      expect(screen.getByText(/^connected$/i)).toBeInTheDocument();
      expect(screen.getByText(/last shortcut sync/i)).toBeInTheDocument();
    });

    fetchSpy.mockRestore();
  });
});
