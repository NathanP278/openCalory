"use client";

import React, { useState, useRef, useEffect } from 'react';
import { X, Sparkles, Loader2, Save, AlertCircle } from 'lucide-react';
import { db, generateId } from '@/lib/db/opencalory-db';
import { compressImageToJpeg } from '@/lib/media/image-compress';
import { SyncUnlockCard } from '@/components/auth/sync-unlock-modal';
import { buildServingOptions } from '@/components/recipes/custom-food-modal';
import { useLoggerStore } from '@/stores/logger-store';
import { triggerHaptic } from '@/lib/motion';
import type { FoodItem, FoodLogEntry, NutritionBasis } from '@/types/nutrition';

export interface AddBarcodeProductModalProps {
  open: boolean;
  barcode: string;
  date?: string;
  mealSlot?: string;
  onClose: () => void;
  onSaved?: (item: FoodItem) => void;
}

const round2 = (val: number): number =>
  Math.round((val + Number.EPSILON) * 100) / 100;

export function AddBarcodeProductModal({
  open,
  barcode,
  date,
  mealSlot,
  onClose,
  onSaved,
}: AddBarcodeProductModalProps) {
  const storeDate = useLoggerStore((s) => s.activeDate);
  const storeMealSlot = useLoggerStore((s) => s.activeMealSlot);
  const syncAuthLocked = useLoggerStore((s) => s.syncAuthLocked);

  const effectiveDate = date ?? storeDate ?? '2026-11-14';
  const effectiveMealSlot = mealSlot ?? storeMealSlot ?? 'log';

  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [servingSize, setServingSize] = useState('100');
  const [servingUnit, setServingUnit] = useState<'g' | 'ml' | 'serving'>('g');
  const [servingWeightGrams, setServingWeightGrams] = useState('');
  const [calories, setCalories] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [fiber, setFiber] = useState('');
  const [sodiumMg, setSodiumMg] = useState('');

  const [isOcrLoading, setIsOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [servingError, setServingError] = useState<string | null>(null);
  const [touchedName, setTouchedName] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Keyboard Escape listener
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

  const handleOcrFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsOcrLoading(true);
    setOcrError(null);

    try {
      const imageDataUrl = await compressImageToJpeg(file, 1024, 0.8);
      const res = await fetch('/api/ai/label-ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl }),
      });

      if (res.status === 401) {
        useLoggerStore.getState().setSyncAuthLocked(true);
        setOcrError('Sync & AI locked. Unlock below to scan nutrition labels.');
        return;
      }

      if (!res.ok) {
        throw new Error(`OCR service failed with status ${res.status}`);
      }

      const data = await res.json();
      if (data.name) setName(data.name);
      if (data.brand) setBrand(data.brand);
      if (data.servingSize !== undefined)
        setServingSize(String(data.servingSize));
      if (
        data.servingUnit &&
        ['g', 'ml', 'serving'].includes(data.servingUnit)
      ) {
        setServingUnit(data.servingUnit as 'g' | 'ml' | 'serving');
      }
      if (data.servingWeightGrams !== undefined) {
        setServingWeightGrams(String(data.servingWeightGrams));
      }
      if (data.calories !== undefined) setCalories(String(data.calories));
      if (data.protein !== undefined) setProtein(String(data.protein));
      if (data.carbs !== undefined) setCarbs(String(data.carbs));
      if (data.fat !== undefined) setFat(String(data.fat));
      if (data.fiber !== undefined) setFiber(String(data.fiber));
      if (data.sodiumMg !== undefined) setSodiumMg(String(data.sodiumMg));
    } catch (err: unknown) {
      setOcrError(
        err instanceof Error ? err.message : 'Failed to scan nutrition label.'
      );
    } finally {
      setIsOcrLoading(false);
      if (e.target) e.target.value = '';
    }
  };

  const handleSaveAndLog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving || !name.trim()) return;

    setIsSaving(true);
    try {
      const cleanBarcode = barcode.trim();
      const rawServingSize = parseFloat(servingSize);
      if (!Number.isFinite(rawServingSize) || rawServingSize <= 0) {
        setServingError(
          'Serving size must be a positive number. Enter a value above 0 matching the package label.'
        );
        return;
      }
      setServingError(null);
      const parsedSize = rawServingSize;
      const parsedCal = Math.max(0, parseFloat(calories) || 0);
      const parsedP = Math.max(0, parseFloat(protein) || 0);
      const parsedC = Math.max(0, parseFloat(carbs) || 0);
      const parsedF = Math.max(0, parseFloat(fat) || 0);
      const parsedFib = Math.max(0, parseFloat(fiber) || 0);
      const parsedSod =
        sodiumMg.trim() !== ''
          ? Math.max(0, parseFloat(sodiumMg) || 0)
          : undefined;
      const rawWeight =
        servingWeightGrams.trim() !== ''
          ? parseFloat(servingWeightGrams)
          : undefined;
      const validWeight =
        rawWeight !== undefined && Number.isFinite(rawWeight) && rawWeight > 0
          ? round2(rawWeight)
          : undefined;

      let basis: NutritionBasis;
      let factor = 1;

      if (servingUnit === 'ml') {
        basis = 'per100ml';
        factor = parsedSize > 0 ? 100 / parsedSize : 1;
      } else if (servingUnit === 'serving') {
        basis = 'perServing';
        factor = 1;
      } else {
        basis = 'per100g';
        factor = parsedSize > 0 ? 100 / parsedSize : 1;
      }

      const servingOptions = buildServingOptions({
        basis,
        servingSize: parsedSize,
        servingUnit,
        servingWeightGrams: validWeight,
      });

      const foodItem: FoodItem = {
        id: `custom_barcode:${cleanBarcode}`,
        barcode: cleanBarcode,
        source: 'custom_barcode',
        name: name.trim(),
        brand: brand.trim() || undefined,
        basis,
        servingSize: parsedSize,
        servingUnit,
        ...(validWeight !== undefined
          ? { servingWeightGrams: validWeight }
          : {}),
        ...(servingOptions ? { servingOptions } : {}),
        nutrientsPerBasis: {
          calories: round2(parsedCal * factor),
          protein: round2(parsedP * factor),
          carbs: round2(parsedC * factor),
          fat: round2(parsedF * factor),
          fiber: round2(parsedFib * factor),
        },
        micronutrientsPerBasis:
          parsedSod !== undefined ? { sodiumMg: round2(parsedSod * factor) } : {},
        updatedAt: Date.now(),
      };

      const logEntry: FoodLogEntry = {
        id: generateId(),
        date: effectiveDate,
        mealSlot: effectiveMealSlot,
        foodId: foodItem.id,
        name: foodItem.name,
        source: 'custom_barcode',
        amount: parsedSize,
        unit: servingUnit,
        nutritionSnapshot: {
          calories: round2(parsedCal),
          protein: round2(parsedP),
          carbs: round2(parsedC),
          fat: round2(parsedF),
          fiber: round2(parsedFib),
          micros: parsedSod !== undefined ? { sodiumMg: round2(parsedSod) } : {},
        },
        createdAt: Date.now(),
      };

      await db.transaction('rw', db.foodsCache, db.foodLogs, async () => {
        await db.foodsCache.put(foodItem);
        await db.foodLogs.add(logEntry);
      });

      triggerHaptic(10);
      onSaved?.(foodItem);
      onClose();
    } catch (err) {
      console.error('Failed to save and log custom product:', err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add Missing Product"
      className="fixed inset-0 z-50 flex flex-col justify-end sm:items-center sm:justify-center sm:p-6 bg-black/70 backdrop-blur-xs animate-backdrop-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg mx-auto surface-elevated-sheet rounded-t-3xl sm:rounded-3xl px-4 sm:px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-5 animate-sheet-in sm:animate-modal-in max-h-[90dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="w-9 h-1 rounded-full bg-border mx-auto mb-3 shrink-0 sm:hidden"
          aria-hidden="true"
        />
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Add Missing Product
            </h2>
            <p className="text-[11px] text-muted-foreground font-mono">
              Barcode: <span className="text-foreground">{barcode}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close add product modal"
            className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* AI OCR Scan Header Button */}
        <div className="pt-3 pb-2 space-y-2">
          <input
            ref={fileInputRef}
            data-testid="ocr-file-input"
            type="file"
            accept="image/*"
            aria-label="Upload nutrition label"
            className="hidden"
            onChange={handleOcrFile}
          />
          <button
            type="button"
            disabled={isOcrLoading}
            onClick={() => fileInputRef.current?.click()}
            className="tactile-press w-full py-2.5 px-4 rounded-full bg-[var(--macro-calories)]/15 hover:bg-[var(--macro-calories)]/25 text-[var(--macro-calories)] font-semibold text-xs flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isOcrLoading ? (
              <Loader2
                className="w-4 h-4 animate-spin text-[var(--macro-calories)]"
                aria-hidden="true"
              />
            ) : (
              <Sparkles
                className="w-4 h-4 text-[var(--macro-calories)]"
                aria-hidden="true"
              />
            )}
            <span>
              {isOcrLoading
                ? 'Scanning Label with AI...'
                : 'Scan Nutrition Label (AI OCR)'}
            </span>
          </button>

          {syncAuthLocked && (
            <SyncUnlockCard
              compact
              onUnlocked={() => {
                setOcrError(null);
              }}
            />
          )}

          {ocrError && !syncAuthLocked && (
            <div className="p-2.5 rounded-xl bg-surface-sub border border-border text-[var(--neutral-over)] text-xs flex items-start gap-2">
              <AlertCircle
                className="w-4 h-4 shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <div className="space-y-0.5">
                <p>{ocrError}</p>
                <p className="text-[11px] text-muted-foreground">
                  Check AI service setup in Settings or enter the label
                  nutrition values manually below.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Form */}
        <form
          noValidate
          onSubmit={handleSaveAndLog}
          className="flex-1 overflow-y-auto overscroll-contain space-y-3 pt-1 pr-0.5"
        >
          {/* Product Name */}
          <div className="space-y-1">
            <label
              htmlFor="product-name"
              className="text-xs font-semibold text-foreground"
            >
              Product Name *
            </label>
            <input
              id="product-name"
              aria-label="Product Name"
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouchedName(true)}
              placeholder="e.g. Whey Isolate, Greek Yogurt"
              className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground placeholder:text-muted-foreground/50"
            />
            {touchedName && !name.trim() && (
              <p className="text-[11px] text-[var(--neutral-over)]">
                Enter the product name from the package front to enable saving.
              </p>
            )}
          </div>

          {/* Brand */}
          <div className="space-y-1">
            <label
              htmlFor="brand"
              className="text-xs font-semibold text-foreground"
            >
              Brand
            </label>
            <input
              id="brand"
              aria-label="Brand"
              type="text"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="e.g. Optimum Nutrition, Chobani"
              className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground placeholder:text-muted-foreground/50"
            />
          </div>

          {/* Serving Size, Unit & Optional Gram Weight */}
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <label
                htmlFor="serving-size"
                className="text-xs font-semibold text-foreground"
              >
                Serving Size *
              </label>
              <input
                id="serving-size"
                aria-label="Serving Size"
                type="number"
                step="any"
                min="0.001"
                required
                value={servingSize}
                onChange={(e) => {
                  setServingSize(e.target.value);
                  setServingError(null);
                }}
                onBlur={() => {
                  const parsed = parseFloat(servingSize);
                  if (!Number.isFinite(parsed) || parsed <= 0) {
                    setServingError(
                      'Serving size must be a positive number. Enter a value above 0 matching the package label.'
                    );
                  }
                }}
                className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="serving-unit"
                className="text-xs font-semibold text-foreground"
              >
                Serving Unit *
              </label>
              <select
                id="serving-unit"
                aria-label="Serving Unit"
                value={servingUnit}
                onChange={(e) =>
                  setServingUnit(e.target.value as 'g' | 'ml' | 'serving')
                }
                className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground"
              >
                <option value="g">g</option>
                <option value="ml">ml</option>
                <option value="serving">serving</option>
              </select>
            </div>
            <div className="space-y-1">
              <label
                htmlFor="serving-weight"
                className="text-xs font-semibold text-foreground"
              >
                Weight (g)
              </label>
              <input
                id="serving-weight"
                aria-label="Weight (g)"
                type="number"
                step="any"
                min="0"
                value={servingWeightGrams}
                onChange={(e) => setServingWeightGrams(e.target.value)}
                placeholder="Optional"
                className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums placeholder:text-muted-foreground/50"
              />
            </div>
          </div>
          {servingError && (
            <p className="text-[11px] text-[var(--neutral-over)]">
              {servingError}
            </p>
          )}

          {/* Calories & Protein */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label
                htmlFor="calories"
                className="text-xs font-semibold text-foreground"
              >
                Calories (kcal) *
              </label>
              <input
                id="calories"
                aria-label="Calories"
                type="number"
                step="any"
                min="0"
                required
                value={calories}
                onChange={(e) => setCalories(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="protein"
                className="text-xs font-semibold text-foreground"
              >
                Protein (g) *
              </label>
              <input
                id="protein"
                aria-label="Protein"
                type="number"
                step="any"
                min="0"
                required
                value={protein}
                onChange={(e) => setProtein(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
              />
            </div>
          </div>

          {/* Carbs & Fat */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label
                htmlFor="carbs"
                className="text-xs font-semibold text-foreground"
              >
                Carbs (g)
              </label>
              <input
                id="carbs"
                aria-label="Carbs"
                type="number"
                step="any"
                min="0"
                value={carbs}
                onChange={(e) => setCarbs(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="fat"
                className="text-xs font-semibold text-foreground"
              >
                Fat (g)
              </label>
              <input
                id="fat"
                aria-label="Fat"
                type="number"
                step="any"
                min="0"
                value={fat}
                onChange={(e) => setFat(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
              />
            </div>
          </div>

          {/* Fiber & Sodium */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label
                htmlFor="fiber"
                className="text-xs font-semibold text-foreground"
              >
                Fiber (g)
              </label>
              <input
                id="fiber"
                aria-label="Fiber"
                type="number"
                step="any"
                min="0"
                value={fiber}
                onChange={(e) => setFiber(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="sodium"
                className="text-xs font-semibold text-foreground"
              >
                Sodium (mg)
              </label>
              <input
                id="sodium"
                aria-label="Sodium"
                type="number"
                step="any"
                min="0"
                value={sodiumMg}
                onChange={(e) => setSodiumMg(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
              />
            </div>
          </div>

          {/* Submit Button */}
          <div className="pt-3 pb-1">
            <button
              type="submit"
              disabled={isSaving || !name.trim()}
              className="tactile-press w-full py-2.5 px-4 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-xs"
            >
              {isSaving ? (
                <Loader2
                  className="w-3.5 h-3.5 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Save className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>Save & Log</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
