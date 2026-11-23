import { z } from 'zod';

const MICRONUTRIENT_KEYS = [
  'sodiumMg',
  'potassiumMg',
  'calciumMg',
  'ironMg',
  'magnesiumMg',
  'zincMg',
  'vitaminAMcg',
  'vitaminCMg',
  'vitaminDMcg',
  'vitaminB6Mg',
  'vitaminB12Mcg',
  'folateMcg',
  'sugarG',
  'addedSugarG',
  'saturatedFatG',
  'cholesterolMg',
  'caffeineMg',
  'alcoholG',
] as const;

function coerceFiniteNumberInput(val: unknown): unknown {
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return val;
}

const positiveNumber = z.preprocess(coerceFiniteNumberInput, z.number().positive());
const nonNegativeNumber = z.preprocess(coerceFiniteNumberInput, z.number().nonnegative());

const defaultZeroNonNegativeNumber = z.preprocess(
  (val) => {
    const coerced = coerceFiniteNumberInput(val);
    return coerced === null || coerced === undefined ? 0 : coerced;
  },
  z.number().nonnegative()
);

const optionalNonNegativeNumber = z.preprocess(
  (val) => {
    const coerced = coerceFiniteNumberInput(val);
    return coerced === null || coerced === undefined ? undefined : coerced;
  },
  z.number().nonnegative().optional()
);

const optionalTrimmedString = z.preprocess((val) => {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return val;
}, z.string().optional());

function normalizeServingUnit(val: unknown): unknown {
  if (typeof val !== 'string') return val;
  const cleaned = val.trim().toLowerCase();
  if (cleaned === 'g' || cleaned === 'gram' || cleaned === 'grams') return 'g';
  if (cleaned === 'ml' || cleaned === 'milliliter' || cleaned === 'milliliters') return 'ml';
  if (cleaned === 'serving' || cleaned === 'servings') return 'serving';
  return cleaned;
}

function normalizeMealItemInput(val: unknown): unknown {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    return val;
  }
  const item = val as Record<string, unknown>;
  const per100g = item.per100g;
  if (!per100g || typeof per100g !== 'object' || Array.isArray(per100g)) {
    return val;
  }

  const per100gObj = per100g as Record<string, unknown>;
  const liftedMicros: Record<string, unknown> = {};
  let hasLifted = false;
  for (const key of MICRONUTRIENT_KEYS) {
    if (per100gObj[key] !== undefined && per100gObj[key] !== null) {
      liftedMicros[key] = per100gObj[key];
      hasLifted = true;
    }
  }

  if (!hasLifted) {
    return val;
  }

  const existingMicros =
    item.microsPer100g &&
    typeof item.microsPer100g === 'object' &&
    !Array.isArray(item.microsPer100g)
      ? (item.microsPer100g as Record<string, unknown>)
      : {};

  return {
    ...item,
    microsPer100g: {
      ...liftedMicros,
      ...existingMicros,
    },
  };
}

export const AiMacroNutrientsSchema = z.object({
  calories: nonNegativeNumber,
  protein: nonNegativeNumber,
  carbs: nonNegativeNumber,
  fat: nonNegativeNumber,
  fiber: defaultZeroNonNegativeNumber,
});

export const AiMicronutrientsSchema = z.object({
  sodiumMg: optionalNonNegativeNumber,
  potassiumMg: optionalNonNegativeNumber,
  calciumMg: optionalNonNegativeNumber,
  ironMg: optionalNonNegativeNumber,
  magnesiumMg: optionalNonNegativeNumber,
  zincMg: optionalNonNegativeNumber,
  vitaminAMcg: optionalNonNegativeNumber,
  vitaminCMg: optionalNonNegativeNumber,
  vitaminDMcg: optionalNonNegativeNumber,
  vitaminB6Mg: optionalNonNegativeNumber,
  vitaminB12Mcg: optionalNonNegativeNumber,
  folateMcg: optionalNonNegativeNumber,
  sugarG: optionalNonNegativeNumber,
  addedSugarG: optionalNonNegativeNumber,
  saturatedFatG: optionalNonNegativeNumber,
  cholesterolMg: optionalNonNegativeNumber,
  caffeineMg: optionalNonNegativeNumber,
  alcoholG: optionalNonNegativeNumber,
});

