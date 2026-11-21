"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Camera,
  Upload,
  Sparkles,
  X,
  AlertTriangle,
  Loader2,
  Plus,
  Send,
  RotateCcw,
  CheckCircle2,
  ArrowLeft,
  ChevronDown,
  ChefHat,
  FileText,
} from 'lucide-react';
import { useLoggerStore, getTodayIsoDate, AiDraftItem } from '@/stores/logger-store';
import { db, generateId } from '@/lib/db/opencalory-db';
import { scaleNutrition } from '@/lib/nutrition/scaling';
import { RDA_MICRONUTRIENT_METADATA } from '@/lib/nutrition/daily-summary';
import { compressImageToJpeg } from '@/lib/media/image-compress';
import { loadStaples } from '@/lib/foods/staples-search';
import { SyncUnlockCard } from '@/components/auth/sync-unlock-modal';
import { RecipeBuilderModal } from '@/components/recipes/recipe-builder-modal';
import { HitlIngredientRow } from './hitl-ingredient-row';
import { HitlVerificationSwapModal } from './hitl-verification-swap-modal';
import type {
  CustomRecipeIngredient,
  FoodLogEntry,
  FoodSource,
  MacroNutrients,
  Micronutrients,
} from '@/types/nutrition';

const STAGE3_EXTENDED_NUTRIENTS = [
  { key: 'sugarG', name: 'Sugar', unit: 'g' },
  { key: 'addedSugarG', name: 'Added Sugar', unit: 'g' },
  { key: 'saturatedFatG', name: 'Sat. Fat', unit: 'g' },
  { key: 'cholesterolMg', name: 'Cholesterol', unit: 'mg' },
  { key: 'caffeineMg', name: 'Caffeine', unit: 'mg' },
  { key: 'alcoholG', name: 'Alcohol', unit: 'g' },
] as const;

const TEXT_MEAL_EXAMPLES = [
  '2 boiled eggs, 150g white rice, and 1 cup black coffee',
  '200g chicken adobo with 150g garlic rice',
  '60g rolled oats, 1 banana, and 1 scoop whey protein',
] as const;

const MEAL_SCAN_MAX_DIMENSION = 640;
const MEAL_SCAN_JPEG_QUALITY = 0.72;
const CLIENT_SCAN_CACHE_LIMIT = 16;
const SPECULATIVE_SCAN_DEBOUNCE_MS = 600;

const QUALITATIVE_REFINE_PATTERN =
  /\b(and|or|then|plus|with|instead|swap|replace|trimmed|boneless|skinless|fried|grilled|steamed|boiled|baked|roasted|raw|cooked)\b/i;

function findSingleTargetIndex(items: AiDraftItem[], targetQuery: string): number {
  const q = targetQuery.trim().toLowerCase();
  if (!q) return -1;
  if (q === 'it' || q === 'this' || q === 'meal') {
    return items.length === 1 ? 0 : -1;
  }

  const exactIdx = items.findIndex((it) => it.name.trim().toLowerCase() === q);
  if (exactIdx !== -1) return exactIdx;

  const qTokens = q.split(/\s+/).filter(Boolean);
  const matchedIndices: number[] = [];
  items.forEach((it, idx) => {
    const nameLower = it.name.toLowerCase();
    if (nameLower.includes(q) || qTokens.every((t) => nameLower.includes(t))) {
      matchedIndices.push(idx);
    }
  });

  return matchedIndices.length === 1 ? matchedIndices[0] : -1;
}

/**
 * Resolves unambiguous single-intent portion/removal instructions locally in 0ms
 * without an LLM round-trip. Returns null for qualitative or ambiguous instructions.
 */
export function tryDeterministicRefine(
  items: AiDraftItem[],
  instruction: string
): AiDraftItem[] | null {
  const raw = instruction.trim().replace(/[.!]+$/, '').trim();
  if (!raw || items.length === 0 || QUALITATIVE_REFINE_PATTERN.test(raw)) {
    return null;
  }

  // 1. Remove / delete / drop / without an item
  const removeMatch = raw.match(
    /^(?:please\s+)?(?:remove|delete|drop|omit|without|no)\s+(?:the\s+)?([a-z0-9\s()-]+)$/i
  );
  if (removeMatch && items.length > 1) {
    const idx = findSingleTargetIndex(items, removeMatch[1]);
    if (idx !== -1) {
      return items.filter((_, i) => i !== idx);
    }
  }

  // 2. Explicit gram assignment (e.g. "make the chicken 200g", "set it to 250 grams")
  const gramMatch = raw.match(
    /^(?:please\s+)?(?:make|set|change|update)\s+(?:the\s+)?([a-z0-9\s()-]+?)\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*(?:g|grams?)$/i
  );
  if (gramMatch) {
    const grams = parseFloat(gramMatch[2]);
    if (Number.isFinite(grams) && grams > 0) {
      const idx = findSingleTargetIndex(items, gramMatch[1]);
      if (idx !== -1) {
        return items.map((it, i) => (i === idx ? { ...it, grams } : it));
      }
    }
  }

  // 3. Multiplier scaling (e.g. "double the rice", "halve the butter")
  const scaleMatch = raw.match(
    /^(?:please\s+)?(double|triple|halve|half)\s+(?:the\s+)?([a-z0-9\s()-]+)$/i
  );
  if (scaleMatch) {
    const verb = scaleMatch[1].toLowerCase();
    const factor = verb === 'double' ? 2 : verb === 'triple' ? 3 : 0.5;
    const idx = findSingleTargetIndex(items, scaleMatch[2]);
    if (idx !== -1) {
      return items.map((it, i) => {
        if (i !== idx) return it;
        const nextGrams = Math.max(1, Math.round(it.grams * factor * 10) / 10);
        return { ...it, grams: nextGrams };
      });
    }
  }

  return null;
}

