'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, Check, Scale, X } from 'lucide-react';
import { db, generateId } from '@/lib/db/opencalory-db';
import { useLoggerStore } from '@/stores/logger-store';
import {
  EASE_EXPRESSIVE,
  SPRING_SHEET,
  isTestEnvironment,
  triggerHaptic,
} from '@/lib/motion';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import type { WeightLogEntry } from '@/types/nutrition';

export const KG_TO_LB = 2.20462;

export interface WeighInDrawerProps {
  open: boolean;
  initialEntry?: WeightLogEntry | null;
  defaultDate?: string;
  onClose: () => void;
  onSaved?: (entry: WeightLogEntry) => void;
}

function getTodayIsoDate(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function buildRecordedAtForDate(
  targetDate: string,
  nowMs: number,
  initialEntry?: WeightLogEntry | null
): string {
  if (initialEntry && initialEntry.date === targetDate) {
    return initialEntry.recordedAt;
  }

  const now = new Date(nowMs);
  if (targetDate === getTodayIsoDate(now)) {
    return now.toISOString();
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDate);
  if (!match) {
    return now.toISOString();
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return new Date(year, month - 1, day, 12, 0, 0, 0).toISOString();
}

function formatWeightForUnit(weightKg: number, unit: 'kg' | 'lb'): string {
  if (unit === 'lb') {
    return String(Number((weightKg * KG_TO_LB).toFixed(2)));
  }
  return String(Number(weightKg.toFixed(2)));
}

interface WeighInContentProps {
  initialEntry?: WeightLogEntry | null;
  defaultDate?: string;
  onClose: () => void;
  onSaved?: (entry: WeightLogEntry) => void;
}

function WeighInContent({
  initialEntry,
  defaultDate,
  onClose,
  onSaved,
}: WeighInContentProps) {
  const storeDate = useLoggerStore((s) => s.activeDate);
  const showUndoToast = useLoggerStore((s) => s.showUndoToast);

  const effectiveDefaultDate =
    initialEntry?.date ?? defaultDate ?? storeDate ?? getTodayIsoDate();

  const [unit, setUnit] = useState<'kg' | 'lb'>('kg');
  const [weightStr, setWeightStr] = useState<string>(() =>
    initialEntry ? formatWeightForUnit(initialEntry.weightKg, 'kg') : ''
  );
  const [date, setDate] = useState<string>(effectiveDefaultDate);
  const [bodyFatStr, setBodyFatStr] = useState<string>('');
  const [note, setNote] = useState<string>(initialEntry?.note ?? '');
  const [hasUserEditedWeight, setHasUserEditedWeight] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(sheetRef, true);

  // Initialize preferred weightUnit from active userGoals (and prefill latest weight if creating new)
  useEffect(() => {
    let cancelled = false;

    async function loadDefaults() {
      try {
        const [goals, allWeights] = await Promise.all([
          db.userGoals.get('active'),
          db.weightLogs.toArray(),
        ]);
        if (cancelled) return;

        const preferredUnit: 'kg' | 'lb' = goals?.weightUnit === 'lb' ? 'lb' : 'kg';

        if (preferredUnit !== 'kg' && !hasUserEditedWeight) {
          setUnit(preferredUnit);
          if (initialEntry) {
            setWeightStr(formatWeightForUnit(initialEntry.weightKg, preferredUnit));
          }
        }

        if (!initialEntry && !hasUserEditedWeight && weightStr === '') {
          const sorted = [...allWeights].sort((a, b) => {
            if (a.date !== b.date) return b.date.localeCompare(a.date);
            if (a.recordedAt !== b.recordedAt) {
              return b.recordedAt.localeCompare(a.recordedAt);
            }
            return b.createdAt - a.createdAt;
          });
          const latest = sorted[0];
          if (latest) {
            setWeightStr(formatWeightForUnit(latest.weightKg, preferredUnit));
          } else if (goals?.profile?.weightKg) {
            setWeightStr(
              formatWeightForUnit(goals.profile.weightKg, preferredUnit)
            );
          }
        }
      } catch {
        // Ignore IndexedDB read errors in restricted environments
      }
    }

    void loadDefaults();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEntry]);

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

  const handleUnitToggle = (nextUnit: 'kg' | 'lb') => {
    if (nextUnit === unit) return;
    triggerHaptic(6);
    const parsed = parseFloat(weightStr);
    if (Number.isFinite(parsed) && parsed > 0) {
      const converted =
        nextUnit === 'lb'
          ? Number((parsed * KG_TO_LB).toFixed(2))
          : Number((parsed / KG_TO_LB).toFixed(2));
      setWeightStr(String(converted));
    }
    setUnit(nextUnit);
  };

  const handleStep = (delta: number) => {
    triggerHaptic(6);
    setHasUserEditedWeight(true);
    const current = parseFloat(weightStr);
    const base = Number.isFinite(current) && current > 0 ? current : unit === 'lb' ? 154 : 70;
    const next = Math.max(0.1, Number((base + delta).toFixed(2)));
    setWeightStr(String(next));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;

    const rawWeight = parseFloat(weightStr);
    if (!Number.isFinite(rawWeight) || rawWeight <= 0) {
      setErrorMessage('Enter a valid body weight greater than 0.');
      return;
    }

    const weightKg =
      unit === 'lb'
        ? Math.round((rawWeight / KG_TO_LB) * 100) / 100
        : Math.round(rawWeight * 100) / 100;

    if (weightKg > 500) {
      setErrorMessage(
        unit === 'lb'
          ? 'Enter a realistic body weight under 1,100 lb.'
          : 'Enter a realistic body weight under 500 kg.'
      );
      return;
    }

    const trimmedBf = bodyFatStr.trim();
    const parsedBf = parseFloat(trimmedBf);
    if (
      trimmedBf !== '' &&
      (!Number.isFinite(parsedBf) || parsedBf <= 0 || parsedBf >= 100)
    ) {
      setErrorMessage('Body fat % must be between 0.1 and 99.9.');
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);

    try {
      const hasValidBf =
        trimmedBf !== '' &&
        Number.isFinite(parsedBf) &&
        parsedBf > 0 &&
        parsedBf < 100;

      let combinedNote = note.trim();
      if (hasValidBf) {
        const bfTag = `BF: ${Number(parsedBf.toFixed(1))}%`;
        combinedNote = combinedNote ? `${combinedNote} (${bfTag})` : bfTag;
      }

      const nowMs = Date.now();
      const targetDate = date.trim() || getTodayIsoDate(new Date(nowMs));
      const recordedAt = buildRecordedAtForDate(targetDate, nowMs, initialEntry);

      const previousSnapshot = initialEntry ? { ...initialEntry } : null;

      const entry: WeightLogEntry = {
        id: initialEntry?.id ?? `w_${generateId()}`,
        date: targetDate,
        weightKg,
        ...(combinedNote ? { note: combinedNote } : {}),
        source: initialEntry?.source ?? 'manual',
        recordedAt,
        createdAt: initialEntry?.createdAt ?? nowMs,
        updatedAt: nowMs,
      };

      await db.weightLogs.put(entry);

      const displayLabel =
        unit === 'lb'
          ? `${Number((weightKg * KG_TO_LB).toFixed(2))} lb`
          : `${Number(weightKg.toFixed(2))} kg`;

      showUndoToast({
        message: previousSnapshot
          ? `Updated weigh-in (${displayLabel})`
          : `Logged weigh-in (${displayLabel})`,
        onUndo: async () => {
          if (previousSnapshot) {
            await db.weightLogs.put(previousSnapshot);
          } else {
            await db.weightLogs.delete(entry.id);
          }
        },
      });

      triggerHaptic(10);
      onSaved?.(entry);
      onClose();
    } catch (err: unknown) {
      console.error('Failed to save weigh-in:', err);
      setErrorMessage('Unable to save weigh-in entry. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const parsedPreview = parseFloat(weightStr);
  const convertedPreview =
    Number.isFinite(parsedPreview) && parsedPreview > 0
      ? unit === 'lb'
        ? `${Number((parsedPreview / KG_TO_LB).toFixed(2))} kg`
        : `${Number((parsedPreview * KG_TO_LB).toFixed(2))} lb`
      : null;

  const isTest = isTestEnvironment();

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={initialEntry ? 'Edit Weigh-In' : 'Log Weigh-In'}
      data-testid="weigh-in-drawer"
      initial={isTest ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={isTest ? undefined : { opacity: 0 }}
      transition={{ duration: 0.24, ease: EASE_EXPRESSIVE }}
      className="modal-viewport-overlay z-50 flex flex-col justify-end sm:items-center sm:justify-center sm:p-6 bg-black/70 backdrop-blur-md"
      onClick={onClose}
    >
      <motion.div
        ref={sheetRef}
        initial={isTest ? false : { opacity: 0, y: 48, scale: 0.94 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={isTest ? undefined : { opacity: 0, y: 36, scale: 0.95 }}
        transition={SPRING_SHEET}
        className="w-full max-w-lg mx-auto surface-elevated-sheet rounded-t-3xl sm:rounded-3xl px-4 sm:px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-5 max-h-[90dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="w-9 h-1 rounded-full bg-border mx-auto mb-3 shrink-0 sm:hidden"
          aria-hidden="true"
        />

        {/* Header */}
        <div className="shrink-0 flex items-center justify-between pb-3 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[var(--macro-fiber)]/15 flex items-center justify-center text-[var(--macro-fiber)]">
              <Scale className="w-4 h-4" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                {initialEntry ? 'Edit Weigh-In' : 'Log Weigh-In'}
              </h2>
              <p className="text-[11px] text-muted-foreground">
                Scale telemetry &amp; EMA trend calibration
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close weigh-in drawer"
            className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Form Body */}
        <form
          onSubmit={handleSubmit}
          className="pt-4 space-y-4 flex-1 min-h-0 overflow-y-auto overscroll-contain"
        >
          {/* Weight + Unit Toggle + Quick Steppers */}
          <div className="bg-surface-sub border border-border rounded-2xl p-3.5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="weigh-in-weight-input"
                className="text-xs font-semibold text-foreground"
              >
                Body Weight ({unit})
              </label>

              {/* Segmented kg / lb toggle */}
              <div
                role="group"
                aria-label="Unit selector"
                className="inline-flex items-center p-0.5 rounded-full bg-card border border-border"
              >
                <button
                  type="button"
                  onClick={() => handleUnitToggle('kg')}
                  aria-pressed={unit === 'kg'}
                  className={`tactile-press px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                    unit === 'kg'
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  kg
                </button>
                <button
                  type="button"
                  onClick={() => handleUnitToggle('lb')}
                  aria-pressed={unit === 'lb'}
                  className={`tactile-press px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                    unit === 'lb'
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  lb
                </button>
              </div>
            </div>

            <div className="relative flex items-center">
              <input
                id="weigh-in-weight-input"
                aria-label="Weight"
                type="number"
                step="0.01"
                inputMode="decimal"
                autoFocus
                value={weightStr}
                onChange={(e) => {
                  setHasUserEditedWeight(true);
                  setWeightStr(e.target.value);
                }}
                placeholder={unit === 'lb' ? '165.0' : '75.0'}
                className="w-full px-3.5 py-2.5 text-xl font-bold tabular-nums rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
              />
              {convertedPreview && (
                <span className="absolute right-3.5 text-xs font-medium tabular-nums text-muted-foreground pointer-events-none">
                  &asymp; {convertedPreview}
                </span>
              )}
            </div>

            {/* Quick Stepper Buttons */}
            <div className="grid grid-cols-4 gap-2">
              {([-0.5, -0.1, 0.1, 0.5] as const).map((delta) => {
                const label = delta > 0 ? `+${delta}` : String(delta);
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => handleStep(delta)}
                    className="tactile-press py-1.5 px-2 rounded-xl bg-card border border-border hover:border-border-focus text-xs font-semibold tabular-nums text-foreground"
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Date & Optional Body Fat % */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="weigh-in-date-input"
                className="block text-[11px] font-medium text-muted-foreground mb-1"
              >
                Date
              </label>
              <input
                id="weigh-in-date-input"
                aria-label="Date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2 text-base sm:text-sm tabular-nums rounded-xl bg-surface-sub border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
              />
            </div>

            <div>
              <label
                htmlFor="weigh-in-bf-input"
                className="block text-[11px] font-medium text-muted-foreground mb-1"
              >
                Body Fat % (Optional)
              </label>
              <input
                id="weigh-in-bf-input"
                aria-label="Body Fat % (Optional)"
                type="number"
                step="0.1"
                inputMode="decimal"
                value={bodyFatStr}
                onChange={(e) => setBodyFatStr(e.target.value)}
                placeholder="e.g. 15.0"
                className="w-full px-3 py-2 text-base sm:text-sm tabular-nums rounded-xl bg-surface-sub border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground placeholder:text-muted-foreground/50"
              />
            </div>
          </div>

          {/* Optional Note */}
          <div>
            <label
              htmlFor="weigh-in-note-input"
              className="block text-[11px] font-medium text-muted-foreground mb-1"
            >
              Note (Optional)
            </label>
            <input
              id="weigh-in-note-input"
              aria-label="Note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Fasted morning weigh-in, post-travel"
              className="w-full px-3 py-2 text-base sm:text-sm rounded-xl bg-surface-sub border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground placeholder:text-muted-foreground/50"
            />
          </div>

          {/* Neutral Validation Alert */}
          {errorMessage && (
            <div
              role="alert"
              className="p-2.5 rounded-xl bg-surface-sub border border-border text-[var(--neutral-over)] text-xs flex items-center gap-2"
            >
              <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Save Button */}
          <button
            type="submit"
            disabled={isSaving}
            className="tactile-press w-full py-2.5 px-4 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-xs"
          >
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{initialEntry ? 'Update Weigh-In' : 'Save Weigh-In'}</span>
          </button>
        </form>
      </motion.div>
    </motion.div>
  );
}

export function WeighInDrawer({
  open,
  initialEntry,
  defaultDate,
  onClose,
  onSaved,
}: WeighInDrawerProps) {
  const instanceKey = `${initialEntry?.id ?? 'new'}-${defaultDate ?? ''}`;
  return (
    <AnimatePresence>
      {open && (
        <WeighInContent
          key={instanceKey}
          initialEntry={initialEntry}
          defaultDate={defaultDate}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </AnimatePresence>
  );
}
