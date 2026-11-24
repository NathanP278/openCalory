"use client";

import React from 'react';
import { ChefHat, Globe, Pin, Plus } from 'lucide-react';
import type { SearchableEntry } from '@/lib/foods/search-history';
import {
  formatFoodBasisLabel,
  formatRecipeBasisLabel,
  getFoodSourceBadge,
} from './food-search-utils';

export interface FoodSearchRowProps {
  entry: SearchableEntry;
  index: number;
  isHighlighted: boolean;
  isPinned: boolean;
  animateEntry: boolean;
  onSelect: (entry: SearchableEntry) => void;
  onTogglePin: (e: React.MouseEvent, entry: SearchableEntry) => void;
  onQuickLog: (e: React.MouseEvent, entry: SearchableEntry) => void;
}

export const FoodSearchRow = React.memo(function FoodSearchRow({
  entry,
  index,
  isHighlighted,
  isPinned,
  animateEntry,
  onSelect,
  onTogglePin,
  onQuickLog,
}: FoodSearchRowProps) {
  const isRecipe = entry.kind === 'recipe';
  const itemName = isRecipe ? entry.recipe.name : entry.food.name;
  const itemBrand = isRecipe ? undefined : entry.food.brand;
  const itemRegion = isRecipe ? undefined : entry.food.region;
  const badge = isRecipe ? null : getFoodSourceBadge(entry.food);
  const nutrients = isRecipe
    ? entry.recipe.nutrientsPerBasis
    : entry.food.nutrientsPerBasis;
  const basisLabel = isRecipe
    ? formatRecipeBasisLabel(entry.recipe)
    : formatFoodBasisLabel(entry.food);

  return (
    <div
      data-highlighted={isHighlighted ? 'true' : undefined}
      style={
        animateEntry
          ? { animationDelay: `${Math.min(index, 8) * 25}ms` }
          : undefined
      }
      onClick={() => onSelect(entry)}
      className={`food-search-row tactile-press ${
        animateEntry ? 'stagger-item ' : ''
      }w-full text-left p-3 rounded-xl border group flex items-center justify-between gap-2.5 cursor-pointer ${
        isHighlighted
          ? 'bg-accent border-border-focus'
          : 'bg-surface-sub hover:bg-accent border-border hover:border-border-focus'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-semibold text-foreground line-clamp-1 group-hover:text-foreground">
            {itemName}
          </span>
          {itemRegion === 'PH' && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-md font-semibold bg-emerald-500/15 text-emerald-500 shrink-0">
              PH
            </span>
          )}
          {isRecipe ? (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-md font-semibold bg-[var(--macro-fiber)]/15 text-[var(--macro-fiber)] shrink-0 inline-flex items-center gap-1">
              <ChefHat className="w-2.5 h-2.5" aria-hidden="true" />
              RECIPE
            </span>
          ) : badge ? (
            <span
              className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-md font-medium shrink-0 inline-flex items-center gap-1 ${badge.toneClass}`}
            >
              {badge.showGlobe && (
                <Globe className="w-2.5 h-2.5" aria-hidden="true" />
              )}
              {badge.label}
            </span>
          ) : null}
          {entry.lastAmount !== undefined && entry.lastUnit && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-card border border-border text-muted-foreground tabular-nums">
              Last: {entry.lastAmount} {entry.lastUnit}
            </span>
          )}
        </div>
        {itemBrand && (
          <p className="text-[10px] text-muted-foreground truncate mt-0.5">
            {itemBrand}
          </p>
        )}
        <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-1 text-[11px] text-muted-foreground tabular-nums">
          <span className="text-[var(--macro-calories)] font-semibold">
            {nutrients.calories} kcal
          </span>
          <span>&bull;</span>
          <span className="text-[var(--macro-protein)]">
            P: {nutrients.protein}g
          </span>
          <span className="text-[var(--macro-carbs)]">
            C: {nutrients.carbs}g
          </span>
          <span className="text-[var(--macro-fat)]">
            F: {nutrients.fat}g
          </span>
          <span className="text-[10px] text-muted-foreground/70">
            {basisLabel}
          </span>
        </div>
      </div>

      {/* Per-Row Pin & 1-Tap Quick-Log Actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={(e) => onTogglePin(e, entry)}
          aria-label={isPinned ? `Unpin ${itemName}` : `Pin ${itemName}`}
          aria-pressed={isPinned}
          className={`touch-target p-1.5 rounded-full border transition-colors ${
            isPinned
              ? 'bg-foreground text-background border-foreground'
              : 'bg-card text-muted-foreground border-border hover:text-foreground'
          }`}
        >
          <Pin className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={(e) => onQuickLog(e, entry)}
          aria-label={`Quick log ${itemName}`}
          className="touch-target p-1.5 rounded-full bg-card border border-border text-muted-foreground hover:bg-foreground hover:text-background hover:border-foreground transition-colors"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
});
