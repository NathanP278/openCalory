'use client';

import React, { useState } from 'react';
import { ArrowRight, Check, Sparkles, X } from 'lucide-react';
import { db } from '@/lib/db/opencalory-db';
import {
  applyWeeklyCheckInToGoals,
  type WeeklyCheckInProposal,
} from '@/lib/nutrition/adaptive-tdee';
import { useLoggerStore } from '@/stores/logger-store';
import { triggerHaptic } from '@/lib/motion';
import { formatInt, toUnit } from '@/components/trends/chart-utils';
import type { UserGoals } from '@/types/nutrition';

export interface WeeklyCheckInCardProps {
  goals: UserGoals;
  proposal: WeeklyCheckInProposal;
  unit?: 'kg' | 'lb';
  className?: string;
}

function formatSignedDelta(delta: number): string {
  const rounded = Math.round(delta);
  if (rounded > 0) return `+${rounded} kcal`;
  if (rounded < 0) return `${rounded} kcal`;
  return '0 kcal';
}

function formatWeeklyRate(rateKg: number, unit: 'kg' | 'lb'): string {
  const val = toUnit(rateKg, unit);
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)} ${unit}/wk`;
}

export function WeeklyCheckInCard({
  goals,
  proposal,
  unit = 'kg',
  className = '',
}: WeeklyCheckInCardProps) {
  const showUndoToast = useLoggerStore((s) => s.showUndoToast);
  const [isBusy, setIsBusy] = useState(false);

  const handleAccept = async () => {
    if (isBusy) return;
    setIsBusy(true);
    const previousSnapshot: UserGoals = {
      ...goals,
      micronutrientTargets: { ...goals.micronutrientTargets },
      ...(goals.weeklySchedule ? { weeklySchedule: { ...goals.weeklySchedule } } : {}),
    };

    try {
      const now = Date.now();
      const updated = applyWeeklyCheckInToGoals(goals, proposal, now);
      await db.userGoals.put(updated);
      triggerHaptic(12);
      showUndoToast({
        message: `Updated daily target to ${formatInt(proposal.proposedCalories)} kcal`,
        onUndo: async () => {
          await db.userGoals.put(previousSnapshot);
        },
      });
    } catch (err) {
      console.error('Failed to apply weekly check-in:', err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleDismiss = async () => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const now = Date.now();
      await db.userGoals.put({
        ...goals,
        lastCheckInDismissedAt: now,
        updatedAt: now,
      });
      triggerHaptic(8);
    } catch (err) {
      console.error('Failed to dismiss weekly check-in:', err);
    } finally {
      setIsBusy(false);
    }
  };

  const { proposedMacros } = proposal;

  return (
    <section
      aria-label="Weekly Adaptive Check-In"
      data-testid="weekly-checkin-card"
      className={`bg-card border border-border/60 rounded-2xl p-4 sm:p-5 space-y-4 ${className}`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-2xl bg-[var(--macro-calories)]/15 flex items-center justify-center text-[var(--macro-calories)] shrink-0">
            <Sparkles className="w-4 h-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold tracking-tight text-foreground">
                Weekly Check-In Ready
              </h2>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold tabular-nums bg-surface-sub border border-border/50 text-foreground">
                {formatSignedDelta(proposal.deltaCalories)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Based on your observed expenditure and smoothed weight trend
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleDismiss()}
            className="touch-target tactile-press inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-surface-sub border border-border/60 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-surface-elevated disabled:opacity-50"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Dismiss</span>
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleAccept()}
            className="touch-target tactile-press inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-foreground text-background text-xs font-semibold hover:opacity-90 disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Accept</span>
          </button>
        </div>
      </div>

      {/* Telemetry Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl bg-surface-sub/80 border border-border/40 px-3.5 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Observed TDEE
          </div>
          <div className="text-lg font-bold tabular-nums text-foreground mt-0.5">
            {formatInt(proposal.observedTdee)}{' '}
            <span className="text-xs font-normal text-muted-foreground">kcal</span>
          </div>
        </div>

        <div className="rounded-xl bg-surface-sub/80 border border-border/40 px-3.5 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Weekly Trend Rate
          </div>
          <div className="text-lg font-bold tabular-nums text-foreground mt-0.5">
            {formatWeeklyRate(proposal.weeklyRateKg, unit)}
          </div>
        </div>

        <div className="rounded-xl bg-surface-sub/80 border border-border/40 px-3.5 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Daily Target
          </div>
          <div className="flex items-center gap-1.5 text-lg font-bold tabular-nums text-foreground mt-0.5">
            <span className="text-muted-foreground font-semibold text-sm">
              {formatInt(proposal.currentBaselineCalories)}
            </span>
            <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
            <span style={{ color: 'var(--macro-calories)' }}>
              {formatInt(proposal.proposedCalories)}
            </span>
            <span className="text-xs font-normal text-muted-foreground">kcal</span>
          </div>
        </div>
      </div>

      {/* Proposed Macros Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-border/40 text-xs tabular-nums">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-muted-foreground font-medium">Proposed targets:</span>
          <span>
            <span className="font-semibold" style={{ color: 'var(--macro-protein)' }}>
              {Math.round(proposedMacros.proteinG)}g
            </span>{' '}
            <span className="text-muted-foreground">P</span>
          </span>
          <span>
            <span className="font-semibold" style={{ color: 'var(--macro-carbs)' }}>
              {Math.round(proposedMacros.carbsG)}g
            </span>{' '}
            <span className="text-muted-foreground">C</span>
          </span>
          <span>
            <span className="font-semibold" style={{ color: 'var(--macro-fat)' }}>
              {Math.round(proposedMacros.fatG)}g
            </span>{' '}
            <span className="text-muted-foreground">F</span>
          </span>
          <span>
            <span className="font-semibold" style={{ color: 'var(--macro-fiber)' }}>
              {Math.round(proposedMacros.fiberG)}g
            </span>{' '}
            <span className="text-muted-foreground">Fiber</span>
          </span>
        </div>

        {proposal.preservesCycling && (
          <span className="text-[11px] text-muted-foreground">
            Shifts all 7 days equally while preserving weekly calorie cycling
          </span>
        )}
      </div>
    </section>
  );
}
