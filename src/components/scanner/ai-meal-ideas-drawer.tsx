"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Sparkles,
  X,
  Loader2,
  Clock,
  AlertTriangle,
  ArrowRight,
  UtensilsCrossed,
} from 'lucide-react';
import { db, generateId } from '@/lib/db/opencalory-db';
import { useLoggerStore, formatHumanDate, type AiDraftItem } from '@/stores/logger-store';
import { DEFAULT_RDA_MICROS, resolveGoalsForDate } from '@/lib/nutrition/goals';
import { aggregateDailySummary } from '@/lib/nutrition/daily-summary';
import { scaleNutrition } from '@/lib/nutrition/scaling';
import { SyncUnlockCard } from '@/components/auth/sync-unlock-modal';
import { triggerHaptic } from '@/lib/motion';
import type { AiMealIdea } from '@/lib/ai/schemas';
import type { UserGoals } from '@/types/nutrition';

const PREFERENCE_SUGGESTION_CHIPS = [
  'High protein, 10 min prep, use eggs and rice',
  'Filipino-friendly lutong bahay',
  'Quick no-cook / minimal prep',
  'High volume & fiber, low fat',
] as const;

export interface AiMealIdeasDrawerProps {
  open: boolean;
  date: string;
  onClose: () => void;
}

function computeIdeaTotals(idea: AiMealIdea) {
  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  let fiber = 0;

  for (const item of idea.items) {
    const { macros } = scaleNutrition(
      item.per100g,
      item.microsPer100g ?? {},
      'per100g',
      item.grams
    );
    calories += macros.calories;
    protein += macros.protein;
    carbs += macros.carbs;
    fat += macros.fat;
    fiber += macros.fiber;
  }

  return {
    calories: Math.round(calories),
    protein: Math.round(protein * 10) / 10,
    carbs: Math.round(carbs * 10) / 10,
    fat: Math.round(fat * 10) / 10,
    fiber: Math.round(fiber * 10) / 10,
  };
}

