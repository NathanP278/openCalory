'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertCircle, Calendar, Check, CopyPlus, X } from 'lucide-react';
import { db } from '@/lib/db/opencalory-db';
import { copyLogsFromDate, offsetIsoDate } from '@/lib/recipes/recipe-builder';
import { useLoggerStore, formatHumanDate } from '@/stores/logger-store';
import {
  EASE_EXPRESSIVE,
  SPRING_SHEET,
  isTestEnvironment,
  triggerHaptic,
} from '@/lib/motion';

export interface CopyFromDateDrawerProps {
  open: boolean;
  targetDate: string;
  onClose: () => void;
}

function formatAmount(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  return String(Number(amount.toFixed(1)));
}

function CopyFromDateContent({
  targetDate,
  onClose,
}: {
  targetDate: string;
  onClose: () => void;
}) {
  const yesterdayIso = useMemo(() => offsetIsoDate(targetDate, -1), [targetDate]);
  const twoDaysAgoIso = useMemo(() => offsetIsoDate(targetDate, -2), [targetDate]);
  const lastWeekIso = useMemo(() => offsetIsoDate(targetDate, -7), [targetDate]);

  const [sourceDate, setSourceDate] = useState<string>(() => yesterdayIso);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(() => new Set());
  const [isCopying, setIsCopying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const showUndoToast = useLoggerStore((s) => s.showUndoToast);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const rawEntries = useLiveQuery(
    () => db.foodLogs.where('date').equals(sourceDate).toArray(),
    [sourceDate]
  );

  const entries = useMemo(
    () => [...(rawEntries ?? [])].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
    [rawEntries]
  );

  const selectedEntries = useMemo(
    () => entries.filter((entry) => !excludedIds.has(entry.id)),
    [entries, excludedIds]
  );

  const selectedIds = useMemo(() => selectedEntries.map((e) => e.id), [selectedEntries]);

  const selectedCalories = useMemo(
    () =>
      Math.round(
        selectedEntries.reduce(
          (sum, e) => sum + (Number(e.nutritionSnapshot?.calories) || 0),
          0
        )
      ),
    [selectedEntries]
  );

  const handleSourceDateChange = (nextDate: string) => {
    setSourceDate(nextDate);
    setExcludedIds(new Set());
    setErrorMessage(null);
  };

  const handleToggleEntry = (id: string) => {
    triggerHaptic(6);
    setExcludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = entries.length > 0 && selectedEntries.length === entries.length;

  const handleToggleSelectAll = () => {
    triggerHaptic(6);
    if (allSelected) {
      setExcludedIds(new Set(entries.map((e) => e.id)));
    } else {
      setExcludedIds(new Set());
    }
  };

  const runCopy = async (idsToCopy?: string[]) => {
    if (isCopying || entries.length === 0) return;
    setIsCopying(true);
    setErrorMessage(null);

    try {
      const { count, insertedIds } = await copyLogsFromDate(
        sourceDate,
        targetDate,
        idsToCopy
      );
      triggerHaptic(10);

      if (count > 0) {
        showUndoToast({
          message: `Copied ${count} ${count === 1 ? 'entry' : 'entries'} from ${sourceDate}`,
          onUndo: async () => {
            if (insertedIds.length > 0) {
              await db.foodLogs.bulkDelete(insertedIds);
            }
          },
        });
      }

      onClose();
    } catch (err) {
      console.error('Failed to copy logs from date:', err);
      setErrorMessage('Unable to copy entries offline. Please try again.');
    } finally {
      setIsCopying(false);
    }
  };

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Copy From Date"
      data-testid="copy-from-date-drawer"
      initial={isTestEnvironment() ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={isTestEnvironment() ? undefined : { opacity: 0 }}
      transition={{ duration: 0.24, ease: EASE_EXPRESSIVE }}
      className="fixed inset-0 z-50 flex flex-col justify-end sm:items-center sm:justify-center sm:p-6 bg-black/70 backdrop-blur-md"
      onClick={onClose}
    >
      <motion.div
        initial={isTestEnvironment() ? false : { opacity: 0, y: 48, scale: 0.94 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={isTestEnvironment() ? undefined : { opacity: 0, y: 36, scale: 0.95 }}
        transition={SPRING_SHEET}
        className="w-full max-w-lg mx-auto surface-elevated-sheet rounded-t-3xl sm:rounded-3xl px-4 sm:px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-5 max-h-[90dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="w-9 h-1 rounded-full bg-border mx-auto mb-3 shrink-0 sm:hidden"
          aria-hidden="true"
        />

        {/* Header */}
        <div className="shrink-0 flex items-center justify-between pb-3 border-b border-border gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-surface-sub border border-border/60 flex items-center justify-center text-[var(--macro-calories)] shrink-0">
              <CopyPlus className="w-4 h-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground truncate">
                Copy From Date
              </h2>
              <p className="text-[11px] text-muted-foreground tabular-nums truncate">
                Copy logged meals into {formatHumanDate(targetDate)}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close copy drawer"
            className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub shrink-0"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Date Picker & Quick Chips */}
        <div className="pt-4 space-y-3 shrink-0">
          <div className="bg-surface-sub border border-border rounded-2xl p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="copy-source-date"
                className="flex items-center gap-2 text-xs font-semibold text-foreground shrink-0"
              >
                <Calendar className="w-3.5 h-3.5 text-[var(--macro-calories)]" aria-hidden="true" />
                <span>Source Date</span>
              </label>
              <input
                id="copy-source-date"
                aria-label="Source date"
                type="date"
                value={sourceDate}
                onChange={(e) => handleSourceDateChange(e.target.value)}
                className="px-2.5 py-1.5 text-base sm:text-xs font-medium tabular-nums rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { label: 'Yesterday', iso: yesterdayIso },
                { label: '2 days ago', iso: twoDaysAgoIso },
                { label: 'Last week', iso: lastWeekIso },
              ].map((preset) => {
                const active = sourceDate === preset.iso;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      triggerHaptic(6);
                      handleSourceDateChange(preset.iso);
                    }}
                    className={`tactile-press px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                      active
                        ? 'bg-foreground text-background shadow-xs'
                        : 'bg-card text-muted-foreground hover:text-foreground border border-border/60'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          {entries.length > 0 && (
            <div className="flex items-center justify-between gap-2 px-1 text-xs">
              <span className="text-muted-foreground tabular-nums">
                <strong className="text-foreground">{selectedEntries.length}</strong> of{' '}
                {entries.length} selected Â·{' '}
                <strong className="text-[var(--macro-calories)]">
                  {selectedCalories.toLocaleString()} kcal
                </strong>
              </span>

              <button
                type="button"
                onClick={handleToggleSelectAll}
                className="tactile-press text-[11px] font-semibold text-foreground hover:opacity-80 px-2.5 py-1 rounded-full bg-surface-sub border border-border/60"
              >
                {allSelected ? 'Deselect All' : 'Select All'}
              </button>
            </div>
          )}
        </div>

        {/* Source Entries List */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain py-3 space-y-2">
          {rawEntries === undefined ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              Loading entries...
            </div>
          ) : entries.length === 0 ? (
            <div className="rounded-2xl bg-surface-sub/60 border border-border/50 p-6 text-center space-y-1">
              <p className="text-xs font-semibold text-foreground">
                No logged entries on {sourceDate}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Pick another past date to preview and copy meals.
              </p>
            </div>
          ) : (
            <ul className="rounded-2xl bg-surface-sub/55 border border-border/60 divide-y divide-border/60 overflow-hidden">
              {entries.map((entry) => {
                const isChecked = !excludedIds.has(entry.id);
                const snap = entry.nutritionSnapshot;

                return (
                  <li key={entry.id}>
                    <label className="flex items-center justify-between gap-3 px-3.5 py-2.5 cursor-pointer hover:bg-card/50 transition-colors">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleToggleEntry(entry.id)}
                          aria-label={`Select ${entry.name}`}
                          className="w-4 h-4 rounded accent-[var(--macro-calories)] shrink-0 cursor-pointer"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold text-foreground truncate">
                            {entry.name}
                          </div>
                          <div className="text-[11px] text-muted-foreground tabular-nums truncate">
                            {formatAmount(entry.amount)} {entry.unit}
                          </div>
                        </div>
                      </div>

                      <div className="text-right tabular-nums shrink-0">
                        <div
                          className="text-xs font-bold"
                          style={{ color: 'var(--macro-calories)' }}
                        >
                          {Math.round(snap?.calories ?? 0)} kcal
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          <span className="text-[var(--macro-protein)]">
                            {Math.round(snap?.protein ?? 0)}P
                          </span>{' '}
                          Â·{' '}
                          <span className="text-[var(--macro-carbs)]">
                            {Math.round(snap?.carbs ?? 0)}C
                          </span>{' '}
                          Â·{' '}
                          <span className="text-[var(--macro-fat)]">
                            {Math.round(snap?.fat ?? 0)}F
                          </span>
                        </div>
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="mb-3 p-2.5 rounded-xl bg-surface-sub border border-border text-[var(--neutral-over)] text-xs flex items-center gap-2 shrink-0"
          >
            <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Footer Actions */}
        <div className="shrink-0 pt-3 border-t border-border flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void runCopy(undefined)}
            disabled={isCopying || entries.length === 0}
            className="touch-target tactile-press px-4 py-2 rounded-full bg-surface-sub border border-border hover:bg-card disabled:opacity-45 text-foreground text-xs font-semibold tabular-nums"
          >
            Copy All ({entries.length})
          </button>

          <button
            type="button"
            onClick={() => void runCopy(selectedIds)}
            disabled={isCopying || selectedIds.length === 0}
            className="touch-target tactile-press inline-flex items-center gap-1.5 px-5 py-2 rounded-full bg-foreground hover:opacity-90 disabled:opacity-45 text-background text-xs font-semibold shadow-xs tabular-nums"
          >
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Copy Selected ({selectedIds.length})</span>
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export function CopyFromDateDrawer({ open, targetDate, onClose }: CopyFromDateDrawerProps) {
  return (
    <AnimatePresence>
      {open && <CopyFromDateContent key={targetDate} targetDate={targetDate} onClose={onClose} />}
    </AnimatePresence>
  );
}
