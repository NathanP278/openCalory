import { z } from 'zod';
import { db } from './opencalory-db';
import { isCloudSyncEnabled, syncWithCentralDb } from './cloud-sync';
import type {
  FoodLogEntry,
  FoodItem,
  CustomRecipe,
  UserGoals,
  WeightLogEntry,
  PinnedFood,
} from '@/types/nutrition';

export const MacroNutrientsSchema = z.object({
  calories: z.number(),
  protein: z.number(),
  carbs: z.number(),
  fat: z.number(),
  fiber: z.number(),
});

export const MicronutrientsSchema = z
  .record(z.string(), z.number().optional())
  .default({});

export const FoodSourceSchema = z.enum([
  'staple',
  'usda',
  'off',
  'catalog',
  'fatsecret',
  'edamam',
  'nutritionix',
  'custom_barcode',
  'custom_food',
  'ai_scan',
  'quick_add',
  'recipe',
]);

export const FoodLogEntrySchema = z.object({
  id: z.string(),
  date: z.string(),
  mealSlot: z.string().optional(),
  foodId: z.string(),
  name: z.string(),
  source: FoodSourceSchema,
  amount: z.number(),
  unit: z.string(),
  nutritionSnapshot: MacroNutrientsSchema.extend({
    micros: MicronutrientsSchema,
  }),
  note: z.string().optional(),
  createdAt: z.number(),
});

export const FoodServingOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  unit: z.string(),
  grams: z.number(),
  defaultAmount: z.number().optional(),
});

export const FoodItemSchema = z.object({
  id: z.string(),
  barcode: z.string().nullable().optional(),
  source: z.enum([
    'staple',
    'usda',
    'off',
    'catalog',
    'fatsecret',
    'edamam',
    'nutritionix',
    'custom_barcode',
    'custom_food',
  ]),
  accuracyTier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  category: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  name: z.string(),
  brand: z.string().optional(),
  region: z.string().optional(),
  basis: z.enum(['per100g', 'per100ml', 'perServing']),
  servingSize: z.number(),
  servingUnit: z.string(),
  servingWeightGrams: z.number().optional(),
  servingOptions: z.array(FoodServingOptionSchema).optional(),
  nutrientsPerBasis: MacroNutrientsSchema,
  micronutrientsPerBasis: MicronutrientsSchema,
  updatedAt: z.number(),
});

export const CustomRecipeIngredientSchema = z.object({
  foodId: z.string(),
  name: z.string(),
  amount: z.number(),
  unit: z.string(),
  nutritionSnapshot: MacroNutrientsSchema.extend({
    micros: MicronutrientsSchema,
  }),
  gramWeight: z.number().optional(),
  gramsPerUnit: z.number().optional(),
  servingSize: z.number().optional(),
  baseBasis: z.enum(['per100g', 'per100ml', 'perServing']).optional(),
  baseNutrients: MacroNutrientsSchema.optional(),
  baseMicros: MicronutrientsSchema.optional(),
});

export const CustomRecipeSchema = z.object({
  id: z.string(),
  name: z.string(),
  ingredients: z.array(CustomRecipeIngredientSchema),
  basis: z.enum(['per100g', 'perServing']),
  totalGrams: z.number(),
  cookedWeightGrams: z.number().nullable().optional(),
  nutrientsPerBasis: MacroNutrientsSchema,
  micronutrientsPerBasis: MicronutrientsSchema,
  defaultServings: z.number(),
  createdAt: z.number(),
});

export const MealSlotConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  weightPct: z.number(),
});

export const DailyMacroTargetsSchema = z.object({
  calories: z.number(),
  proteinG: z.number(),
  carbsG: z.number(),
  fatG: z.number(),
  fiberG: z.number(),
});

export const WeeklyScheduleSchema = z.object({
  mon: DailyMacroTargetsSchema,
  tue: DailyMacroTargetsSchema,
  wed: DailyMacroTargetsSchema,
  thu: DailyMacroTargetsSchema,
  fri: DailyMacroTargetsSchema,
  sat: DailyMacroTargetsSchema,
  sun: DailyMacroTargetsSchema,
});

export const UserProfileSchema = z.object({
  sex: z.enum(['male', 'female']),
  age: z.number(),
  weightKg: z.number(),
  heightCm: z.number(),
  activityMultiplier: z.number(),
  goalDeltaKcal: z.number(),
  proteinPerKg: z.number(),
});