export function AiMealIdeasDrawer({ open, date, onClose }: AiMealIdeasDrawerProps) {
  const storeDate = useLoggerStore((s) => s.activeDate);
  const syncAuthLocked = useLoggerStore((s) => s.syncAuthLocked);
  const effectiveDate = date || storeDate;

  const [preferencePrompt, setPreferencePrompt] = useState('');
  const [ideas, setIdeas] = useState<AiMealIdea[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fallbackGoals: UserGoals = useMemo(
    () => ({
      id: 'active',
      dailyCalories: 2000,
      proteinG: 150,
      carbsG: 200,
      fatG: 65,
      fiberG: 30,
      micronutrientTargets: { ...DEFAULT_RDA_MICROS },
      mealSlots: [],
      updatedAt: 0,
    }),
    []
  );

  const logs = useLiveQuery(
    () => db.foodLogs.where('date').equals(effectiveDate).toArray(),
    [effectiveDate]
  );
  const userGoals = useLiveQuery(() => db.userGoals.get('active'), []);

  const resolvedGoals = useMemo(
    () => resolveGoalsForDate(userGoals ?? fallbackGoals, effectiveDate),
    [userGoals, fallbackGoals, effectiveDate]
  );

  const dailySummary = useMemo(
    () => aggregateDailySummary(logs ?? [], resolvedGoals),
    [logs, resolvedGoals]
  );

  // Escape key to close drawer
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleGenerateIdeas = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isGenerating) return;

    triggerHaptic(8);
    setIsGenerating(true);
    setErrorMsg(null);

    try {
      // Ensure live Dexie data is used even if clicked immediately after mount before useLiveQuery settles
      let summaryToUse = dailySummary;
      if (logs === undefined || userGoals === undefined) {
        const [freshLogs, freshGoals] = await Promise.all([
          db.foodLogs.where('date').equals(effectiveDate).toArray(),
          db.userGoals.get('active'),
        ]);
        const effectiveGoals = resolveGoalsForDate(
          freshGoals ?? fallbackGoals,
          effectiveDate
        );
        summaryToUse = aggregateDailySummary(freshLogs, effectiveGoals);
      }

      const remainingPayload = {
        calories: summaryToUse.calories.remaining,
        protein: summaryToUse.protein.remaining,
        carbs: summaryToUse.carbs.remaining,
        fat: summaryToUse.fat.remaining,
        fiber: summaryToUse.fiber.remaining,
      };

      const res = await fetch('/api/ai/meal-ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remaining: remainingPayload,
          preferencePrompt: preferencePrompt.trim() || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 401) {
        useLoggerStore.getState().setSyncAuthLocked(true);
        throw new Error(
          data.error ||
            'Sync & AI locked. Enter your passphrase below to unlock and retry.'
        );
      }

      if (!res.ok) {
        throw new Error(
          data.error || `Failed to generate meal ideas (status ${res.status})`
        );
      }

      if (!Array.isArray(data.ideas) || data.ideas.length === 0) {
        throw new Error('No meal ideas returned. Please try again.');
      }

      setIdeas(data.ideas as AiMealIdea[]);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to generate meal ideas';
      setErrorMsg(msg);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleReviewAndLog = (idea: AiMealIdea) => {
    triggerHaptic(10);
    const mappedDraftItems: AiDraftItem[] = idea.items.map((it) => ({
      id: generateId(),
      name: it.name || 'Ingredient',
      grams: typeof it.grams === 'number' && it.grams > 0 ? it.grams : 100,
      per100g: {
        calories: it.per100g?.calories ?? 0,
        protein: it.per100g?.protein ?? 0,
        carbs: it.per100g?.carbs ?? 0,
        fat: it.per100g?.fat ?? 0,
        fiber: it.per100g?.fiber ?? 0,
      },
      microsPer100g: it.microsPer100g ? { ...it.microsPer100g } : {},
      verifiedSource: null,
    }));

    const store = useLoggerStore.getState();
    store.setAiDraft({
      imageDataUrl: null,
      contextPrompt: idea.title,
      items: mappedDraftItems,
    });
    store.openSheet('ai-scan');
  };

  const { calories, protein, carbs, fat, fiber } = dailySummary;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="AI Meal Ideas"
      data-testid="ai-meal-ideas-drawer"
      className="modal-viewport-overlay z-50 flex flex-col justify-end sm:items-center sm:justify-center sm:p-6 bg-black/70 backdrop-blur-xs animate-backdrop-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg mx-auto surface-elevated-sheet rounded-t-3xl sm:rounded-3xl px-4 sm:px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-5 animate-sheet-in sm:animate-modal-in max-h-[92dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="w-9 h-1 rounded-full bg-border mx-auto mb-3 shrink-0 sm:hidden"
          aria-hidden="true"
        />

        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[var(--macro-calories)]/15 flex items-center justify-center text-[var(--macro-calories)]">
              <Sparkles className="w-4 h-4" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                AI Meal Ideas
              </h2>
              <p className="text-[11px] text-muted-foreground">
                Fill remaining macros for {formatHumanDate(effectiveDate)}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close AI meal ideas"
            className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="pt-3.5 flex-1 overflow-y-auto overscroll-contain space-y-4 pr-0.5">
          {/* Remaining Macros Banner */}
          <div
            data-testid="meal-ideas-remaining-banner"
            className="bg-surface-sub rounded-2xl p-3 border border-border space-y-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Remaining Budget
              </span>
              {calories.overTarget ? (
                <span className="text-[11px] font-medium text-[var(--neutral-over)] tabular-nums">
                  +{calories.delta} kcal surplus
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {calories.consumed} / {calories.target} kcal logged
                </span>
              )}
            </div>

            <div className="grid grid-cols-5 gap-2 text-center tabular-nums">
              <div className="bg-card rounded-xl p-2 border border-border/60">
                <span
                  data-testid="meal-ideas-remaining-calories"
                  className="block text-sm font-bold text-[var(--macro-calories)]"
                >
                  {calories.remaining}
                </span>
                <span className="text-[10px] text-muted-foreground uppercase">
                  kcal
                </span>
              </div>

              <div className="bg-card rounded-xl p-2 border border-border/60">
                <span
                  data-testid="meal-ideas-remaining-protein"
                  className="block text-sm font-bold text-[var(--macro-protein)]"
                >
                  {protein.remaining}g
                </span>
                <span className="text-[10px] text-muted-foreground uppercase">
                  Prot
                </span>
              </div>

              <div className="bg-card rounded-xl p-2 border border-border/60">
                <span
                  data-testid="meal-ideas-remaining-carbs"
                  className="block text-sm font-bold text-[var(--macro-carbs)]"
                >
                  {carbs.remaining}g
                </span>
                <span className="text-[10px] text-muted-foreground uppercase">
                  Carb
                </span>
              </div>

              <div className="bg-card rounded-xl p-2 border border-border/60">
                <span
                  data-testid="meal-ideas-remaining-fat"
                  className="block text-sm font-bold text-[var(--macro-fat)]"
                >
                  {fat.remaining}g
                </span>
                <span className="text-[10px] text-muted-foreground uppercase">
                  Fat
                </span>
              </div>

              <div className="bg-card rounded-xl p-2 border border-border/60">
                <span
                  data-testid="meal-ideas-remaining-fiber"
                  className="block text-sm font-bold text-[var(--macro-fiber)]"
                >
                  {fiber.remaining}g
                </span>
                <span className="text-[10px] text-muted-foreground uppercase">
                  Fib
                </span>
              </div>
            </div>
          </div>

          {/* Preference & Pantry Input Form */}
          <form onSubmit={handleGenerateIdeas} className="space-y-2.5">
            <div className="space-y-1.5">
              <label
                htmlFor="meal-ideas-preference"
                className="text-xs font-semibold text-foreground flex items-center justify-between"
              >
                <span>Preferences or pantry ingredients</span>
                <span className="text-[10px] font-medium text-muted-foreground">
                  Optional
                </span>
              </label>
              <input
                id="meal-ideas-preference"
                type="text"
                value={preferencePrompt}
                onChange={(e) => setPreferencePrompt(e.target.value)}
                placeholder="High protein, 10 min prep, use eggs and rice"
                disabled={isGenerating}
                className="w-full px-3 py-2.5 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:outline-none focus:border-border-focus text-foreground placeholder:text-muted-foreground/60"
              />
            </div>

            {/* Quick Suggestion Chips */}
            <div className="flex flex-wrap gap-1.5">
              {PREFERENCE_SUGGESTION_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => setPreferencePrompt(chip)}
                  className="tactile-press text-left px-2.5 py-1 rounded-full bg-surface-sub border border-border/60 text-[11px] text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
                >
                  {chip}
                </button>
              ))}
            </div>

            <button
              type="submit"
              disabled={isGenerating}
              className="tactile-press w-full py-3 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 shadow-xs"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>Generating meal ideas...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" aria-hidden="true" />
                  <span>Generate Meal Ideas</span>
                </>
              )}
            </button>
          </form>

          {/* 401 Inline Unlock Card */}
          {syncAuthLocked && (
            <SyncUnlockCard
              compact
              onUnlocked={() => {
                setErrorMsg(null);
              }}
            />
          )}

          {/* Error Notice */}
          {errorMsg && !syncAuthLocked && (
            <div className="p-3 rounded-xl bg-surface-sub border border-border text-[var(--neutral-over)] text-xs flex items-start gap-2">
              <AlertTriangle
                className="w-4 h-4 shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <div className="flex-1 space-y-1">
                <p>{errorMsg}</p>
                <p className="text-[11px] text-muted-foreground">
                  Check your AI configuration in Settings or try again with a different preference prompt.
                </p>
              </div>
            </div>
          )}

          {/* Generated Meal Ideas Cards */}
          {ideas.length > 0 && (
            <div className="space-y-3 pt-1" data-testid="meal-ideas-list">
              {ideas.map((idea, index) => {
                const totals = computeIdeaTotals(idea);
                return (
                  <div
                    key={`${idea.title}-${index}`}
                    data-testid={`meal-idea-card-${index}`}
                    className="bg-card rounded-2xl p-3.5 border border-border space-y-3"
                  >
                    <div className="flex items-start justify-between gap-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-xs font-bold text-foreground">
                            {idea.title}
                          </h3>
                          {typeof idea.prepMinutes === 'number' && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-sub border border-border/60 text-[10px] font-medium text-muted-foreground tabular-nums">
                              <Clock className="w-2.5 h-2.5" aria-hidden="true" />
                              {idea.prepMinutes} min
                            </span>
                          )}
                        </div>
                        {idea.summary && (
                          <p className="text-[11px] text-muted-foreground mt-1">
                            {idea.summary}
                          </p>
                        )}
                      </div>

                      <div className="text-right shrink-0 tabular-nums">
                        <span className="text-base font-bold text-[var(--macro-calories)]">
                          {totals.calories}
                        </span>
                        <span className="text-[10px] font-semibold text-muted-foreground ml-0.5">
                          kcal
                        </span>
                      </div>
                    </div>

                    {/* Macro totals strip */}
                    <div className="grid grid-cols-4 gap-2 py-2 px-2.5 rounded-xl bg-surface-sub border border-border/50 text-center text-[11px] tabular-nums">
                      <div>
                        <span className="font-bold text-[var(--macro-protein)]">
                          {totals.protein}g
                        </span>
                        <span className="text-[10px] text-muted-foreground ml-1 uppercase">
                          P
                        </span>
                      </div>
                      <div>
                        <span className="font-bold text-[var(--macro-carbs)]">
                          {totals.carbs}g
                        </span>
                        <span className="text-[10px] text-muted-foreground ml-1 uppercase">
                          C
                        </span>
                      </div>
                      <div>
                        <span className="font-bold text-[var(--macro-fat)]">
                          {totals.fat}g
                        </span>
                        <span className="text-[10px] text-muted-foreground ml-1 uppercase">
                          F
                        </span>
                      </div>
                      <div>
                        <span className="font-bold text-[var(--macro-fiber)]">
                          {totals.fiber}g
                        </span>
                        <span className="text-[10px] text-muted-foreground ml-1 uppercase">
                          Fib
                        </span>
                      </div>
                    </div>

                    {/* Ingredient breakdown pills */}
                    <div className="flex flex-wrap gap-1.5">
                      {idea.items.map((item, itemIdx) => (
                        <span
                          key={`${item.name}-${itemIdx}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-sub border border-border/60 text-[11px] text-foreground/90 tabular-nums"
                        >
                          <UtensilsCrossed
                            className="w-2.5 h-2.5 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <span>{item.name}</span>
                          <span className="text-muted-foreground">
                            Â· {Math.round(item.grams)}g
                          </span>
                        </span>
                      ))}
                    </div>

                    {/* Action: Hand off to Stage 3 HITL Review */}
                    <button
                      type="button"
                      onClick={() => handleReviewAndLog(idea)}
                      className="tactile-press w-full py-2.5 px-3.5 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 flex items-center justify-center gap-1.5 shadow-xs"
                    >
                      <span>Review &amp; Log</span>
                      <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
