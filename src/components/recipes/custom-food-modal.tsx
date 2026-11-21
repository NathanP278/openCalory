"use client";

import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  Sparkles,
  Loader2,
  Save,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { db, generateId } from '@/lib/db/opencalory-db';
import { compressImageToJpeg } from '@/lib/media/image-compress';
import {
  getServingOptionsForFood,
  scaleFoodByOption,
} from '@/lib/nutrition/scaling';
import { SyncUnlockCard } from '@/components/auth/sync-unlock-modal';
import { useLoggerStore, getTodayIsoDate } from '@/stores/logger-store';
import { triggerHaptic } from '@/lib/motion';
import type {
  FoodItem,
  FoodLogEntry,
  FoodServingOption,
  Micronutrients,
  NutritionBasis,
} from '@/types/nutrition';

export interface CustomFoodModalProps {
  open: boolean;
  initialFood?: FoodItem | null;
  defaultBarcode?: string;
  logOnSave?: boolean;
  date?: string;
  onClose: () => void;
  onSaved?: (item: FoodItem) => void;
}

const round2 = (val: number): number =>
  Math.round((val + Number.EPSILON) * 100) / 100;

export function buildServingOptions(params: {
  basis: NutritionBasis;
  servingSize: number;
  servingUnit: string;
  servingWeightGrams?: number;
}): FoodServingOption[] | undefined {
  const rawUnit = (params.servingUnit || '').trim();
  const unit =
    rawUnit ||
    (params.basis === 'per100ml'
      ? 'ml'
      : params.basis === 'per100g'
        ? 'g'
        : 'serving');
  const unitLower = unit.toLowerCase();
  const metricUnit =
    params.basis === 'per100ml' || unitLower === 'ml' ? 'ml' : 'g';

  const weight =
    typeof params.servingWeightGrams === 'number' &&
    Number.isFinite(params.servingWeightGrams) &&
    params.servingWeightGrams > 0
      ? round2(params.servingWeightGrams)
      : undefined;

  const count =
    typeof params.servingSize === 'number' &&
    Number.isFinite(params.servingSize) &&
    params.servingSize > 0
      ? params.servingSize
      : 1;

  if (unitLower !== 'g' && unitLower !== 'ml') {
    if (weight && weight > 0) {
      const perUnitGrams = round2(weight / count);
      if (perUnitGrams > 0) {
        return [
          {
            id: unit,
            label: `${unit} (${perUnitGrams}${metricUnit})`,
            unit,
            grams: perUnitGrams,
            defaultAmount: count,
          },
          {
            id: metricUnit,
            label: metricUnit,
            unit: metricUnit,
            grams: 1,
            defaultAmount: 100,
          },
        ];
      }
    }
    return undefined;
  }

  if (weight && weight > 0 && weight !== 100) {
    return [
      {
        id: 'serving',
        label: `serving (${weight}${metricUnit})`,
        unit: 'serving',
        grams: weight,
        defaultAmount: 1,
      },
      {
        id: metricUnit,
        label: metricUnit,
        unit: metricUnit,
        grams: 1,
        defaultAmount: 100,
      },
    ];
  }

  return undefined;
}

const EXTENDED_KEYS: Array<keyof Micronutrients> = [
  'sugarG',
  'addedSugarG',
  'saturatedFatG',
  'cholesterolMg',
  'caffeineMg',
  'alcoholG',
];

function hasAnyExtendedNutrient(micros?: Micronutrients): boolean {
  if (!micros) return false;
  return EXTENDED_KEYS.some((k) => typeof micros[k] === 'number');
}

function numToStr(val: number | undefined): string {
  return typeof val === 'number' && Number.isFinite(val) ? String(val) : '';
}