export const UserGoalsSchema = z.object({
  id: z.string(),
  dailyCalories: z.number(),
  proteinG: z.number(),
  carbsG: z.number(),
  fatG: z.number(),
  fiberG: z.number(),
  micronutrientTargets: z.record(z.string(), z.number().optional()).default({}),
  mealSlots: z.array(MealSlotConfigSchema).optional(),
  targetMode: z.enum(['calculator', 'custom']).optional(),
  goalDeltaKcal: z.number().optional(),
  weeklyCyclingEnabled: z.boolean().optional(),
  weeklySchedule: WeeklyScheduleSchema.optional(),
  weightUnit: z.enum(['kg', 'lb']).optional(),
  lastCheckInAt: z.number().optional(),
  lastCheckInDismissedAt: z.number().optional(),
  profile: UserProfileSchema.optional(),
  updatedAt: z.number(),
});

export const WeightLogEntrySchema = z.object({
  id: z.string(),
  date: z.string(),
  weightKg: z.number(),
  note: z.string().optional(),
  source: z.enum(['manual', 'apple_health']),
  recordedAt: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const PinnedFoodSchema = z.object({
  id: z.string(),
  kind: z.enum(['food', 'recipe']),
  refId: z.string(),
  pinnedAt: z.number(),
});

export const SyncTableNameSchema = z.enum([
  'foodLogs',
  'foodsCache',
  'customRecipes',
  'userGoals',
  'weightLogs',
  'pinnedFoods',
]);

export const SyncTombstoneSchema = z.object({
  id: z.string(),
  tableName: SyncTableNameSchema,
  recordId: z.string(),
  deletedAt: z.number(),
});

export const CentralTablesSyncSchema = z.object({
  foodLogs: z.array(FoodLogEntrySchema).default([]),
  foodsCache: z.array(FoodItemSchema).default([]),
  customRecipes: z.array(CustomRecipeSchema).default([]),
  userGoals: z.array(UserGoalsSchema).default([]),
  weightLogs: z.array(WeightLogEntrySchema).default([]),
  pinnedFoods: z.array(PinnedFoodSchema).default([]),
  tombstones: z.array(SyncTombstoneSchema).default([]),
});

export const OpenCaloryBackupV1Schema = z.object({
  version: z.literal(1),
  exportedAt: z.number(),
  tables: z.object({
    foodLogs: z.array(FoodLogEntrySchema).default([]),
    foodsCache: z.array(FoodItemSchema).default([]),
    customRecipes: z.array(CustomRecipeSchema).default([]),
    userGoals: z.array(UserGoalsSchema).default([]),
  }),
});

export const OpenCaloryBackupV2Schema = z.object({
  version: z.literal(2),
  exportedAt: z.number(),
  tables: z.object({
    foodLogs: z.array(FoodLogEntrySchema).default([]),
    foodsCache: z.array(FoodItemSchema).default([]),
    customRecipes: z.array(CustomRecipeSchema).default([]),
    userGoals: z.array(UserGoalsSchema).default([]),
    weightLogs: z.array(WeightLogEntrySchema).default([]),
    pinnedFoods: z.array(PinnedFoodSchema).default([]),
  }),
});

export const OpenCaloryBackupSchema = z.discriminatedUnion('version', [
  OpenCaloryBackupV1Schema,
  OpenCaloryBackupV2Schema,
]);

export type OpenCaloryBackup = z.infer<typeof OpenCaloryBackupSchema>;
export type OpenCaloryBackupV2 = z.infer<typeof OpenCaloryBackupV2Schema>;

export interface ImportBackupResult {
  importedCounts: {
    foodLogs: number;
    foodsCache: number;
    customRecipes: number;
    userGoals: number;
    weightLogs: number;
    pinnedFoods: number;
    [key: string]: number;
  };
  syncPending?: boolean;
}

/**
 * Exports all IndexedDB data tables (foodLogs, foodsCache, customRecipes, userGoals,
 * weightLogs, pinnedFoods) into a formatted JSON string following the version 2 backup schema.
 */
export async function exportBackupJson(): Promise<string> {
  const [foodLogs, foodsCache, customRecipes, userGoals, weightLogs, pinnedFoods] =
    await Promise.all([
      db.foodLogs.toArray(),
      db.foodsCache.toArray(),
      db.customRecipes.toArray(),
      db.userGoals.toArray(),
      db.weightLogs.toArray(),
      db.pinnedFoods.toArray(),
    ]);

  const backupData: OpenCaloryBackupV2 = {
    version: 2,
    exportedAt: Date.now(),
    tables: {
      foodLogs,
      foodsCache,
      customRecipes,
      userGoals,
      weightLogs,
      pinnedFoods,
    },
  };

  return JSON.stringify(backupData, null, 2);
}

/**
 * Validates and imports a JSON backup string (v1 or v2) into openCaloryDB.
 *
 * Pre-validation:
 * Strictly parses and validates with Zod (version 1 or 2, tables schema) BEFORE
 * opening any IndexedDB transaction. Any corrupt data throws immediately, leaving
 * existing tables completely untouched.
 *
 * Modes:
 * - 'replace': Clears all backup tables (and stale tombstones) and puts backup records in a single Dexie transaction.
 * - 'merge': Upserts foodLogs, foodsCache, customRecipes, pinnedFoods by ID, and resolves
 *   userGoals & weightLogs via updatedAt-wins (overwrites only if incoming.updatedAt > existing.updatedAt or if absent).
 */
export async function importBackupJson(
  rawJson: string,
  mode: 'replace' | 'merge'
): Promise<ImportBackupResult> {
  // 1. Parse JSON string
  let parsed: unknown;
  try {
    parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  } catch (err) {
    throw new Error(`Failed to parse backup JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Validate strictly with Zod before touching IndexedDB
  const validated = OpenCaloryBackupSchema.parse(parsed);
  const { foodLogs, foodsCache, customRecipes, userGoals } = validated.tables;
  const weightLogs = validated.version === 2 ? validated.tables.weightLogs : [];
  const pinnedFoods = validated.version === 2 ? validated.tables.pinnedFoods : [];

  const importedCounts = {
    foodLogs: 0,
    foodsCache: 0,
    customRecipes: 0,
    userGoals: 0,
    weightLogs: 0,
    pinnedFoods: 0,
  };

  // 3. Execute inside an atomic Dexie read-write transaction across all tables
  await db.transaction(
    'rw',
    [
      db.foodLogs,
      db.foodsCache,
      db.customRecipes,
      db.userGoals,
      db.weightLogs,
      db.pinnedFoods,
      db.tombstones,
    ],
    async () => {
      if (mode === 'replace') {
        await Promise.all([
          db.foodLogs.clear(),
          db.foodsCache.clear(),
          db.customRecipes.clear(),
          db.userGoals.clear(),
          db.weightLogs.clear(),
          db.pinnedFoods.clear(),
          db.tombstones.clear(),
        ]);

        if (foodLogs.length > 0) {
          await db.foodLogs.bulkPut(foodLogs as FoodLogEntry[]);
        }
        if (foodsCache.length > 0) {
          await db.foodsCache.bulkPut(foodsCache as FoodItem[]);
        }
        if (customRecipes.length > 0) {
          await db.customRecipes.bulkPut(customRecipes as CustomRecipe[]);
        }
        if (userGoals.length > 0) {
          await db.userGoals.bulkPut(userGoals as UserGoals[]);
        }
        if (weightLogs.length > 0) {
          await db.weightLogs.bulkPut(weightLogs as WeightLogEntry[]);
        }
        if (pinnedFoods.length > 0) {
          await db.pinnedFoods.bulkPut(pinnedFoods as PinnedFood[]);
        }

        importedCounts.foodLogs = foodLogs.length;
        importedCounts.foodsCache = foodsCache.length;
        importedCounts.customRecipes = customRecipes.length;
        importedCounts.userGoals = userGoals.length;
        importedCounts.weightLogs = weightLogs.length;
        importedCounts.pinnedFoods = pinnedFoods.length;
      } else {
        // mode === 'merge'
        if (foodLogs.length > 0) {
          await db.foodLogs.bulkPut(foodLogs as FoodLogEntry[]);
        }
        if (foodsCache.length > 0) {
          await db.foodsCache.bulkPut(foodsCache as FoodItem[]);
        }
        if (customRecipes.length > 0) {
          await db.customRecipes.bulkPut(customRecipes as CustomRecipe[]);
        }
        if (pinnedFoods.length > 0) {
          await db.pinnedFoods.bulkPut(pinnedFoods as PinnedFood[]);
        }

        importedCounts.foodLogs = foodLogs.length;
        importedCounts.foodsCache = foodsCache.length;
        importedCounts.customRecipes = customRecipes.length;
        importedCounts.pinnedFoods = pinnedFoods.length;

        let goalsUpdated = 0;
        for (const incomingGoal of userGoals) {
          const existing = await db.userGoals.get(incomingGoal.id);
          if (!existing || incomingGoal.updatedAt > existing.updatedAt) {
            await db.userGoals.put(incomingGoal as UserGoals);
            goalsUpdated++;
          }
        }
        importedCounts.userGoals = goalsUpdated;

        let weightsUpdated = 0;
        for (const incomingWeight of weightLogs) {
          const existing = await db.weightLogs.get(incomingWeight.id);
          if (!existing || incomingWeight.updatedAt > existing.updatedAt) {
            await db.weightLogs.put(incomingWeight as WeightLogEntry);
            weightsUpdated++;
          }
        }
        importedCounts.weightLogs = weightsUpdated;
      }
    }
  );

  let syncPending = false;
  if (isCloudSyncEnabled()) {
    try {
      await syncWithCentralDb(db, { forcePushMode: mode });
    } catch {
      syncPending = true;
    }
  }

  return syncPending ? { importedCounts, syncPending } : { importedCounts };
}