function cloneDraftItems(items: AiDraftItem[]): AiDraftItem[] {
  return items.map((it) => ({
    ...it,
    per100g: { ...it.per100g },
    microsPer100g: it.microsPer100g ? { ...it.microsPer100g } : {},
  }));
}

export interface AiMealScannerSheetProps {
  open: boolean;
  date?: string;
  mealSlot?: string;
  enableSpeculativeScan?: boolean;
  onClose: () => void;
}

export function AiMealScannerSheet({
  open,
  date,
  mealSlot,
  enableSpeculativeScan,
  onClose,
}: AiMealScannerSheetProps) {
  const storeDate = useLoggerStore((s) => s.activeDate);
  const storeMealSlot = useLoggerStore((s) => s.activeMealSlot);
  const effectiveDate = date ?? storeDate ?? getTodayIsoDate();
  const effectiveMealSlot = mealSlot ?? storeMealSlot ?? 'log';

  const aiDraft = useLoggerStore((s) => s.aiDraft);
  const setAiDraft = useLoggerStore((s) => s.setAiDraft);
  const resetDraft = useLoggerStore((s) => s.resetDraft);
  const syncAuthLocked = useLoggerStore((s) => s.syncAuthLocked);

  // Stage 1 Local State
  const [inputMode, setInputMode] = useState<'photo' | 'text'>('photo');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [contextPrompt, setContextPrompt] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  // Stage 2 Refinement & Verification State
  const [refineInstruction, setRefineInstruction] = useState('');
  const [isRefining, setIsRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);

  // Verification / Swap Modal & Save as Recipe Modal State
  const [isSwapModalOpen, setIsSwapModalOpen] = useState(false);
  const [swapTargetItem, setSwapTargetItem] = useState<AiDraftItem | null>(null);
  const [isRecipeBuilderOpen, setIsRecipeBuilderOpen] = useState(false);
  const [recipeSeedIngredients, setRecipeSeedIngredients] = useState<
    CustomRecipeIngredient[] | null
  >(null);
  const [showMicros, setShowMicros] = useState(false);

  // User explicitly wants to re-scan with a new photo
  const [isRescanning, setIsRescanning] = useState(false);
  const [isSubmittingLog, setIsSubmittingLog] = useState(false);
  const [draftRevision, setDraftRevision] = useState(0);

  const shouldSpeculate = enableSpeculativeScan ?? process.env.NODE_ENV !== 'test';
  const scanCacheRef = useRef<Map<string, AiDraftItem[]>>(new Map());
  const inFlightScanRef = useRef<{
    key: string;
    promise: Promise<AiDraftItem[]>;
    controller: AbortController;
    isSpeculative: boolean;
  } | null>(null);

  // Sync draft data into local stage 1 state if present
  const [prevDraft, setPrevDraft] = useState(aiDraft);
  if (aiDraft !== prevDraft) {
    setPrevDraft(aiDraft);
    if (aiDraft?.imageDataUrl) {
      setImageDataUrl(aiDraft.imageDataUrl);
      setInputMode('photo');
    } else if (aiDraft && !aiDraft.imageDataUrl && aiDraft.contextPrompt) {
      setInputMode('text');
    }
    if (aiDraft?.contextPrompt) {
      setContextPrompt(aiDraft.contextPrompt);
    }
  }

  // Reset transient local state when sheet closes
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setIsAnalyzing(false);
      setIsRefining(false);
      setScanError(null);
      setRefineError(null);
      setRefineInstruction('');
      setIsSwapModalOpen(false);
      setSwapTargetItem(null);
      setIsRecipeBuilderOpen(false);
      setRecipeSeedIngredients(null);
      setIsRescanning(false);
      setIsSubmittingLog(false);
      if (!aiDraft) {
        setInputMode('photo');
        setImageDataUrl(null);
        setContextPrompt('');
      }
    }
  }

  // Decide active stage:
  // 1) Stage 1 (Image Intake or Text-Only Describe Meal): no draft items (or rescanning) and no image yet
  // 2) Stage 2 (Pre-Scan HITL): image captured, user describes what's in it before vision scan
  // 3) Stage 3 (Post-Scan Review): draft items present and not rescanning
  const hasDraftItems = Boolean(aiDraft && aiDraft.items && aiDraft.items.length > 0);
  const showReviewStage = hasDraftItems && !isRescanning;
  const showPreScanHitl = !showReviewStage && Boolean(imageDataUrl);

  const executeMealScan = useCallback(
    async (
      imgUrl: string | null,
      ctxPrompt: string,
      speculative: boolean
    ): Promise<AiDraftItem[]> => {
      const trimmedImg = imgUrl ? imgUrl.trim() : '';
      const trimmedPrompt = ctxPrompt.trim();
      const cacheKey = `${trimmedImg || 'text-only'}::${trimmedPrompt}`;

      const cached = scanCacheRef.current.get(cacheKey);
      if (cached) {
        return cloneDraftItems(cached);
      }

      const activeInFlight = inFlightScanRef.current;
      if (activeInFlight && activeInFlight.key === cacheKey) {
        if (!speculative) {
          activeInFlight.isSpeculative = false;
        }
        const items = await activeInFlight.promise;
        return cloneDraftItems(items);
      }

      if (activeInFlight) {
        activeInFlight.controller.abort();
        inFlightScanRef.current = null;
      }

      const controller = new AbortController();
      const promise = (async (): Promise<AiDraftItem[]> => {
        const requestBody: { imageDataUrl?: string; contextPrompt?: string } = {};
        if (trimmedImg) {
          requestBody.imageDataUrl = trimmedImg;
        }
        if (trimmedPrompt || trimmedImg) {
          requestBody.contextPrompt = trimmedPrompt;
        }

        const res = await fetch('/api/ai/meal-scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        const data = await res.json().catch(() => ({}));

        if (res.status === 401) {
          useLoggerStore.getState().setSyncAuthLocked(true);
          throw new Error(
            data.error || 'Sync & AI locked. Enter your passphrase below to unlock and retry.'
          );
        }

        if (!res.ok) {
          throw new Error(data.error || `Meal scan failed with status ${res.status}`);
        }

        if (!Array.isArray(data.items) || data.items.length === 0) {
          throw new Error(
            'No food items detected. Please try again or add items manually.'
          );
        }

        const itemsWithIds: AiDraftItem[] = data.items.map((it: Partial<AiDraftItem>) => ({
          id: it.id || generateId(),
          name: it.name || 'Unknown food',
          grams: typeof it.grams === 'number' && it.grams > 0 ? it.grams : 100,
          per100g: {
            calories: it.per100g?.calories ?? 0,
            protein: it.per100g?.protein ?? 0,
            carbs: it.per100g?.carbs ?? 0,
            fat: it.per100g?.fat ?? 0,
            fiber: it.per100g?.fiber ?? 0,
          },
          microsPer100g: it.microsPer100g || {},
          verifiedSource: null,
        }));

        if (scanCacheRef.current.has(cacheKey)) {
          scanCacheRef.current.delete(cacheKey);
        } else if (scanCacheRef.current.size >= CLIENT_SCAN_CACHE_LIMIT) {
          const oldestKey = scanCacheRef.current.keys().next().value;
          if (oldestKey !== undefined) {
            scanCacheRef.current.delete(oldestKey);
          }
        }
        scanCacheRef.current.set(cacheKey, cloneDraftItems(itemsWithIds));

        return itemsWithIds;
      })().finally(() => {
        if (inFlightScanRef.current?.controller === controller) {
          inFlightScanRef.current = null;
        }
      });

      inFlightScanRef.current = {
        key: cacheKey,
        promise,
        controller,
        isSpeculative: speculative,
      };

      const items = await promise;
      return cloneDraftItems(items);
    },
    []
  );

  // Abort in-flight requests when sheet closes or unmounts
  useEffect(() => {
    if (!open && inFlightScanRef.current) {
      inFlightScanRef.current.controller.abort();
      inFlightScanRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if (inFlightScanRef.current) {
        inFlightScanRef.current.controller.abort();
        inFlightScanRef.current = null;
      }
    };
  }, []);

  // Warm staples dataset while the scanner sheet is open
  useEffect(() => {
    if (!open || !shouldSpeculate) return;
    loadStaples().catch(() => {
      // Non-fatal preload
    });
  }, [open, shouldSpeculate]);

  // Speculative pre-scan while user reviews preview / types context in Stage 2
  useEffect(() => {
    if (!shouldSpeculate || !open || !showPreScanHitl || !imageDataUrl) {
      return;
    }

    const trimmed = contextPrompt.trim();
    const cacheKey = `${imageDataUrl}::${trimmed}`;
    if (
      scanCacheRef.current.has(cacheKey) ||
      inFlightScanRef.current?.key === cacheKey
    ) {
      return;
    }

    const timer = setTimeout(() => {
      executeMealScan(imageDataUrl, trimmed, true).catch(() => {
        // Ignore speculative errors silently; user clicks Analyze Meal for explicit scan & error feedback
      });
    }, SPECULATIVE_SCAN_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [shouldSpeculate, open, showPreScanHitl, imageDataUrl, contextPrompt, executeMealScan]);

  // Escape key listener to close sheet (guarded when swap modal or recipe builder modal is open)
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isSwapModalOpen || isRecipeBuilderOpen) return;
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, isSwapModalOpen, isRecipeBuilderOpen, onClose]);

  // Stage 2: Item manipulation (cleanly updates useLoggerStore.aiDraft locally)
  const handleChangeGrams = useCallback(
    (itemId: string, newGrams: number) => {
      const currentDraft = useLoggerStore.getState().aiDraft;
      if (!currentDraft) return;
      setAiDraft({
        ...currentDraft,
        items: currentDraft.items.map((it) =>
          it.id === itemId ? { ...it, grams: newGrams } : it
        ),
      });
    },
    [setAiDraft]
  );

  const handleDeleteItem = useCallback(
    (itemId: string) => {
      const currentDraft = useLoggerStore.getState().aiDraft;
      if (!currentDraft) return;
      setAiDraft({
        ...currentDraft,
        items: currentDraft.items.filter((it) => it.id !== itemId),
      });
    },
    [setAiDraft]
  );

  const handleOpenSwapModal = useCallback((item: AiDraftItem) => {
    setSwapTargetItem(item);
    setIsSwapModalOpen(true);
  }, []);

  const handleSwapItem = useCallback(
    (
      targetItemId: string,
      verifiedItem: {
        name: string;
        per100g: MacroNutrients;
        microsPer100g?: Micronutrients;
        verifiedSource: string;
        verifiedFoodId: string;
      }
    ) => {
      const currentDraft = useLoggerStore.getState().aiDraft;
      if (!currentDraft) return;
      setAiDraft({
        ...currentDraft,
        items: currentDraft.items.map((it) =>
          it.id === targetItemId
            ? {
                ...it,
                name: verifiedItem.name,
                per100g: verifiedItem.per100g,
                microsPer100g: verifiedItem.microsPer100g,
                verifiedSource: verifiedItem.verifiedSource,
                verifiedFoodId: verifiedItem.verifiedFoodId,
                // row's current it.grams is preserved!
              }
            : it
        ),
      });
    },
    [setAiDraft]
  );

  const handleAddCustomItem = useCallback(
    (newItem: AiDraftItem) => {
      const currentDraft = useLoggerStore.getState().aiDraft || {
        imageDataUrl: null,
        contextPrompt: '',
        items: [],
      };
      setAiDraft({
        ...currentDraft,
        items: [...currentDraft.items, newItem],
      });
    },
    [setAiDraft]
  );

  // Memoize Stage 3 macro + 12-micronutrient + 6-extended-nutrient totals
  const draftItems = aiDraft?.items;
  const { totalCalories, totalProtein, totalCarbs, totalFat, totalFiber, totalMicros } =
    useMemo(() => {
      let calories = 0;
      let protein = 0;
      let carbs = 0;
      let fat = 0;
      let fiber = 0;
      const microsMap: Record<string, number> = {};
      for (const key of Object.keys(RDA_MICRONUTRIENT_METADATA)) {
        microsMap[key] = 0;
      }
      for (const ext of STAGE3_EXTENDED_NUTRIENTS) {
        microsMap[ext.key] = 0;
      }

      if (draftItems) {
        for (const item of draftItems) {
          const { macros, micros } = scaleNutrition(
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
          for (const [k, v] of Object.entries(micros)) {
            if (typeof v === 'number' && Number.isFinite(v)) {
              microsMap[k] = (microsMap[k] ?? 0) + v;
            }
          }
        }
      }

      return {
        totalCalories: calories,
        totalProtein: protein,
        totalCarbs: carbs,
        totalFat: fat,
        totalFiber: fiber,
        totalMicros: microsMap,
      };
    }, [draftItems]);

  if (!open) return null;

  // Image upload handling (Stage 1)
  const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setScanError(null);
      const compressed = await compressImageToJpeg(
        file,
        MEAL_SCAN_MAX_DIMENSION,
        MEAL_SCAN_JPEG_QUALITY
      );
      setImageDataUrl(compressed);
    } catch (err: unknown) {
      console.error('Failed to compress image:', err);
      setScanError('Failed to process image. Please try again with another photo.');
    }
  };

  // Analyze meal POST /api/ai/meal-scan (Photo or Describe Meal text-only mode)
  const handleAnalyzeMeal = async () => {
    const trimmedContext = contextPrompt.trim();
    const effectiveImage = inputMode === 'text' ? null : imageDataUrl;
    if (!effectiveImage && !trimmedContext) return;

    setIsAnalyzing(true);
    setScanError(null);

    try {
      const itemsWithIds = await executeMealScan(effectiveImage, trimmedContext, false);

      setAiDraft({
        imageDataUrl: effectiveImage,
        contextPrompt: trimmedContext,
        items: itemsWithIds,
      });
      setIsRescanning(false);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to analyze meal';
      setScanError(msg);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Manual draft creation without photo
  const handleStartManualDraft = () => {
    setImageDataUrl(null);
    setContextPrompt('');
    setScanError(null);
    setAiDraft({
      imageDataUrl: null,
      contextPrompt: '',
      items: [],
    });
    setSwapTargetItem(null);
    setIsSwapModalOpen(true);
    setIsRescanning(false);
  };

  // Conversational Refine with AI POST /api/ai/refine (with 0ms deterministic fast-path)
  const handleRefineAi = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const instruction = refineInstruction.trim();
    if (!instruction || !aiDraft || aiDraft.items.length === 0 || isRefining) return;

    const deterministicItems = tryDeterministicRefine(aiDraft.items, instruction);
    if (deterministicItems) {
      setRefineError(null);
      setAiDraft({
        ...aiDraft,
        items: deterministicItems,
      });
      setDraftRevision((r) => r + 1);
      setRefineInstruction('');
      return;
    }

    setIsRefining(true);
    setRefineError(null);

    try {
      const res = await fetch('/api/ai/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: aiDraft.items,
          instruction,
          contextPrompt: aiDraft.contextPrompt,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 401) {
        useLoggerStore.getState().setSyncAuthLocked(true);
        throw new Error(
          data.error || 'Sync & AI locked. Enter your passphrase below to unlock and retry.'
        );
      }

      if (!res.ok) {
        throw new Error(data.error || `Refinement failed with status ${res.status}`);
      }

      if (!Array.isArray(data.items)) {
        throw new Error('Invalid response received from refinement service');
      }

      const refinedItems: AiDraftItem[] = data.items.map((it: Partial<AiDraftItem>) => ({
        id: it.id || generateId(),
        name: it.name || 'Refined item',
        grams: typeof it.grams === 'number' && it.grams > 0 ? it.grams : 100,
        per100g: {
          calories: it.per100g?.calories ?? 0,
          protein: it.per100g?.protein ?? 0,
          carbs: it.per100g?.carbs ?? 0,
          fat: it.per100g?.fat ?? 0,
          fiber: it.per100g?.fiber ?? 0,
        },
        microsPer100g: it.microsPer100g || {},
        verifiedSource: it.verifiedSource ?? null,
        verifiedFoodId: it.verifiedFoodId,
      }));

      setAiDraft({
        ...aiDraft,
        items: refinedItems,
      });
      setDraftRevision((r) => r + 1);
      setRefineInstruction('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to refine meal';
      setRefineError(msg);
    } finally {
      setIsRefining(false);
    }
  };

  // Separate Save as Recipe action in Stage 3
  const handleSaveAsRecipe = () => {
    if (!aiDraft || aiDraft.items.length === 0) return;

    const ingredients: CustomRecipeIngredient[] = aiDraft.items.map((item) => {
      const safeGrams =
        typeof item.grams === 'number' && Number.isFinite(item.grams) && item.grams > 0
          ? item.grams
          : 100;
      const scaled = scaleNutrition(
        item.per100g,
        item.microsPer100g ?? {},
        'per100g',
        safeGrams
      );

      return {
        foodId: item.verifiedFoodId || item.id,
        name: item.name,
        amount: safeGrams,
        unit: 'g',
        gramWeight: safeGrams,
        gramsPerUnit: 1,
        baseBasis: 'per100g',
        baseNutrients: { ...item.per100g },
        baseMicros: { ...(item.microsPer100g ?? {}) },
        nutritionSnapshot: {
          ...scaled.macros,
          micros: scaled.micros,
        },
      };
    });

    setRecipeSeedIngredients(ingredients);
    setIsRecipeBuilderOpen(true);
  };

  // Confirm & Log: Dexie bulkAdd in one transaction
  const handleConfirmAndLog = async () => {
    if (!aiDraft || aiDraft.items.length === 0 || isSubmittingLog) return;

    setIsSubmittingLog(true);
    try {
      const now = Date.now();
      const entries: FoodLogEntry[] = aiDraft.items.map((item) => {
        const scaled = scaleNutrition(
          item.per100g,
          item.microsPer100g ?? {},
          'per100g',
          item.grams
        );

        const validSource: FoodSource =
          item.verifiedSource === 'staple' ||
          item.verifiedSource === 'usda' ||
          item.verifiedSource === 'off' ||
          item.verifiedSource === 'custom_barcode' ||
          item.verifiedSource === 'custom_food' ||
          item.verifiedSource === 'quick_add' ||
          item.verifiedSource === 'recipe'
            ? item.verifiedSource
            : 'ai_scan';

        return {
          id: generateId(),
          date: effectiveDate,
          mealSlot: effectiveMealSlot,
          foodId: item.verifiedFoodId || item.id,
          name: item.name,
          source: validSource,
          amount: item.grams,
          unit: 'g',
          nutritionSnapshot: {
            ...scaled.macros,
            micros: scaled.micros,
          },
          createdAt: now,
        };
      });

      await db.transaction('rw', db.foodLogs, async () => {
        await db.foodLogs.bulkAdd(entries);
      });

      resetDraft();
      setInputMode('photo');
      setImageDataUrl(null);
      setContextPrompt('');
      setRefineInstruction('');
      setScanError(null);
      setRefineError(null);
      setIsSwapModalOpen(false);
      setSwapTargetItem(null);
      setIsRecipeBuilderOpen(false);
      setRecipeSeedIngredients(null);
      setIsRescanning(false);
      onClose();
    } catch (err) {
      console.error('Failed to log meal entries:', err);
    } finally {
      setIsSubmittingLog(false);
    }
  };

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="AI Meal Scanner"
        data-testid="ai-meal-scanner-sheet"
        className="fixed inset-0 z-50 flex flex-col justify-end sm:items-center sm:justify-center sm:p-6 bg-black/70 backdrop-blur-xs animate-backdrop-in"
        onClick={onClose}
      >
        <div
          className="w-full max-w-lg mx-auto surface-elevated-sheet rounded-t-3xl sm:rounded-3xl px-4 sm:px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-5 animate-sheet-in sm:animate-modal-in max-h-[92dvh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="w-9 h-1 rounded-full bg-border mx-auto mb-3 shrink-0 sm:hidden" aria-hidden="true" />
          {/* Header */}
          <div className="flex items-center justify-between pb-3 border-b border-border">
            <div className="flex items-center gap-2.5">
              {showPreScanHitl ? (
                <button
                  type="button"
                  onClick={() => {
                    setImageDataUrl(null);
                    setScanError(null);
                  }}
                  aria-label="Back to photo upload"
                  className="touch-target tactile-press w-8 h-8 rounded-full bg-surface-sub border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-card"
                  title="Choose a different photo"
                >
                  <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                </button>
              ) : (
                <div className="w-8 h-8 rounded-xl bg-[var(--macro-calories)]/15 flex items-center justify-center text-[var(--macro-calories)]">
                  <Sparkles className="w-4 h-4" aria-hidden="true" />
                </div>
              )}
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  {showReviewStage
                    ? 'Review AI Meal'
                    : showPreScanHitl
                      ? "What's in this meal?"
                      : 'AI Meal Scanner'}
                </h2>
                <p className="text-[11px] text-muted-foreground">
                  Logging for {effectiveDate}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {showReviewStage && (
                <button
                  type="button"
                  onClick={() => {
                    if (aiDraft && !aiDraft.imageDataUrl && aiDraft.contextPrompt) {
                      setInputMode('text');
                    }
                    setIsRescanning(true);
                  }}
                  aria-label="Re-scan or take new photo"
                  className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub mr-0.5"
                  title="Edit meal context / re-scan"
                >
                  <RotateCcw className="w-4 h-4" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close AI scanner"
                className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Body: Stage 1 (Photo or Describe Meal Text Intake) -> Stage 2 (Pre-Scan HITL) -> Stage 3 (Review) */}
          {!showReviewStage && !showPreScanHitl ? (
            /* STAGE 1: Photo or Text-Only Meal Description Intake */
            <div className="pt-3.5 flex-1 overflow-y-auto overscroll-contain space-y-4">
              {/* Segmented Mode Toggle: Photo | Describe Meal */}
              <div
                role="tablist"
                aria-label="Meal scan input mode"
                className="grid grid-cols-2 gap-1.5 p-1 bg-surface-sub rounded-full border border-border/60"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={inputMode === 'photo'}
                  onClick={() => {
                    setInputMode('photo');
                    setScanError(null);
                  }}
                  className={`tactile-press flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-full text-xs transition-colors ${
                    inputMode === 'photo'
                      ? 'bg-foreground text-background font-semibold shadow-xs'
                      : 'text-muted-foreground hover:text-foreground font-medium'
                  }`}
                >
                  <Camera className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Photo</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={inputMode === 'text'}
                  onClick={() => {
                    setInputMode('text');
                    setImageDataUrl(null);
                    setScanError(null);
                  }}
                  className={`tactile-press flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-full text-xs transition-colors ${
                    inputMode === 'text'
                      ? 'bg-foreground text-background font-semibold shadow-xs'
                      : 'text-muted-foreground hover:text-foreground font-medium'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Describe Meal</span>
                </button>
              </div>

              {syncAuthLocked && (
                <SyncUnlockCard
                  compact
                  onUnlocked={() => {
                    setScanError(null);
                  }}
                />
              )}

              {scanError && !syncAuthLocked && (
                <div className="p-3 rounded-xl bg-surface-sub border border-border text-[var(--neutral-over)] text-xs flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="flex-1 space-y-1">
                    <p>{scanError}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Check your AI configuration in Settings, retry with a clearer description or photo, or log items manually below.
                    </p>
                  </div>
                </div>
              )}

              {inputMode === 'photo' ? (
                <div className="space-y-3">
                  <div
                    onClick={() => uploadInputRef.current?.click()}
                    className="w-full rounded-2xl border-2 border-dashed border-border hover:border-[var(--macro-calories)]/60 bg-surface-sub/50 flex flex-col items-center justify-center p-5 transition-colors cursor-pointer"
                  >
                    <div className="w-12 h-12 rounded-full bg-[var(--macro-calories)]/15 flex items-center justify-center text-[var(--macro-calories)] mb-2.5">
                      <Camera className="w-6 h-6" aria-hidden="true" />
                    </div>
                    <span className="text-xs font-semibold text-foreground">
                      Take photo or upload image
                    </span>
                    <span className="text-[11px] text-muted-foreground mt-1 text-center">
                      Next, tell the AI what&apos;s in your meal before scanning for higher accuracy
                    </span>

                    <div
                      className="grid grid-cols-2 gap-2.5 w-full mt-4"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => cameraInputRef.current?.click()}
                        className="tactile-press py-2.5 px-3 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 flex items-center justify-center gap-1.5 shadow-xs"
                      >
                        <Camera className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Take Photo</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => uploadInputRef.current?.click()}
                        className="tactile-press py-2.5 px-3 rounded-full bg-card border border-border text-foreground hover:bg-surface-sub font-semibold text-xs flex items-center justify-center gap-1.5 shadow-xs"
                      >
                        <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Upload Photo</span>
                      </button>
                    </div>
                  </div>

                  {/* Hidden camera input (with capture="environment") */}
                  <input
                    ref={cameraInputRef}
                    id="meal-camera-capture"
                    data-testid="meal-camera-input"
                    type="file"
                    accept="image/*"
                    capture="environment"
                    aria-label="Camera capture input"
                    onChange={handleImageFileChange}
                    className="sr-only"
                  />

                  {/* Hidden gallery/upload input (no capture attribute so mobile galleries work) */}
                  <input
                    ref={uploadInputRef}
                    id="meal-photo-upload"
                    type="file"
                    accept="image/*"
                    aria-label="Upload meal photo"
                    onChange={handleImageFileChange}
                    className="sr-only"
                  />
                </div>
              ) : (
                /* Describe Meal (Text-Only Mode â€” strictly no voice/microphone UI) */
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="meal-text-description"
                      className="text-xs font-semibold text-foreground flex items-center justify-between"
                    >
                      <span>Describe what you ate</span>
                      <span className="text-[10px] font-medium text-muted-foreground">
                        Text-only AI estimate
                      </span>
                    </label>
                    <textarea
                      id="meal-text-description"
                      value={contextPrompt}
                      onChange={(e) => setContextPrompt(e.target.value)}
                      placeholder="Describe your meal (e.g., 2 boiled eggs, 150g white rice, and 1 cup black coffee)..."
                      rows={4}
                      autoFocus
                      className="w-full p-3 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:outline-none focus:border-border-focus text-foreground placeholder:text-muted-foreground/60 resize-none"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Include approximate weights, counts, brands, cooking oils, or sauces. You can review and adjust every ingredient before logging.
                    </p>
                  </div>

                  {/* Quick example chips */}
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-medium text-muted-foreground block">
                      Quick examples:
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {TEXT_MEAL_EXAMPLES.map((example) => (
                        <button
                          key={example}
                          type="button"
                          onClick={() => setContextPrompt(example)}
                          className="tactile-press text-left px-2.5 py-1 rounded-full bg-surface-sub border border-border/60 text-[11px] text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
                        >
                          {example}
                        </button>
                      ))}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleAnalyzeMeal}
                    disabled={!contextPrompt.trim() || isAnalyzing}
                    className="tactile-press w-full py-3 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 shadow-xs"
                  >
                    {isAnalyzing ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Analyzing meal description...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4" />
                        <span>Analyze Meal</span>
                      </>
                    )}
                  </button>
                </div>
              )}

              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={handleStartManualDraft}
                  className="text-xs text-muted-foreground hover:text-foreground font-medium underline-offset-4 hover:underline"
                >
                  Skip photo &amp; log ingredients manually
                </button>
              </div>
            </div>
          ) : !showReviewStage && showPreScanHitl ? (
            /* STAGE 2: Pre-Scan Human-in-the-Loop Context */
            <div className="pt-4 flex-1 overflow-y-auto overscroll-contain space-y-4">
              {syncAuthLocked && (
                <SyncUnlockCard
                  compact
                  onUnlocked={() => {
                    setScanError(null);
                  }}
                />
              )}

              {scanError && !syncAuthLocked && (
                <div className="p-3 rounded-xl bg-surface-sub border border-border text-[var(--neutral-over)] text-xs flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="flex-1 space-y-1">
                    <p>{scanError}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Check your AI configuration in Settings, retry with a clearer photo, or skip to manual entry below.
                    </p>
                  </div>
                </div>
              )}

              {/* Captured Photo Preview (tap to replace) */}
              <div>
                <label
                  htmlFor="meal-photo-upload"
                  aria-label="Upload meal photo"
                  className="block cursor-pointer"
                >
                  <div className="relative rounded-2xl overflow-hidden border border-border group">
                    <img
                      src={imageDataUrl ?? undefined}
                      alt="Meal preview"
                      className="w-full h-44 object-cover"
                    />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 text-white text-xs font-medium">
                      <Upload className="w-4 h-4" />
                      <span>Change Photo</span>
                    </div>
                  </div>
                  <input
                    id="meal-photo-upload"
                    type="file"
                    accept="image/*"
                    aria-label="Upload meal photo"
                    onChange={handleImageFileChange}
                    className="sr-only"
                  />
                </label>
              </div>

              {/* Human-in-the-Loop Pre-Scan Prompt */}
              <div className="space-y-1.5">
                <label
                  htmlFor="meal-context-prompt"
                  className="text-xs font-semibold text-foreground flex items-center justify-between"
                >
                  <span>Tell AI what&apos;s in the meal</span>
                  <span className="text-[10px] font-medium text-primary">
                    Before vision scan
                  </span>
                </label>
                <textarea
                  id="meal-context-prompt"
                  value={contextPrompt}
                  onChange={(e) => setContextPrompt(e.target.value)}
                  placeholder="List ingredients, cooking oil, sauces, prep style, or weights (e.g. 2 tbsp olive oil, grilled chicken breast, basmati rice)..."
                  rows={3}
                  autoFocus
                  className="w-full p-3 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:outline-none focus:border-border-focus text-foreground placeholder:text-muted-foreground/60 resize-none"
                />
                <p className="text-[10px] text-muted-foreground">
                  The AI combines your notes with the photo so hidden oils, sauces, and ingredients aren&apos;t guessed wrong.
                </p>
              </div>

              {/* Action Buttons */}
              <div className="pt-1 space-y-2">
                <button
                  type="button"
                  onClick={handleAnalyzeMeal}
                  disabled={!imageDataUrl || isAnalyzing}
                  className="tactile-press w-full py-3 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 shadow-xs"
                >
                  {isAnalyzing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Analyzing meal with your notes...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>Analyze Meal</span>
                    </>
                  )}
                </button>

                <div className="text-center pt-1">
                  <button
                    type="button"
                    onClick={handleStartManualDraft}
                    className="text-xs text-muted-foreground hover:text-foreground font-medium underline-offset-4 hover:underline"
                  >
                    Skip photo &amp; log ingredients manually
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* STAGE 3: Post-Scan Interactive HITL Review */
            <div className="pt-3 flex-1 flex flex-col min-h-0">
              {/* Summary Totals Banner */}
              <div className="bg-surface-sub rounded-2xl p-3 border border-border mb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                  {aiDraft?.imageDataUrl && (
                    <img
                      src={aiDraft.imageDataUrl}
                      alt="Scanned meal thumbnail"
                      className="w-12 h-12 rounded-xl object-cover border border-border shrink-0"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-1">
                      <span
                        data-testid="hitl-total-calories"
                        className="text-xl font-bold text-[var(--macro-calories)] tabular-nums tracking-tight"
                      >
                        {Math.round(totalCalories)}
                      </span>
                      <span className="text-xs font-semibold text-muted-foreground">kcal</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground">Total estimated meal nutrition</p>
                  </div>
                </div>

                <div className="grid grid-cols-4 sm:flex sm:items-center gap-2 sm:gap-2.5 text-center sm:text-right text-xs tabular-nums text-muted-foreground border-t sm:border-t-0 border-border/50 pt-2 sm:pt-0">
                  <div>
                    <span className="block font-bold text-[var(--macro-protein)]">{Math.round(totalProtein * 10) / 10}g</span>
                    <span className="text-[10px] uppercase">Prot</span>
                  </div>
                  <div>
                    <span className="block font-bold text-[var(--macro-carbs)]">{Math.round(totalCarbs * 10) / 10}g</span>
                    <span className="text-[10px] uppercase">Carb</span>
                  </div>
                  <div>
                    <span className="block font-bold text-[var(--macro-fat)]">{Math.round(totalFat * 10) / 10}g</span>
                    <span className="text-[10px] uppercase">Fat</span>
                  </div>
                  <div>
                    <span className="block font-bold text-[var(--macro-fiber)]" data-testid="hitl-total-fiber">{Math.round(totalFiber * 10) / 10}g</span>
                    <span className="text-[10px] uppercase">Fib</span>
                  </div>
                </div>
              </div>

              {/* Collapsible Estimated Micronutrients & Extended Summary */}
              <div className="mb-3 rounded-2xl bg-surface-sub/60 border border-border shrink-0">
                <button
                  type="button"
                  onClick={() => setShowMicros((prev) => !prev)}
                  aria-expanded={showMicros}
                  className="w-full px-3 py-2 flex items-center justify-between text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <span>Estimated Micronutrients &amp; Extended (18)</span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 transition-transform duration-200 ${
                      showMicros ? 'rotate-180 text-foreground' : ''
                    }`}
                    aria-hidden="true"
                  />
                </button>
                <div
                  className="accordion-grid"
                  data-open={showMicros ? 'true' : 'false'}
                  aria-hidden={!showMicros}
                >
                  <div className="accordion-inner">
                    <div
                      data-testid="hitl-micronutrients-grid"
                      className="px-3 pb-2.5 pt-1.5 border-t border-border/60 grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5 text-[11px] tabular-nums"
                    >
                      {Object.values(RDA_MICRONUTRIENT_METADATA).map((meta) => {
                        const val = Math.round((totalMicros[meta.key] ?? 0) * 10) / 10;
                        return (
                          <div key={meta.key} className="flex items-center justify-between gap-1">
                            <span className="text-muted-foreground truncate">{meta.name}</span>
                            <span className="font-semibold text-foreground shrink-0">
                              {val}{meta.unit}
                            </span>
                          </div>
                        );
                      })}
                      {STAGE3_EXTENDED_NUTRIENTS.map((meta) => {
                        const val = Math.round((totalMicros[meta.key] ?? 0) * 10) / 10;
                        return (
                          <div key={meta.key} className="flex items-center justify-between gap-1">
                            <span className="text-muted-foreground truncate">{meta.name}</span>
                            <span className="font-semibold text-foreground shrink-0">
                              {val}{meta.unit}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {syncAuthLocked && (
                <div className="mb-2 shrink-0">
                  <SyncUnlockCard
                    compact
                    onUnlocked={() => {
                      setRefineError(null);
                    }}
                  />
                </div>
              )}

              {/* Refine Error Banner */}
              {refineError && !syncAuthLocked && (
                <div className="mb-2 p-2.5 rounded-xl bg-surface-sub border border-border text-[var(--neutral-over)] text-xs flex items-start gap-2 shrink-0">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="flex-1 space-y-0.5">
                    <p>{refineError}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Edit ingredient weights directly below or retry with a shorter instruction.
                    </p>
                  </div>
                </div>
              )}

              {/* Ingredient Rows List */}
              <div className="flex-1 overflow-y-auto overscroll-contain space-y-2.5 pr-0.5">
                {aiDraft?.items.map((item) => (
                  <HitlIngredientRow
                    key={item.id}
                    item={item}
                    draftRevision={draftRevision}
                    onChangeGrams={handleChangeGrams}
                    onDeleteItem={handleDeleteItem}
                    onOpenVerifySwap={handleOpenSwapModal}
                  />
                ))}

                {/* Add Missing Ingredient Trigger */}
                <button
                  type="button"
                  onClick={() => {
                    setSwapTargetItem(null);
                    setIsSwapModalOpen(true);
                  }}
                  className="tactile-press w-full py-2.5 px-3 rounded-xl border border-dashed border-border hover:border-[var(--macro-calories)]/60 bg-surface-sub/40 hover:bg-surface-sub text-xs font-semibold text-muted-foreground hover:text-foreground flex items-center justify-center gap-2"
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Add Missing Ingredient</span>
                </button>
              </div>

              {/* Bottom Actions Area: Conversational Refine Bar + Separate Save as Recipe + Confirm & Log */}
              <div className="pt-3 mt-2 border-t border-border space-y-2.5 shrink-0">
                {/* Conversational "Refine with AI" Input Bar */}
                <form onSubmit={handleRefineAi} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={refineInstruction}
                    onChange={(e) => setRefineInstruction(e.target.value)}
                    placeholder="E.g., remove the cheese, make the chicken 200g..."
                    disabled={isRefining}
                    className="flex-1 px-3 py-2 text-base sm:text-xs rounded-xl bg-surface-sub border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground placeholder:text-muted-foreground/60"
                  />
                  <button
                    type="submit"
                    disabled={isRefining || !refineInstruction.trim()}
                    className="tactile-press px-3.5 py-2 rounded-full bg-card border border-border text-foreground hover:bg-surface-sub font-semibold text-xs disabled:opacity-50 flex items-center gap-1 shrink-0 shadow-xs"
                  >
                    {isRefining ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Send className="w-3.5 h-3.5 text-[var(--macro-calories)]" aria-hidden="true" />
                    )}
                    <span>Refine</span>
                  </button>
                </form>

                {/* Primary & Secondary Action Buttons */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSaveAsRecipe}
                    disabled={isSubmittingLog || !aiDraft?.items.length}
                    className="tactile-press py-2.5 px-4 rounded-full bg-surface-sub border border-border text-foreground hover:bg-card font-semibold text-xs disabled:opacity-50 flex items-center justify-center gap-1.5 shrink-0"
                  >
                    <ChefHat className="w-3.5 h-3.5 text-[var(--macro-calories)]" aria-hidden="true" />
                    <span>Save as Recipe</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleConfirmAndLog}
                    disabled={isSubmittingLog || !aiDraft?.items.length}
                    className="tactile-press flex-1 py-3 px-4 rounded-full bg-foreground text-background font-semibold text-xs hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 shadow-xs"
                  >
                    {isSubmittingLog ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Logging meal entries...</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Confirm &amp; Log</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Verification / Swap Modal */}
      {isSwapModalOpen && (
        <HitlVerificationSwapModal
          open={isSwapModalOpen}
          targetItem={swapTargetItem}
          onClose={() => {
            setIsSwapModalOpen(false);
            setSwapTargetItem(null);
          }}
          onSwapItem={handleSwapItem}
          onAddCustomItem={handleAddCustomItem}
        />
      )}

      {/* Save as Recipe Builder Modal */}
      {isRecipeBuilderOpen && (
        <RecipeBuilderModal
          isOpen={isRecipeBuilderOpen}
          initialIngredients={recipeSeedIngredients}
          onClose={() => {
            setIsRecipeBuilderOpen(false);
          }}
        />
      )}
    </>
  );
}
