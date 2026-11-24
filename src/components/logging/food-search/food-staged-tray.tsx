"use client";

import React from 'react';
import { X } from 'lucide-react';
import type { FoodLogEntry } from '@/types/nutrition';

export interface FoodStagedTrayProps {
  stagedEntries: FoodLogEntry[];
  totalStagedCalories: number;
  isLogging: boolean;
  onRemoveItem: (id: string) => void;
  onClearAll: () => void;
  onLogAll: () => void;
}

export const FoodStagedTray = React.memo(function FoodStagedTray({
  stagedEntries,
  totalStagedCalories,
  isLogging,
  onRemoveItem,
  onClearAll,
  onLogAll,
}: FoodStagedTrayProps) {
  if (stagedEntries.length === 0) return null;

  return (
    <div
      data-testid="multi-add-tray"
      className="mt-3 pt-2.5 border-t border-border flex flex-col gap-2 shrink-0"
    >
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
        {stagedEntries.map((item) => (
          <span
            key={item.id}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-sub border border-border text-[11px] text-foreground shrink-0 tabular-nums"
          >
            <span className="max-w-[120px] truncate font-medium">
              {item.name}
            </span>
            <span className="text-muted-foreground">
              ({item.amount}
              {item.unit === 'g' || item.unit === 'ml'
                ? item.unit
                : ` ${item.unit}`}
              )
            </span>
            <button
              type="button"
              onClick={() => onRemoveItem(item.id)}
              aria-label={`Remove staged ${item.name}`}
              className="text-muted-foreground hover:text-foreground ml-0.5"
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 bg-surface-sub border border-border rounded-2xl px-3 py-2">
        <div className="text-xs font-semibold text-foreground tabular-nums">
          {stagedEntries.length}{' '}
          {stagedEntries.length === 1 ? 'item' : 'items'} &middot;{' '}
          <span className="text-[var(--macro-calories)]">
            {totalStagedCalories} kcal
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClearAll}
            aria-label="Clear staged items"
            className="tactile-press px-2.5 py-1 rounded-full text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onLogAll}
            disabled={isLogging}
            className="tactile-press px-3.5 py-1.5 rounded-full bg-foreground text-background text-xs font-semibold hover:opacity-90 disabled:opacity-50"
          >
            Log All
          </button>
        </div>
      </div>
    </div>
  );
});
