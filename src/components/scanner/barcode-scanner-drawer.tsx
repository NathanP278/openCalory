"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ScanBarcode,
  X,
  CameraOff,
  Search,
  Check,
  Loader2,
  AlertTriangle,
  ArrowLeft,
  Plus,
  Edit,
} from 'lucide-react';
import { db, generateId } from '@/lib/db/opencalory-db';
import {
  getServingOptionsForFood,
  scaleFoodByOption,
} from '@/lib/nutrition/scaling';
import {
  lookupBarcodeWaterfall,
  BarcodeLookupResult,
} from '@/hooks/use-barcode-lookup';
import { startBarcodeVideoScan } from '@/lib/scanner/barcode-decoder';
import { useLoggerStore, getTodayIsoDate, formatHumanDate } from '@/stores/logger-store';
import { CustomFoodModal } from '@/components/recipes/custom-food-modal';
import { AddBarcodeProductModal } from './add-barcode-product-modal';
import type { FoodItem, FoodLogEntry, FoodServingOption } from '@/types/nutrition';

export interface BarcodeScannerDrawerProps {
  open: boolean;
  date?: string;
  mealSlot?: string;
  onClose: () => void;
}

function getNowTimestamp(): number {
  return Date.now();
}

function normalizeHitItemForOptions(item: FoodItem): FoodItem {
  if (
    item.basis === 'perServing' &&
    (!item.servingOptions || item.servingOptions.length === 0) &&
    (!item.servingWeightGrams || item.servingWeightGrams <= 0)
  ) {
    return { ...item, servingSize: 1 };
  }
  return item;
}

