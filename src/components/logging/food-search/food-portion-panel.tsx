"use client";

import React from 'react';
import { Check, Layers, Loader2 } from 'lucide-react';
import { formatPortionUnit, type ScaledNutrition } from '@/lib/nutrition/scaling';
import type { FoodItem, FoodServingOption } from '@/types/nutrition';

export interface FoodPortionPanelProps {
  selectedFood: FoodItem;
  servingOptions: FoodServingOption[];
  activeServingOption: FoodServingOption | undefined;
  amount: string;
  unit: string;
  parsedAmount: number;
  scaledNutrition: ScaledNutrition | null;
  isLogging: boolean;
  onSelectServingOption: (opt: FoodServingOption) => void;
  onAmountChange: (val: string) => void;
  onUnitChange: (val: string) => void;
  onSelectPreset: (nextAmount: string, nextUnit: string) => void;
  onStageAndAddAnother: () => void;
  onLogFood: () => void;
}

const COUNTABLE_PRESETS = [0.5, 1, 1.5, 2, 3];
const METRIC_PRESETS = [50, 100, 150, 200, 250];

export const FoodPortionPanel = React.memo(function FoodPortionPanel({
  selectedFood,
  servingOptions,
  activeServingOption,
  amount,
  unit,
  parsedAmount,
  scaledNutrition,
  isLogging,
  onSelectServingOption,
  onAmountChange,
  onUnitChange,
  onSelectPreset,
  onStageAndAddAnother,
  onLogFood,
}: FoodPortionPanelProps) {
  const metricUnit =
    activeServingOption?.unit === 'ml' || selectedFood.basis === 'per100ml'
      ? 'ml'
      : 'g';
  const isMetricMode =
    !activeServingOption ||
    activeServingOption.unit === 'g' ||
    activeServingOption.unit === 'ml';

  return (
    <div
      key={selectedFood.id}
      className="pt-4 flex-1 overflow-y-auto overscroll-contain space-y-4 animate-panel-switch"
    >
      <div className="bg-surface-sub border border-border rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-foreground">
            Portion Amount
          </span>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {activeServingOption && !isMetricMode
              ? `Basis: 1 ${activeServingOption.unit}${
                  activeServingOption.grams > 0
                    ? ` (${activeServingOption.grams}g)`
                    : ''
                }`
              : `Basis: ${selectedFood.servingSize || 100} ${
                  selectedFood.servingUnit || 'g'
                }`}
          </span>
        </div>

        {/* Serving Unit Selector Pills (ONLY when countable options apply) */}
        {servingOptions.length > 1 && (
          <div
            role="group"
            aria-label="Serving unit options"
            className="flex flex-wrap items-center gap-1.5"
          >
            {servingOptions.map((opt) => {
              const isActive = activeServingOption?.id === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onSelectServingOption(opt)}
                  aria-pressed={isActive}
                  className={`tactile-press px-2.5 py-1 text-[11px] font-semibold rounded-full border ${
                    isActive
                      ? 'bg-foreground text-background border-foreground shadow-xs'
                      : 'bg-card text-muted-foreground border-border hover:text-foreground'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2">
          <div className="flex-1">
            <input
              aria-label="Portion amount"
              type="number"
              step="any"
              min="0"
              value={amount}
              onChange={(e) => onAmountChange(e.target.value)}
              className="w-full px-3 py-2 text-base font-semibold tabular-nums rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground"
            />
          </div>
          <div className="w-24">
            <input
              aria-label="Portion unit"
              type="text"
              value={unit}
              onChange={(e) => onUnitChange(e.target.value)}
              className="w-full px-3 py-2 text-base sm:text-xs font-medium rounded-xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground text-center"
            />
          </div>
        </div>

        {/* Quick Portion Presets */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {isMetricMode
              ? METRIC_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => onSelectPreset(String(preset), metricUnit)}
                    className={`tactile-press px-2.5 py-1 text-[11px] font-semibold rounded-full ${
                      amount === String(preset) && unit === metricUnit
                        ? 'bg-foreground text-background shadow-xs'
                        : 'bg-card text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {preset}
                    {metricUnit}
                  </button>
                ))
              : COUNTABLE_PRESETS.map((preset) => {
                  const presetUnit = formatPortionUnit(
                    preset,
                    activeServingOption.unit
                  );
                  return (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => onSelectPreset(String(preset), presetUnit)}
                      className={`tactile-press px-2.5 py-1 text-[11px] font-semibold rounded-full ${
                        parsedAmount === preset
                          ? 'bg-foreground text-background shadow-xs'
                          : 'bg-card text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {preset} {presetUnit}
                    </button>
                  );
                })}
          </div>
          {!isMetricMode && scaledNutrition?.effectiveGrams !== undefined && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              &asymp; {scaledNutrition.effectiveGrams}g
            </span>
          )}
        </div>
      </div>

      {/* Scaled Macro Summary */}
      {scaledNutrition && (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-semibold text-foreground">
              Scaled Nutrition
            </span>
            <span className="text-xs font-bold text-[var(--macro-calories)] tabular-nums">
              {scaledNutrition.macros.calories} kcal
            </span>
          </div>
          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="bg-surface-sub border border-border rounded-xl p-2">
              <span className="text-[10px] text-[var(--macro-protein)] font-semibold block">
                Protein
              </span>
              <span className="text-xs font-semibold tabular-nums text-foreground">
                {scaledNutrition.macros.protein}g
              </span>
            </div>
            <div className="bg-surface-sub border border-border rounded-xl p-2">
              <span className="text-[10px] text-[var(--macro-carbs)] font-semibold block">
                Carbs
              </span>
              <span className="text-xs font-semibold tabular-nums text-foreground">
                {scaledNutrition.macros.carbs}g
              </span>
            </div>
            <div className="bg-surface-sub border border-border rounded-xl p-2">
              <span className="text-[10px] text-[var(--macro-fat)] font-semibold block">
                Fat
              </span>
              <span className="text-xs font-semibold tabular-nums text-foreground">
                {scaledNutrition.macros.fat}g
              </span>
            </div>
            <div className="bg-surface-sub border border-border rounded-xl p-2">
              <span className="text-[10px] text-[var(--macro-fiber)] font-semibold block">
                Fiber
              </span>
              <span className="text-xs font-semibold tabular-nums text-foreground">
                {scaledNutrition.macros.fiber}g
              </span>
            </div>
          </div>

          {/* Micronutrients Pill Row (if any available) */}
          {Object.keys(scaledNutrition.micros).length > 0 && (
            <div className="bg-surface-sub/50 border border-border rounded-xl p-2.5 text-[10px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
              {scaledNutrition.micros.potassiumMg !== undefined && (
                <span>
                  Potassium:{' '}
                  <strong className="text-foreground tabular-nums">
                    {scaledNutrition.micros.potassiumMg}mg
                  </strong>
                </span>
              )}
              {scaledNutrition.micros.sodiumMg !== undefined && (
                <span>
                  Sodium:{' '}
                  <strong className="text-foreground tabular-nums">
                    {scaledNutrition.micros.sodiumMg}mg
                  </strong>
                </span>
              )}
              {scaledNutrition.micros.calciumMg !== undefined && (
                <span>
                  Calcium:{' '}
                  <strong className="text-foreground tabular-nums">
                    {scaledNutrition.micros.calciumMg}mg
                  </strong>
                </span>
              )}
              {scaledNutrition.micros.ironMg !== undefined && (
                <span>
                  Iron:{' '}
                  <strong className="text-foreground tabular-nums">
                    {scaledNutrition.micros.ironMg}mg
                  </strong>
                </span>
              )}
              {scaledNutrition.micros.magnesiumMg !== undefined && (
                <span>
                  Magnesium:{' '}
                  <strong className="text-foreground tabular-nums">
                    {scaledNutrition.micros.magnesiumMg}mg
                  </strong>
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Confirm Log & Multi-Add Staging Buttons */}
      <div className="pt-2 flex flex-col sm:flex-row gap-2">
        <button
          type="button"
          onClick={onStageAndAddAnother}
          disabled={isLogging || parsedAmount <= 0}
          className="tactile-press flex-1 py-2.5 px-4 rounded-full bg-surface-sub border border-border text-foreground font-semibold text-xs hover:bg-accent disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          <Layers className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Stage &amp; Add Another</span>
        </button>
        <button
          type="button"
          onClick={onLogFood}
          disabled={isLogging || parsedAmount <= 0}
          className="tactile-press flex-1 py-2.5 px-4 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-xs"
        >
          {isLogging ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
          )}
          <span>Log Food</span>
        </button>
      </div>
    </div>
  );
});
