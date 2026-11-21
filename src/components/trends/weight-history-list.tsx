'use client';

import React, { useMemo } from 'react';
import { Pencil, Plus, Scale, StickyNote, Trash2 } from 'lucide-react';
import { db } from '@/lib/db/opencalory-db';
import type { DailyWeightPoint } from '@/lib/nutrition/adaptive-tdee';
import { useLoggerStore } from '@/stores/logger-store';
import { triggerHaptic } from '@/lib/motion';
import { formatWeight } from '@/components/trends/chart-utils';
import type { WeightLogEntry } from '@/types/nutrition';

export interface WeightHistoryListProps {
  entries: WeightLogEntry[];
  weightSeries: DailyWeightPoint[];
  unit: 'kg' | 'lb';
  onEdit: (entry: WeightLogEntry) => void;
  onLogFirst: () => void;
  className?: string;
}

export function WeightHistoryList({
  entries,
  weightSeries,
  unit,
  onEdit,
  onLogFirst,
  className = '',
}: WeightHistoryListProps) {
  const showUndoToast = useLoggerStore((s) => s.showUndoToast);

  const sortedEntries = useMemo(() => {
    return [...(entries ?? [])].sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
  }, [entries]);

  const { trendById, trendByDate } = useMemo(() => {
    const byId = new Map<string, number>();
    const byDate = new Map<string, number>();
    for (const pt of weightSeries ?? []) {
      byId.set(pt.entryId, pt.trendKg);
      byDate.set(pt.date, pt.trendKg);
    }
    return { trendById: byId, trendByDate: byDate };
  }, [weightSeries]);

  const handleDelete = async (entry: WeightLogEntry) => {
    const snapshot: WeightLogEntry = { ...entry };
    try {
      await db.weightLogs.delete(entry.id);
      triggerHaptic(12);
      showUndoToast({
        message: `Removed weigh-in (${formatWeight(entry.weightKg, unit)})`,
        onUndo: async () => {
          await db.weightLogs.put(snapshot);
        },
      });
    } catch (err) {
      console.error('Failed to delete weigh-in entry:', err);
    }
  };

  return (
    <section
      aria-label="Weight History"
      data-testid="weight-history-list"
      className={`bg-card border border-border/50 rounded-2xl p-4 sm:p-5 space-y-3.5 ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-[var(--macro-fiber)]/15 flex items-center justify-center text-[var(--macro-fiber)] shrink-0">
            <Scale className="w-4 h-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold tracking-tight text-foreground">
              Weight History
            </h2>
            <p className="text-xs text-muted-foreground tabular-nums">
              {sortedEntries.length} {sortedEntries.length === 1 ? 'weigh-in' : 'weigh-ins'} logged
            </p>
          </div>
        </div>
      </div>

      {sortedEntries.length === 0 ? (
        <div className="rounded-xl bg-surface-sub/60 border border-border/40 p-6 text-center space-y-2.5">
          <p className="text-sm font-semibold text-foreground">No weigh-ins logged yet</p>
          <p className="text-xs text-muted-foreground max-w-[34ch] mx-auto leading-relaxed">
            Record periodic scale weights to smooth daily fluctuations and unlock adaptive TDEE tracking.
          </p>
          <button
            type="button"
            onClick={() => {
              triggerHaptic(8);
              onLogFirst();
            }}
            className="tactile-press mt-1 inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-foreground text-background text-xs font-semibold hover:opacity-90"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Log First Weigh-In</span>
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-border/60 -mx-1">
          {sortedEntries.map((entry) => {
            const trendKg = trendById.get(entry.id) ?? trendByDate.get(entry.date);
            const trimmedNote = entry.note?.trim();

            return (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-3 py-2.5 px-1.5 rounded-xl hover:bg-surface-sub/40 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 tabular-nums">
                    <span className="text-sm font-semibold text-foreground">
                      {formatWeight(entry.weightKg, unit)}
                    </span>
                    {trendKg !== undefined && (
                      <span className="text-xs text-muted-foreground">
                        Trend{' '}
                        <span
                          className="font-semibold"
                          style={{ color: 'var(--macro-calories)' }}
                        >
                          {formatWeight(trendKg, unit)}
                        </span>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                    <span className="tabular-nums">{entry.date}</span>
                    {trimmedNote && (
                      <span className="inline-flex items-center gap-1 truncate">
                        <StickyNote className="w-3 h-3 shrink-0 opacity-75" aria-hidden="true" />
                        <span className="truncate">{trimmedNote}</span>
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic(8);
                      onEdit(entry);
                    }}
                    aria-label={`Edit weigh-in ${entry.date}`}
                    className="touch-target tactile-press w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface-sub"
                  >
                    <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(entry)}
                    aria-label={`Delete weigh-in ${entry.date}`}
                    className="touch-target tactile-press w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface-sub"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