function BarcodeScannerContent({
  date,
  mealSlot,
  onClose,
}: {
  date?: string;
  mealSlot?: string;
  onClose: () => void;
}) {
  const storeDate = useLoggerStore((s) => s.activeDate);
  const storeMealSlot = useLoggerStore((s) => s.activeMealSlot);

  const effectiveDate = date ?? storeDate ?? getTodayIsoDate();
  const effectiveMealSlot = mealSlot ?? storeMealSlot ?? 'log';

  const [manualBarcode, setManualBarcode] = useState('');
  const [detectedBarcode, setDetectedBarcode] = useState<string | null>(null);
  const [lookupResult, setLookupResult] = useState<BarcodeLookupResult | null>(
    null
  );
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Missing product & edit product modal state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [missingBarcode, setMissingBarcode] = useState('');

  // Portion adjustment for 'hit' results
  const [selectedOptionId, setSelectedOptionId] = useState('');
  const [amount, setAmount] = useState('100');
  const [unit, setUnit] = useState('g');
  const [isLogging, setIsLogging] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isProcessingScanRef = useRef(false);
  const isLookingUpRef = useRef(false);

  const applyHitFood = useCallback((item: FoodItem) => {
    const normalized = normalizeHitItemForOptions(item);
    const options = getServingOptionsForFood(normalized);
    const firstOpt = options[0];
    const initialAmount =
      firstOpt?.defaultAmount ??
      (item.basis === 'perServing' ? 1 : item.servingSize || 100);
    const initialUnit =
      firstOpt?.unit ||
      (item.basis === 'per100ml' ? 'ml' : item.servingUnit || 'g');
    setSelectedOptionId(firstOpt?.id ?? '');
    setAmount(String(initialAmount));
    setUnit(initialUnit);
  }, []);

  // Keyboard Escape listener
  useEffect(() => {
    if (isAddModalOpen || isEditModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isAddModalOpen, isEditModalOpen]);

  const handleLookup = useCallback(
    async (code: string) => {
      const trimmed = code.trim();
      if (!trimmed || isLookingUpRef.current) return;

      isLookingUpRef.current = true;
      setIsLookingUp(true);
      try {
        const res = await lookupBarcodeWaterfall(trimmed);
        setLookupResult(res);

        if (res.status === 'hit') {
          applyHitFood(res.item);
        } else if (res.status === 'missing') {
          setMissingBarcode(trimmed);
          setIsAddModalOpen(true);
        } else if (res.status === 'offline-miss') {
          setMissingBarcode(trimmed);
        }
      } catch (err) {
        console.error('Barcode lookup failed:', err);
      } finally {
        isLookingUpRef.current = false;
        setIsLookingUp(false);
      }
    },
    [applyHitFood]
  );

  // Camera scanner effect
  useEffect(() => {
    if (lookupResult !== null || isAddModalOpen || isEditModalOpen) {
      return;
    }

    // Explicitly reset scan lock so interrupted or restarted scanning is never frozen
    isProcessingScanRef.current = false;

    const videoEl = videoRef.current;
    if (!videoEl) {
      return;
    }

    setCameraError(null);

    const stopScanning = startBarcodeVideoScan({
      video: videoEl,
      onDetected: (rawCode) => {
        if (isProcessingScanRef.current) return;
        isProcessingScanRef.current = true;
        setDetectedBarcode(rawCode);
        if (
          typeof navigator !== 'undefined' &&
          typeof navigator.vibrate === 'function'
        ) {
          try {
            navigator.vibrate(35);
          } catch {
            // Ignore vibration failures
          }
        }
        void handleLookup(rawCode);
      },
      onCameraError: (message) => {
        setCameraError(message);
      },
    });

    return () => {
      stopScanning();
    };
  }, [lookupResult, isAddModalOpen, isEditModalOpen, handleLookup]);

  const parsedAmount = Math.max(0, parseFloat(amount) || 0);

  const normalizedHitItem =
    lookupResult?.status === 'hit'
      ? normalizeHitItemForOptions(lookupResult.item)
      : null;

  const servingOptions: FoodServingOption[] = normalizedHitItem
    ? getServingOptionsForFood(normalizedHitItem)
    : [];

  const activeServingOption: FoodServingOption | undefined =
    servingOptions.find((o) => o.id === selectedOptionId) ?? servingOptions[0];

  const scaledNutrition = normalizedHitItem
    ? scaleFoodByOption(normalizedHitItem, parsedAmount, activeServingOption)
    : null;

  const handleSelectServingOption = (opt: FoodServingOption) => {
    setSelectedOptionId(opt.id);
    const nextAmount =
      opt.defaultAmount ?? (opt.unit === 'g' || opt.unit === 'ml' ? 100 : 1);
    setAmount(String(nextAmount));
    setUnit(opt.unit);
  };

  const handleLogHitFood = async () => {
    if (
      !lookupResult ||
      lookupResult.status !== 'hit' ||
      !normalizedHitItem ||
      isLogging
    ) {
      return;
    }
    setIsLogging(true);

    try {
      const item = lookupResult.item;
      const scaled = scaleFoodByOption(
        normalizedHitItem,
        parsedAmount,
        activeServingOption
      );

      const entry: FoodLogEntry = {
        id: generateId(),
        date: effectiveDate,
        mealSlot: effectiveMealSlot,
        foodId: item.id,
        name: item.name,
        source: item.source,
        amount: parsedAmount,
        unit: unit.trim() || activeServingOption?.unit || item.servingUnit || 'g',
        nutritionSnapshot: {
          calories: scaled.macros.calories,
          protein: scaled.macros.protein,
          carbs: scaled.macros.carbs,
          fat: scaled.macros.fat,
          fiber: scaled.macros.fiber,
          micros: scaled.micros,
        },
        createdAt: getNowTimestamp(),
      };

      await db.foodLogs.add(entry);
      onClose();
    } catch (err) {
      console.error('Failed to log scanned food:', err);
    } finally {
      setIsLogging(false);
    }
  };

  const handleResetScanner = () => {
    setLookupResult(null);
    setDetectedBarcode(null);
    setManualBarcode('');
    setMissingBarcode('');
    setIsAddModalOpen(false);
    setIsEditModalOpen(false);
    setCameraError(null);
    setIsLookingUp(false);
    isProcessingScanRef.current = false;
    isLookingUpRef.current = false;
  };

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Barcode Scanner"
        data-testid="barcode-scanner-drawer"
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
            <div className="flex items-center gap-2.5">
              {lookupResult ? (
                <button
                  type="button"
                  onClick={handleResetScanner}
                  aria-label="Back to camera scanner"
                  className="touch-target macro-spring active:scale-90 p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub mr-0.5"
                >
                  <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                </button>
              ) : (
                <div className="w-8 h-8 rounded-xl bg-[var(--macro-protein)]/15 flex items-center justify-center text-[var(--macro-protein)]">
                  <ScanBarcode className="w-4 h-4" aria-hidden="true" />
                </div>
              )}
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  {lookupResult?.status === 'hit'
                    ? lookupResult.item.name
                    : 'Scan Food Barcode'}
                </h2>
                <p className="text-[11px] text-muted-foreground">
                  Logging for {formatHumanDate(effectiveDate)}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close barcode scanner"
              className="touch-target macro-spring active:scale-90 p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>

          {/* Body Views */}
          {lookupResult?.status === 'hit' ? (
            /* Hit view: Product details & Portion selection */
            <div className="pt-4 flex-1 overflow-y-auto overscroll-contain space-y-4">
              <div className="flex items-center justify-between gap-2">
                {lookupResult.item.brand ? (
                  <p className="text-xs text-muted-foreground">
                    Brand:{' '}
                    <span className="text-foreground font-medium">
                      {lookupResult.item.brand}
                    </span>
                  </p>
                ) : (
                  <span />
                )}

                {(lookupResult.item.source === 'custom_barcode' ||
                  lookupResult.item.source === 'custom_food') && (
                  <button
                    type="button"
                    onClick={() => setIsEditModalOpen(true)}
                    className="tactile-press inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-sub border border-border text-xs font-semibold text-foreground hover:bg-card"
                  >
                    <Edit className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Edit Product</span>
                  </button>
                )}
              </div>

              {/* Portion Selector Box */}
              <div className="bg-surface-sub border border-border rounded-2xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">
                    Portion Amount
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
                    {activeServingOption &&
                    activeServingOption.unit !== 'g' &&
                    activeServingOption.unit !== 'ml' &&
                    activeServingOption.grams > 0
                      ? `Basis: 1 ${activeServingOption.unit} (${activeServingOption.grams}g)`
                      : `Basis: ${lookupResult.item.servingSize} ${lookupResult.item.servingUnit}`}
                  </span>
                </div>

                {/* Countable Serving Option Selector Pills */}
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
                          aria-pressed={isActive}
                          onClick={() => handleSelectServingOption(opt)}
                          className={`macro-spring active:scale-95 px-2.5 py-1 text-[11px] font-semibold rounded-full border ${
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
                      onChange={(e) => setAmount(e.target.value)}
                      className="w-full px-3 py-2 text-base font-semibold tabular-nums rounded-xl bg-surface-card border border-border focus:border-border-focus focus:outline-none text-foreground"
                    />
                  </div>
                  <div className="w-24">
                    <input
                      aria-label="Portion unit"
                      type="text"
                      value={unit}
                      onChange={(e) => setUnit(e.target.value)}
                      className="w-full px-3 py-2 text-base sm:text-xs font-medium rounded-xl bg-surface-card border border-border focus:border-border-focus focus:outline-none text-foreground text-center"
                    />
                  </div>
                </div>

                {/* Quick Presets */}
                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(activeServingOption &&
                      activeServingOption.unit !== 'g' &&
                      activeServingOption.unit !== 'ml') ||
                    (lookupResult.item.basis === 'perServing' &&
                      servingOptions.length === 1) ? (
                      [0.5, 1, 1.5, 2].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => {
                            setAmount(String(preset));
                            if (activeServingOption) {
                              setUnit(activeServingOption.unit);
                            }
                          }}
                          className={`macro-spring active:scale-95 px-2.5 py-1 text-[11px] font-semibold rounded-full ${
                            amount === String(preset)
                              ? 'bg-foreground text-background shadow-xs'
                              : 'bg-card text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {preset}x
                        </button>
                      ))
                    ) : activeServingOption?.unit === 'ml' ||
                      lookupResult.item.basis === 'per100ml' ? (
                      [50, 100, 150, 200, 250].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => {
                            setAmount(String(preset));
                            setUnit('ml');
                          }}
                          className={`macro-spring active:scale-95 px-2.5 py-1 text-[11px] font-semibold rounded-full ${
                            amount === String(preset) && unit === 'ml'
                              ? 'bg-foreground text-background shadow-xs'
                              : 'bg-card text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {preset}ml
                        </button>
                      ))
                    ) : (
                      [50, 100, 150, 200, 250].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => {
                            setAmount(String(preset));
                            setUnit('g');
                          }}
                          className={`macro-spring active:scale-95 px-2.5 py-1 text-[11px] font-semibold rounded-full ${
                            amount === String(preset) && unit === 'g'
                              ? 'bg-foreground text-background shadow-xs'
                              : 'bg-card text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {preset}g
                        </button>
                      ))
                    )}
                  </div>
                  {activeServingOption &&
                    activeServingOption.unit !== 'g' &&
                    activeServingOption.unit !== 'ml' &&
                    scaledNutrition?.effectiveGrams !== undefined && (
                      <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
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

                  {scaledNutrition.micros.sodiumMg !== undefined && (
                    <div className="bg-surface-sub/50 border border-border rounded-xl p-2 text-[10px] text-muted-foreground">
                      Sodium:{' '}
                      <strong className="text-foreground tabular-nums">
                        {scaledNutrition.micros.sodiumMg}mg
                      </strong>
                    </div>
                  )}
                </div>
              )}

              {/* Confirm Log Button */}
              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleLogHitFood}
                  disabled={isLogging || parsedAmount <= 0}
                  className="macro-spring active:scale-95 w-full py-2.5 px-4 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-xs"
                >
                  {isLogging ? (
                    <Loader2
                      className="w-3.5 h-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Check className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  <span>Log Food</span>
                </button>
              </div>
            </div>
          ) : lookupResult?.status === 'offline-miss' ? (
            /* Offline-miss View */
            <div className="pt-4 flex-1 flex flex-col justify-center items-center text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-[var(--neutral-over)]/15 flex items-center justify-center text-[var(--neutral-over)]">
                <AlertTriangle className="w-6 h-6" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-foreground">
                  Network Offline
                </h3>
                <p className="text-xs text-muted-foreground max-w-xs">
                  Barcode{' '}
                  <span className="font-mono text-foreground">
                    {missingBarcode}
                  </span>{' '}
                  was not found in your local cache, and you appear to be
                  offline.
                </p>
              </div>
              <div className="pt-2 w-full space-y-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(true)}
                  className="macro-spring active:scale-95 w-full py-2.5 px-4 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Add Product Offline</span>
                </button>
                <button
                  type="button"
                  onClick={handleResetScanner}
                  className="macro-spring active:scale-95 w-full py-2 px-4 rounded-full bg-surface-sub hover:bg-card text-foreground font-medium text-xs"
                >
                  Try Another Barcode
                </button>
              </div>
            </div>
          ) : lookupResult?.status === 'missing' ? (
            /* Missing View */
            <div className="pt-4 flex-1 flex flex-col justify-center items-center text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-[var(--macro-calories)]/15 flex items-center justify-center text-[var(--macro-calories)]">
                <Search className="w-6 h-6" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-foreground">
                  Product Not Found
                </h3>
                <p className="text-xs text-muted-foreground max-w-xs">
                  Barcode{' '}
                  <span className="font-mono text-foreground">
                    {missingBarcode}
                  </span>{' '}
                  is not registered in Open Food Facts.
                </p>
              </div>
              <div className="pt-2 w-full space-y-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(true)}
                  className="macro-spring active:scale-95 w-full py-2.5 px-4 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Add Product Details</span>
                </button>
                <button
                  type="button"
                  onClick={handleResetScanner}
                  className="macro-spring active:scale-95 w-full py-2 px-4 rounded-full bg-surface-sub hover:bg-card text-foreground font-medium text-xs"
                >
                  Scan Another
                </button>
              </div>
            </div>
          ) : (
            /* Default Camera View & Manual Search */
            <div className="pt-3 flex-1 flex flex-col min-h-0 space-y-3">
              {/* Camera Viewfinder Area */}
              <div className="relative w-full aspect-[4/3] rounded-2xl bg-black overflow-hidden border border-border flex items-center justify-center">
                {cameraError ? (
                  <div className="p-4 text-center space-y-2">
                    <CameraOff className="w-8 h-8 mx-auto text-muted-foreground/60" />
                    <p className="text-xs text-muted-foreground max-w-xs">
                      {cameraError}
                    </p>
                  </div>
                ) : (
                  <>
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      className="absolute inset-0 w-full h-full object-cover"
                    />

                    {/* Target Reticle Overlay */}
                    <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                      <div className="w-56 h-32 border-2 border-[var(--macro-calories)]/80 rounded-xl relative shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]">
                        <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-[var(--macro-calories)]" />
                        <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-[var(--macro-calories)]" />
                        <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-[var(--macro-calories)]" />
                        <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-[var(--macro-calories)]" />
                      </div>
                    </div>

                    {isLookingUp && detectedBarcode && (
                      <div className="absolute inset-0 bg-black/70 backdrop-blur-xs flex flex-col items-center justify-center gap-2 z-10">
                        <Loader2
                          className="w-6 h-6 animate-spin text-[var(--macro-calories)]"
                          aria-hidden="true"
                        />
                        <span className="text-xs font-medium text-foreground">
                          Looking up{' '}
                          <span className="font-mono">{detectedBarcode}</span>...
                        </span>
                      </div>
                    )}

                    <div className="absolute bottom-2 inset-x-0 text-center pointer-events-none">
                      <span className="text-[10px] bg-black/60 backdrop-blur-sm text-foreground/80 px-2.5 py-1 rounded-full border border-white/10 font-medium">
                        Point camera at a barcode
                      </span>
                    </div>
                  </>
                )}
              </div>

              {/* Manual Barcode Input Section */}
              <div className="space-y-1.5 pt-1">
                <span className="text-[11px] font-semibold text-muted-foreground block">
                  Or enter barcode manually:
                </span>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleLookup(manualBarcode);
                  }}
                  className="flex items-center gap-2"
                >
                  <label htmlFor="manual-barcode-input" className="sr-only">
                    Barcode
                  </label>
                  <div className="flex-1">
                    <input
                      id="manual-barcode-input"
                      aria-label="Barcode"
                      type="text"
                      placeholder="Enter barcode digits..."
                      value={manualBarcode}
                      onChange={(e) => setManualBarcode(e.target.value)}
                      className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground placeholder:text-muted-foreground/50 font-mono"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isLookingUp || !manualBarcode.trim()}
                    className="macro-spring active:scale-95 py-2 px-4 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                  >
                    {isLookingUp ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Search className="w-3.5 h-3.5" />
                    )}
                    <span>Look Up</span>
                  </button>
                </form>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Render AddBarcodeProductModal when open */}
      {isAddModalOpen && (
        <AddBarcodeProductModal
          open={isAddModalOpen}
          barcode={missingBarcode}
          date={effectiveDate}
          mealSlot={effectiveMealSlot}
          onClose={() => {
            setIsAddModalOpen(false);
          }}
          onSaved={() => {
            setIsAddModalOpen(false);
            onClose();
          }}
        />
      )}

      {/* Render CustomFoodModal for editing custom_barcode / custom_food hit */}
      {isEditModalOpen && lookupResult?.status === 'hit' && (
        <CustomFoodModal
          open={isEditModalOpen}
          initialFood={lookupResult.item}
          date={effectiveDate}
          onClose={() => setIsEditModalOpen(false)}
          onSaved={(updatedItem) => {
            setLookupResult({
              status: 'hit',
              item: updatedItem,
            });
            applyHitFood(updatedItem);
            setIsEditModalOpen(false);
          }}
        />
      )}
    </>
  );
}

export function BarcodeScannerDrawer({
  open,
  date,
  mealSlot,
  onClose,
}: BarcodeScannerDrawerProps) {
  if (!open) return null;
  return (
    <BarcodeScannerContent date={date} mealSlot={mealSlot} onClose={onClose} />
  );
}