export function CustomFoodModal({
  open,
  initialFood,
  defaultBarcode,
  logOnSave = false,
  date,
  onClose,
  onSaved,
}: CustomFoodModalProps) {
  const storeDate = useLoggerStore((s) => s.activeDate);
  const storeMealSlot = useLoggerStore((s) => s.activeMealSlot);
  const syncAuthLocked = useLoggerStore((s) => s.syncAuthLocked);

  const effectiveDate = date ?? storeDate ?? getTodayIsoDate();
  const effectiveMealSlot = storeMealSlot ?? 'log';

  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [barcode, setBarcode] = useState('');
  const [basis, setBasis] = useState<'perServing' | 'per100g'>('perServing');
  const [per100Unit, setPer100Unit] = useState<'g' | 'ml'>('g');
  const [servingSize, setServingSize] = useState('1');
  const [servingUnit, setServingUnit] = useState('serving');
  const [servingWeightGrams, setServingWeightGrams] = useState('');

  // Macros
  const [calories, setCalories] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [fiber, setFiber] = useState('');

  // Core Micros
  const [sodiumMg, setSodiumMg] = useState('');
  const [potassiumMg, setPotassiumMg] = useState('');
  const [calciumMg, setCalciumMg] = useState('');
  const [ironMg, setIronMg] = useState('');
  const [vitaminCMg, setVitaminCMg] = useState('');

  // Extended Nutrients
  const [showExtended, setShowExtended] = useState(false);
  const [sugarG, setSugarG] = useState('');
  const [addedSugarG, setAddedSugarG] = useState('');
  const [saturatedFatG, setSaturatedFatG] = useState('');
  const [cholesterolMg, setCholesterolMg] = useState('');
  const [caffeineMg, setCaffeineMg] = useState('');
  const [alcoholG, setAlcoholG] = useState('');

  // Status & errors
  const [isOcrLoading, setIsOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [servingError, setServingError] = useState<string | null>(null);
  const [touchedName, setTouchedName] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const modalInitKey = `${open}:${initialFood?.id ?? 'new'}:${initialFood?.updatedAt ?? 0}:${defaultBarcode ?? ''}`;
  const [prevInitKey, setPrevInitKey] = useState('');

  if (modalInitKey !== prevInitKey) {
    setPrevInitKey(modalInitKey);
    if (open) {
      setTouchedName(false);
      setServingError(null);
      setOcrError(null);
      if (initialFood) {
        const countableOpt = initialFood.servingOptions?.find(
          (o) => o.unit !== 'g' && o.unit !== 'ml'
        );
        const initBasis: 'perServing' | 'per100g' =
          initialFood.basis === 'perServing' ? 'perServing' : 'per100g';
        const initUnit =
          initialFood.servingUnit &&
          initialFood.servingUnit !== 'g' &&
          initialFood.servingUnit !== 'ml'
            ? initialFood.servingUnit
            : countableOpt
              ? countableOpt.unit
              : initialFood.servingUnit ||
                (initBasis === 'perServing' ? 'serving' : 'g');
        const initSize =
          initialFood.servingUnit &&
          initialFood.servingUnit !== 'g' &&
          initialFood.servingUnit !== 'ml'
            ? initialFood.servingSize || 1
            : countableOpt
              ? countableOpt.defaultAmount ?? 1
              : initBasis === 'per100g'
                ? 100
                : initialFood.servingSize || 1;
        const initWeight =
          initialFood.servingWeightGrams ??
          (countableOpt && countableOpt.grams > 0
            ? round2(countableOpt.grams * (countableOpt.defaultAmount ?? 1))
            : undefined);

        setName(initialFood.name || '');
        setBrand(initialFood.brand || '');
        setBarcode(initialFood.barcode ?? defaultBarcode ?? '');
        setBasis(initBasis);
        setPer100Unit(
          initialFood.basis === 'per100ml' ||
            initialFood.servingUnit?.toLowerCase() === 'ml'
            ? 'ml'
            : 'g'
        );
        setServingSize(String(initSize));
        setServingUnit(initUnit);
        setServingWeightGrams(initWeight ? String(initWeight) : '');

        setCalories(numToStr(initialFood.nutrientsPerBasis?.calories));
        setProtein(numToStr(initialFood.nutrientsPerBasis?.protein));
        setCarbs(numToStr(initialFood.nutrientsPerBasis?.carbs));
        setFat(numToStr(initialFood.nutrientsPerBasis?.fat));
        setFiber(numToStr(initialFood.nutrientsPerBasis?.fiber));

        const m = initialFood.micronutrientsPerBasis ?? {};
        setSodiumMg(numToStr(m.sodiumMg));
        setPotassiumMg(numToStr(m.potassiumMg));
        setCalciumMg(numToStr(m.calciumMg));
        setIronMg(numToStr(m.ironMg));
        setVitaminCMg(numToStr(m.vitaminCMg));

        setShowExtended(hasAnyExtendedNutrient(m));
        setSugarG(numToStr(m.sugarG));
        setAddedSugarG(numToStr(m.addedSugarG));
        setSaturatedFatG(numToStr(m.saturatedFatG));
        setCholesterolMg(numToStr(m.cholesterolMg));
        setCaffeineMg(numToStr(m.caffeineMg));
        setAlcoholG(numToStr(m.alcoholG));
      } else {
        setName('');
        setBrand('');
        setBarcode(defaultBarcode ?? '');
        setBasis('perServing');
        setPer100Unit('g');
        setServingSize('1');
        setServingUnit('serving');
        setServingWeightGrams('');

        setCalories('');
        setProtein('');
        setCarbs('');
        setFat('');
        setFiber('');

        setSodiumMg('');
        setPotassiumMg('');
        setCalciumMg('');
        setIronMg('');
        setVitaminCMg('');

        setShowExtended(false);
        setSugarG('');
        setAddedSugarG('');
        setSaturatedFatG('');
        setCholesterolMg('');
        setCaffeineMg('');
        setAlcoholG('');
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const trimmedUnitLower = servingUnit.trim().toLowerCase();
  const isPer100MetricMode =
    basis === 'per100g' &&
    (trimmedUnitLower === '' ||
      trimmedUnitLower === 'g' ||
      trimmedUnitLower === 'ml');
  const effectiveMetricUnit: 'g' | 'ml' =
    trimmedUnitLower === 'ml'
      ? 'ml'
      : trimmedUnitLower === 'g'
        ? 'g'
        : per100Unit;

  const parsedPreviewSize = parseFloat(servingSize);
  const parsedPreviewWeight = parseFloat(servingWeightGrams);
  const parsedPreviewCal = parseFloat(calories);
  const countablePreview =
    basis === 'per100g' &&
    trimmedUnitLower.length > 0 &&
    trimmedUnitLower !== 'g' &&
    trimmedUnitLower !== 'ml' &&
    Number.isFinite(parsedPreviewSize) &&
    parsedPreviewSize > 0 &&
    Number.isFinite(parsedPreviewWeight) &&
    parsedPreviewWeight > 0 &&
    Number.isFinite(parsedPreviewCal) &&
    parsedPreviewCal >= 0
      ? `1 ${servingUnit.trim()} (${round2(parsedPreviewWeight / parsedPreviewSize)}${effectiveMetricUnit}) = ${round2((parsedPreviewCal * (parsedPreviewWeight / parsedPreviewSize)) / 100)} kcal`
      : null;

  const handleBasisChange = (nextBasis: 'perServing' | 'per100g') => {
    setBasis(nextBasis);
    setServingError(null);
    const unitLow = servingUnit.trim().toLowerCase();
    if (nextBasis === 'per100g') {
      if (unitLow === 'serving' && servingSize === '1') {
        setServingSize('100');
        setServingUnit(per100Unit);
      } else if (unitLow === 'g' || unitLow === 'ml' || unitLow === '') {
        setServingSize('100');
        setServingUnit(
          unitLow === 'ml' ? 'ml' : unitLow === 'g' ? 'g' : per100Unit
        );
      }
    } else if (
      nextBasis === 'perServing' &&
      servingSize === '100' &&
      (unitLow === 'g' || unitLow === 'ml')
    ) {
      setServingSize('1');
      setServingUnit('serving');
    }
  };

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
      if (data.name) setName(String(data.name));
      if (data.brand) setBrand(String(data.brand));

      const rawUnitStr =
        typeof data.servingUnit === 'string' ? data.servingUnit.trim() : '';
      const unitLower = rawUnitStr.toLowerCase();
      const isMetricOcr = unitLower === 'g' || unitLower === 'ml';

      const parsedOcrSize =
        data.servingSize !== undefined
          ? parseFloat(String(data.servingSize))
          : NaN;
      const validOcrSize =
        Number.isFinite(parsedOcrSize) && parsedOcrSize > 0
          ? parsedOcrSize
          : undefined;
      const ocrFactor = isMetricOcr && validOcrSize ? 100 / validOcrSize : 1;

      if (isMetricOcr) {
        const metricUnit: 'g' | 'ml' = unitLower === 'ml' ? 'ml' : 'g';
        setBasis('per100g');
        setPer100Unit(metricUnit);
        setServingSize('100');
        setServingUnit(metricUnit);
        if (data.servingWeightGrams !== undefined) {
          setServingWeightGrams(String(data.servingWeightGrams));
        } else if (validOcrSize !== undefined && validOcrSize !== 100) {
          setServingWeightGrams(String(round2(validOcrSize)));
        } else {
          setServingWeightGrams('');
        }
      } else {
        if (validOcrSize !== undefined) {
          setServingSize(String(validOcrSize));
        } else if (data.servingSize !== undefined) {
          setServingSize(String(data.servingSize));
        }
        if (rawUnitStr) {
          setServingUnit(rawUnitStr);
          setBasis('perServing');
        }
        if (data.servingWeightGrams !== undefined) {
          setServingWeightGrams(String(data.servingWeightGrams));
        }
      }

      const scaleOcrNutrient = (raw: unknown): string | undefined => {
        if (raw === undefined || raw === null || raw === '') return undefined;
        const parsed = typeof raw === 'number' ? raw : parseFloat(String(raw));
        if (!Number.isFinite(parsed)) return undefined;
        return String(round2(parsed * ocrFactor));
      };

      const scaledCal = scaleOcrNutrient(data.calories);
      if (scaledCal !== undefined) setCalories(scaledCal);
      const scaledP = scaleOcrNutrient(data.protein);
      if (scaledP !== undefined) setProtein(scaledP);
      const scaledC = scaleOcrNutrient(data.carbs);
      if (scaledC !== undefined) setCarbs(scaledC);
      const scaledF = scaleOcrNutrient(data.fat);
      if (scaledF !== undefined) setFat(scaledF);
      const scaledFib = scaleOcrNutrient(data.fiber);
      if (scaledFib !== undefined) setFiber(scaledFib);
      const scaledSod = scaleOcrNutrient(data.sodiumMg);
      if (scaledSod !== undefined) setSodiumMg(scaledSod);
      const scaledPot = scaleOcrNutrient(data.potassiumMg);
      if (scaledPot !== undefined) setPotassiumMg(scaledPot);
      const scaledCa = scaleOcrNutrient(data.calciumMg);
      if (scaledCa !== undefined) setCalciumMg(scaledCa);
      const scaledFe = scaleOcrNutrient(data.ironMg);
      if (scaledFe !== undefined) setIronMg(scaledFe);
      const scaledVitC = scaleOcrNutrient(data.vitaminCMg);
      if (scaledVitC !== undefined) setVitaminCMg(scaledVitC);

      let foundExtended = false;
      const scaledSugar = scaleOcrNutrient(data.sugarG);
      if (scaledSugar !== undefined) {
        setSugarG(scaledSugar);
        foundExtended = true;
      }
      const scaledAddedSugar = scaleOcrNutrient(data.addedSugarG);
      if (scaledAddedSugar !== undefined) {
        setAddedSugarG(scaledAddedSugar);
        foundExtended = true;
      }
      const scaledSatFat = scaleOcrNutrient(data.saturatedFatG);
      if (scaledSatFat !== undefined) {
        setSaturatedFatG(scaledSatFat);
        foundExtended = true;
      }
      const scaledChol = scaleOcrNutrient(data.cholesterolMg);
      if (scaledChol !== undefined) {
        setCholesterolMg(scaledChol);
        foundExtended = true;
      }
      const scaledCaf = scaleOcrNutrient(data.caffeineMg);
      if (scaledCaf !== undefined) {
        setCaffeineMg(scaledCaf);
        foundExtended = true;
      }
      const scaledAlc = scaleOcrNutrient(data.alcoholG);
      if (scaledAlc !== undefined) {
        setAlcoholG(scaledAlc);
        foundExtended = true;
      }
      if (foundExtended) {
        setShowExtended(true);
      }
    } catch (err: unknown) {
      setOcrError(
        err instanceof Error ? err.message : 'Failed to scan nutrition label.'
      );
    } finally {
      setIsOcrLoading(false);
      if (e.target) e.target.value = '';
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving || !name.trim()) return;

    const rawServingSize = parseFloat(servingSize);
    if (!Number.isFinite(rawServingSize) || rawServingSize <= 0) {
      setServingError(
        'Serving size must be a positive number. Enter a value above 0 matching the package label.'
      );
      return;
    }

    const cleanUnit =
      servingUnit.trim() ||
      (basis === 'perServing' ? 'serving' : effectiveMetricUnit);
    const unitLower = cleanUnit.toLowerCase();

    const rawWeight =
      servingWeightGrams.trim() !== ''
        ? parseFloat(servingWeightGrams)
        : undefined;
    const validWeight =
      rawWeight !== undefined && Number.isFinite(rawWeight) && rawWeight > 0
        ? round2(rawWeight)
        : undefined;

    if (
      basis === 'per100g' &&
      unitLower !== 'g' &&
      unitLower !== 'ml' &&
      validWeight === undefined
    ) {
      setServingError(
        `Enter the ${effectiveMetricUnit} weight for this countable serving (e.g. 25${effectiveMetricUnit} per ${cleanUnit}), or set Serving Unit to ${effectiveMetricUnit}.`
      );
      return;
    }

    setServingError(null);
    setIsSaving(true);

    try {
      const cleanBarcode = barcode.trim();

      const effectiveBasis: NutritionBasis =
        basis === 'perServing'
          ? 'perServing'
          : effectiveMetricUnit === 'ml'
            ? 'per100ml'
            : 'per100g';

      // Nutrition inputs in per100g/per100ml mode are always per 100g/100ml, and in perServing mode per servingSize.
      const factor = 1;

      const parseNutrient = (raw: string): number =>
        Math.max(0, parseFloat(raw) || 0);

      const parseOptionalMicro = (raw: string): number | undefined => {
        if (raw.trim() === '') return undefined;
        const parsed = parseFloat(raw);
        if (!Number.isFinite(parsed) || parsed < 0) return undefined;
        return round2(parsed * factor);
      };

      const parsedCal = parseNutrient(calories);
      const parsedP = parseNutrient(protein);
      const parsedC = parseNutrient(carbs);
      const parsedF = parseNutrient(fat);
      const parsedFib = parseNutrient(fiber);

      const micros: Micronutrients = {
        ...(initialFood?.micronutrientsPerBasis ?? {}),
      };

      const microEntries: Array<[keyof Micronutrients, string]> = [
        ['sodiumMg', sodiumMg],
        ['potassiumMg', potassiumMg],
        ['calciumMg', calciumMg],
        ['ironMg', ironMg],
        ['vitaminCMg', vitaminCMg],
        ['sugarG', sugarG],
        ['addedSugarG', addedSugarG],
        ['saturatedFatG', saturatedFatG],
        ['cholesterolMg', cholesterolMg],
        ['caffeineMg', caffeineMg],
        ['alcoholG', alcoholG],
      ];

      for (const [key, rawVal] of microEntries) {
        const val = parseOptionalMicro(rawVal);
        if (val !== undefined) {
          micros[key] = val;
        } else {
          delete micros[key];
        }
      }

      const source: FoodItem['source'] =
        cleanBarcode.length > 0 ? 'custom_barcode' : 'custom_food';

      let itemId: string;
      if (initialFood) {
        if (
          cleanBarcode.length > 0 &&
          (initialFood.id.startsWith('custom_barcode:') ||
            initialFood.id.startsWith('custom_food:'))
        ) {
          itemId = `custom_barcode:${cleanBarcode}`;
        } else if (
          cleanBarcode.length === 0 &&
          initialFood.id.startsWith('custom_barcode:')
        ) {
          itemId = `custom_food:${generateId()}`;
        } else {
          itemId = initialFood.id;
        }
      } else {
        itemId =
          cleanBarcode.length > 0
            ? `custom_barcode:${cleanBarcode}`
            : `custom_food:${generateId()}`;
      }

      const servingOptions = buildServingOptions({
        basis: effectiveBasis,
        servingSize: rawServingSize,
        servingUnit: cleanUnit,
        servingWeightGrams: validWeight,
      });

      const storedServingSize =
        effectiveBasis === 'perServing' ? rawServingSize : 100;
      const storedServingUnit =
        effectiveBasis === 'perServing' ? cleanUnit : effectiveMetricUnit;

      const foodItem: FoodItem = {
        id: itemId,
        ...(cleanBarcode ? { barcode: cleanBarcode } : {}),
        source,
        name: name.trim(),
        ...(brand.trim() ? { brand: brand.trim() } : {}),
        basis: effectiveBasis,
        servingSize: storedServingSize,
        servingUnit: storedServingUnit,
        ...(validWeight !== undefined ? { servingWeightGrams: validWeight } : {}),
        ...(servingOptions ? { servingOptions } : {}),
        nutrientsPerBasis: {
          calories: round2(parsedCal * factor),
          protein: round2(parsedP * factor),
          carbs: round2(parsedC * factor),
          fat: round2(parsedF * factor),
          fiber: round2(parsedFib * factor),
        },
        micronutrientsPerBasis: micros,
        updatedAt: Date.now(),
      };

      await db.transaction('rw', db.foodsCache, db.foodLogs, async () => {
        if (initialFood && initialFood.id !== foodItem.id) {
          await db.foodsCache.delete(initialFood.id);
        }
        await db.foodsCache.put(foodItem);

        if (logOnSave) {
          const options = getServingOptionsForFood(foodItem);
          const firstOpt = options[0];
          const logAmount =
            firstOpt?.defaultAmount ??
            (foodItem.basis === 'perServing' ? foodItem.servingSize || 1 : 100);
          const logUnit = firstOpt?.unit || foodItem.servingUnit || 'g';
          const scaled = scaleFoodByOption(foodItem, logAmount, firstOpt);

          const logEntry: FoodLogEntry = {
            id: generateId(),
            date: effectiveDate,
            mealSlot: effectiveMealSlot,
            foodId: foodItem.id,
            name: foodItem.name,
            source: foodItem.source,
            amount: logAmount,
            unit: logUnit,
            nutritionSnapshot: {
              calories: scaled.macros.calories,
              protein: scaled.macros.protein,
              carbs: scaled.macros.carbs,
              fat: scaled.macros.fat,
              fiber: scaled.macros.fiber,
              micros: scaled.micros,
            },
            createdAt: Date.now(),
          };
          await db.foodLogs.add(logEntry);
        }
      });

      triggerHaptic(10);
      onSaved?.(foodItem);
      onClose();
    } catch (err) {
      console.error('Failed to save custom food:', err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={initialFood ? 'Edit Custom Food' : 'Create Custom Food'}
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
              {initialFood ? 'Edit Custom Food' : 'New Custom Food'}
            </h2>
            <p className="text-[11px] text-muted-foreground">
              {barcode.trim()
                ? `Barcode: ${barcode.trim()}`
                : 'Standalone custom food or barcode product'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close custom food modal"
            className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* AI OCR Scan Header Button & SyncUnlockCard */}
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
                  Check AI service setup in Settings or enter the label nutrition values manually below.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Form */}
        <form
          noValidate
          onSubmit={handleSave}
          className="flex-1 overflow-y-auto overscroll-contain space-y-3 pt-1 pr-0.5"
        >
          {/* Food Name */}
          <div className="space-y-1">
            <label
              htmlFor="custom-food-name"
              className="text-xs font-semibold text-foreground"
            >
              Food Name *
            </label>
            <input
              id="custom-food-name"
              aria-label="Food Name"
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouchedName(true)}
              placeholder="e.g. Homemade Granola, Whey Isolate"
              className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground placeholder:text-muted-foreground/50"
            />
            {touchedName && !name.trim() && (
              <p className="text-[11px] text-[var(--neutral-over)]">
                Enter a food name to enable saving.
              </p>
            )}
          </div>

          {/* Brand & Optional Barcode */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1">
              <label
                htmlFor="custom-food-brand"
                className="text-xs font-semibold text-foreground"
              >
                Brand
              </label>
              <input
                id="custom-food-brand"
                aria-label="Brand"
                type="text"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="e.g. Home Kitchen, Fage"
                className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground placeholder:text-muted-foreground/50"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="custom-food-barcode"
                className="text-xs font-semibold text-foreground"
              >
                Barcode (optional)
              </label>
              <input
                id="custom-food-barcode"
                aria-label="Barcode"
                type="text"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                placeholder="Optional UPC / EAN..."
                className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground placeholder:text-muted-foreground/50 font-mono"
              />
            </div>
          </div>

          {/* Basis Toggle */}
          <div className="space-y-1">
            <span className="text-xs font-semibold text-foreground block">
              Nutrition Basis
            </span>
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-surface-sub rounded-full border border-border/60">
              <button
                type="button"
                aria-pressed={basis === 'perServing'}
                onClick={() => handleBasisChange('perServing')}
                className={`tactile-press py-1.5 px-3 rounded-full text-xs font-semibold transition-colors ${
                  basis === 'perServing'
                    ? 'bg-foreground text-background shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Per Serving
              </button>
              <button
                type="button"
                aria-pressed={basis === 'per100g'}
                onClick={() => handleBasisChange('per100g')}
                className={`tactile-press py-1.5 px-3 rounded-full text-xs font-semibold transition-colors ${
                  basis === 'per100g'
                    ? 'bg-foreground text-background shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Per 100g
              </button>
            </div>
          </div>

          {/* Serving Size, Unit & Optional Gram Weight */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span className="text-xs font-semibold text-foreground">
                {basis === 'perServing'
                  ? 'Serving Definition'
                  : `Optional Countable Serving (${effectiveMetricUnit})`}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {basis === 'perServing'
                  ? 'Nutrition values below are per this serving'
                  : `Optional shortcut e.g. 1 pack = 25${effectiveMetricUnit}`}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <label
                  htmlFor="custom-food-serving-size"
                  className="text-xs font-semibold text-foreground"
                >
                  Serving Size *
                </label>
                <input
                  id="custom-food-serving-size"
                  aria-label="Serving Size"
                  type="number"
                  step="any"
                  min="0.001"
                  required
                  readOnly={isPer100MetricMode}
                  value={isPer100MetricMode ? '100' : servingSize}
                  onChange={(e) => {
                    if (isPer100MetricMode) return;
                    setServingSize(e.target.value);
                    setServingError(null);
                  }}
                  onBlur={() => {
                    if (isPer100MetricMode) return;
                    const parsed = parseFloat(servingSize);
                    if (!Number.isFinite(parsed) || parsed <= 0) {
                      setServingError(
                        'Serving size must be a positive number. Enter a value above 0 matching the package label.'
                      );
                    }
                  }}
                  className={`w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums ${
                    isPer100MetricMode ? 'opacity-70 cursor-not-allowed' : ''
                  }`}
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="custom-food-serving-unit"
                  className="text-xs font-semibold text-foreground"
                >
                  Serving Unit *
                </label>
                <input
                  id="custom-food-serving-unit"
                  aria-label="Serving Unit"
                  type="text"
                  list="custom-food-unit-options"
                  value={servingUnit}
                  onChange={(e) => {
                    const val = e.target.value;
                    const prevLow = servingUnit.trim().toLowerCase();
                    const nextLow = val.trim().toLowerCase();
                    setServingUnit(val);
                    setServingError(null);
                    if (nextLow === 'ml') setPer100Unit('ml');
                    else if (nextLow === 'g') setPer100Unit('g');
                    if (basis === 'per100g') {
                      if (
                        nextLow === 'g' ||
                        nextLow === 'ml' ||
                        nextLow === ''
                      ) {
                        setServingSize('100');
                      } else if (
                        (prevLow === 'g' ||
                          prevLow === 'ml' ||
                          prevLow === '') &&
                        servingSize === '100'
                      ) {
                        setServingSize('1');
                      }
                    }
                  }}
                  placeholder="e.g. pack, scoop, g"
                  className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground"
                />
                <datalist id="custom-food-unit-options">
                  <option value="serving" />
                  <option value="pack" />
                  <option value="scoop" />
                  <option value="piece" />
                  <option value="pc" />
                  <option value="slice" />
                  <option value="cup" />
                  <option value="bar" />
                  <option value="bottle" />
                  <option value="can" />
                  <option value="sachet" />
                  <option value="g" />
                  <option value="ml" />
                </datalist>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="custom-food-serving-weight"
                  className="text-xs font-semibold text-foreground"
                >
                  Serving Weight ({basis === 'per100g' ? effectiveMetricUnit : 'g'})
                </label>
                <input
                  id="custom-food-serving-weight"
                  aria-label="Serving Weight (g)"
                  type="number"
                  step="any"
                  min="0"
                  value={servingWeightGrams}
                  onChange={(e) => {
                    setServingWeightGrams(e.target.value);
                    setServingError(null);
                  }}
                  placeholder="e.g. 25"
                  className="w-full px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums placeholder:text-muted-foreground/50"
                />
              </div>
            </div>
          </div>
          {servingError && (
            <p className="text-[11px] text-[var(--neutral-over)]">
              {servingError}
            </p>
          )}

          {/* Unambiguous Nutrition Values Header */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className="text-xs font-semibold text-foreground">
              {basis === 'perServing'
                ? `Nutrition Values (per ${servingSize || '1'} ${servingUnit.trim() || 'serving'})`
                : `Nutrition Values (per 100${effectiveMetricUnit})`}
            </span>
            {countablePreview && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {countablePreview}
              </span>
            )}
          </div>

          {/* Macros: Calories & Protein */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label
                htmlFor="custom-food-calories"
                className="text-xs font-semibold text-foreground"
              >
                Calories (kcal) *
              </label>
              <input
                id="custom-food-calories"
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
                htmlFor="custom-food-protein"
                className="text-xs font-semibold text-foreground"
              >
                Protein (g) *
              </label>
              <input
                id="custom-food-protein"
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

          {/* Carbs, Fat, Fiber */}
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <label
                htmlFor="custom-food-carbs"
                className="text-xs font-semibold text-foreground"
              >
                Carbs (g)
              </label>
              <input
                id="custom-food-carbs"
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
                htmlFor="custom-food-fat"
                className="text-xs font-semibold text-foreground"
              >
                Fat (g)
              </label>
              <input
                id="custom-food-fat"
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
            <div className="space-y-1">
              <label
                htmlFor="custom-food-fiber"
                className="text-xs font-semibold text-foreground"
              >
                Fiber (g)
              </label>
              <input
                id="custom-food-fiber"
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
          </div>

          {/* Core Micros */}
          <div className="pt-1 space-y-2">
            <span className="text-[11px] font-semibold text-muted-foreground block">
              Core Micronutrients (optional)
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <div className="space-y-1">
                <label
                  htmlFor="custom-food-sodium"
                  className="text-[11px] font-medium text-foreground"
                >
                  Sodium (mg)
                </label>
                <input
                  id="custom-food-sodium"
                  aria-label="Sodium"
                  type="number"
                  step="any"
                  min="0"
                  value={sodiumMg}
                  onChange={(e) => setSodiumMg(e.target.value)}
                  placeholder="0"
                  className="w-full px-2.5 py-1.5 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="custom-food-potassium"
                  className="text-[11px] font-medium text-foreground"
                >
                  Potassium (mg)
                </label>
                <input
                  id="custom-food-potassium"
                  aria-label="Potassium"
                  type="number"
                  step="any"
                  min="0"
                  value={potassiumMg}
                  onChange={(e) => setPotassiumMg(e.target.value)}
                  placeholder="0"
                  className="w-full px-2.5 py-1.5 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="custom-food-calcium"
                  className="text-[11px] font-medium text-foreground"
                >
                  Calcium (mg)
                </label>
                <input
                  id="custom-food-calcium"
                  aria-label="Calcium"
                  type="number"
                  step="any"
                  min="0"
                  value={calciumMg}
                  onChange={(e) => setCalciumMg(e.target.value)}
                  placeholder="0"
                  className="w-full px-2.5 py-1.5 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="custom-food-iron"
                  className="text-[11px] font-medium text-foreground"
                >
                  Iron (mg)
                </label>
                <input
                  id="custom-food-iron"
                  aria-label="Iron"
                  type="number"
                  step="any"
                  min="0"
                  value={ironMg}
                  onChange={(e) => setIronMg(e.target.value)}
                  placeholder="0"
                  className="w-full px-2.5 py-1.5 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="custom-food-vitamin-c"
                  className="text-[11px] font-medium text-foreground"
                >
                  Vitamin C (mg)
                </label>
                <input
                  id="custom-food-vitamin-c"
                  aria-label="Vitamin C"
                  type="number"
                  step="any"
                  min="0"
                  value={vitaminCMg}
                  onChange={(e) => setVitaminCMg(e.target.value)}
                  placeholder="0"
                  className="w-full px-2.5 py-1.5 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
                />
              </div>
            </div>
          </div>

          {/* Collapsible Extended Nutrients Section */}
          <div className="pt-1 border-t border-border/60">
            <button
              type="button"
              aria-expanded={showExtended}
              onClick={() => setShowExtended((prev) => !prev)}
              className="tactile-press w-full py-1.5 flex items-center justify-between text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              <span>Extended Nutrients (Sugar, Sat Fat, Caffeine, Alcohol)</span>
              {showExtended ? (
                <ChevronUp className="w-4 h-4" aria-hidden="true" />
              ) : (
                <ChevronDown className="w-4 h-4" aria-hidden="true" />
              )}
            </button>

            {showExtended && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-2">
                <div className="space-y-1">
                  <label
                    htmlFor="custom-food-sugar"
                    className="text-[11px] font-medium text-foreground"
                  >
                    Sugar (g)
                  </label>
                  <input
                    id="custom-food-sugar"
                    aria-label="Sugar"
                    type="number"
                    step="any"
                    min="0"
                    value={sugarG}
                    onChange={(e) => setSugarG(e.target.value)}
                    placeholder="0"
                    className="w-full px-2.5 py-1.5 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="custom-food-added-sugar"
                    className="text-[11px] font-medium text-foreground"
                  >
                    Added Sugar (g)
                  </label>
                  <input
                    id="custom-food-added-sugar"
                    aria-label="Added Sugar"
                    type="number"
                    step="any"
                    min="0"
                    value={addedSugarG}
                    onChange={(e) => setAddedSugarG(e.target.value)}
                    placeholder="0"
                    className="w-full px-2.5 py-1.5 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="custom-food-saturated-fat"
                    className="text-[11px] font-medium text-foreground"
                  >
                    Saturated Fat (g)
                  </label>
                  <input
                    id="custom-food-saturated-fat"
                    aria-label="Saturated Fat"
                    type="number"
                    step="any"
                    min="0"
                    value={saturatedFatG}
                    onChange={(e) => setSaturatedFatG(e.target.value)}
                    placeholder="0"
                    className="w-full px-2.5 py-1.5 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="custom-food-cholesterol"
                    className="text-[11px] font-medium text-foreground"
                  >
                    Cholesterol (mg)
                  </label>
                  <input
                    id="custom-food-cholesterol"
                    aria-label="Cholesterol"
                    type="number"
                    step="any"
                    min="0"
                    value={cholesterolMg}
                    onChange={(e) => setCholesterolMg(e.target.value)}
                    placeholder="0"
                    className="w-full px-2.5 py-1.5 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="custom-food-caffeine"
                    className="text-[11px] font-medium text-foreground"
                  >
                    Caffeine (mg)
                  </label>
                  <input
                    id="custom-food-caffeine"
                    aria-label="Caffeine"
                    type="number"
                    step="any"
                    min="0"
                    value={caffeineMg}
                    onChange={(e) => setCaffeineMg(e.target.value)}
                    placeholder="0"
                    className="w-full px-2.5 py-1.5 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="custom-food-alcohol"
                    className="text-[11px] font-medium text-foreground"
                  >
                    Alcohol (g)
                  </label>
                  <input
                    id="custom-food-alcohol"
                    aria-label="Alcohol"
                    type="number"
                    step="any"
                    min="0"
                    value={alcoholG}
                    onChange={(e) => setAlcoholG(e.target.value)}
                    placeholder="0"
                    className="w-full px-2.5 py-1.5 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:border-border-focus focus:outline-none text-foreground tabular-nums"
                  />
                </div>
              </div>
            )}
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
              <span>{logOnSave ? 'Save & Log' : 'Save Food'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