export const AiMealItemSchema = z.preprocess(
  normalizeMealItemInput,
  z.object({
    name: z.string().trim().min(1),
    grams: positiveNumber,
    per100g: AiMacroNutrientsSchema,
    microsPer100g: AiMicronutrientsSchema.nullable()
      .optional()
      .transform((v) => v ?? undefined),
  })
);

export const AiMealScanResponseSchema = z.preprocess(
  (val) => (Array.isArray(val) ? { items: val } : val),
  z.object({
    items: z.array(AiMealItemSchema).min(1),
  })
);

export const AiMealIdeaSchema = z.object({
  title: z.string().trim().min(1),
  prepMinutes: optionalNonNegativeNumber,
  summary: optionalTrimmedString,
  items: z.array(AiMealItemSchema).min(1),
});

export const AiMealIdeasResponseSchema = z.preprocess(
  (val) => (Array.isArray(val) ? { ideas: val } : val),
  z.object({
    ideas: z.array(AiMealIdeaSchema).min(1).max(6),
  })
);

export const AiLabelOcrResponseSchema = z.preprocess(
  (val) => (Array.isArray(val) && val.length === 1 ? val[0] : val),
  z.object({
    name: optionalTrimmedString,
    brand: optionalTrimmedString,
    servingSize: positiveNumber,
    servingUnit: z.preprocess(normalizeServingUnit, z.enum(['g', 'ml', 'serving'])),
    servingWeightGrams: optionalNonNegativeNumber,
    calories: nonNegativeNumber,
    protein: defaultZeroNonNegativeNumber,
    carbs: defaultZeroNonNegativeNumber,
    fat: defaultZeroNonNegativeNumber,
    fiber: optionalNonNegativeNumber,
    sodiumMg: optionalNonNegativeNumber,
    potassiumMg: optionalNonNegativeNumber,
    calciumMg: optionalNonNegativeNumber,
    ironMg: optionalNonNegativeNumber,
    vitaminCMg: optionalNonNegativeNumber,
    sugarG: optionalNonNegativeNumber,
    addedSugarG: optionalNonNegativeNumber,
    saturatedFatG: optionalNonNegativeNumber,
    cholesterolMg: optionalNonNegativeNumber,
    caffeineMg: optionalNonNegativeNumber,
    alcoholG: optionalNonNegativeNumber,
  })
);

export type AiMacroNutrients = z.infer<typeof AiMacroNutrientsSchema>;
export type AiMealItem = z.infer<typeof AiMealItemSchema>;
export type AiMealScanResponse = z.infer<typeof AiMealScanResponseSchema>;
export type AiMealIdea = z.infer<typeof AiMealIdeaSchema>;
export type AiMealIdeasResponse = z.infer<typeof AiMealIdeasResponseSchema>;
export type AiLabelOcrResponse = z.infer<typeof AiLabelOcrResponseSchema>;

/**
 * Strips markdown code fences, parses JSON, and strictly validates against a Zod schema.
 * Handles commentary/text both outside and inside code fences by finding outer JSON delimiters.
 */
export function parseAiJsonResponse<T>(rawText: string, schema: z.ZodType<T>): T {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('AI response is empty or not a string');
  }

  let text = rawText.trim();

  // Strip markdown code fences if present (e.g. ```json ... ``` or ``` ... ```)
  const codeFenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeFenceMatch) {
    text = codeFenceMatch[1].trim();
  }

  // Find outer JSON delimiters ({...} or [...]) to strip any commentary before/after inside or outside fences
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let startIdx = -1;
  let endIdx = -1;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endIdx = text.lastIndexOf('}');
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endIdx = text.lastIndexOf(']');
  }

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    text = text.slice(startIdx, endIdx + 1).trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse AI response as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
      .join(', ');
    throw new Error(`AI response failed schema validation: ${issues}`);
  }

  return result.data;
}
