import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../opencalory-db';
import { exportBackupJson, importBackupJson } from '../backup';
import type {
  FoodLogEntry,
  FoodItem,
  CustomRecipe,
  UserGoals,
  WeightLogEntry,
  PinnedFood,
} from '@/types/nutrition';

describe('JSON Backup Export & Transactional Import', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('merge upserts by UUID without duplicating and resolves userGoals by updatedAt', async () => {
    await db.userGoals.put({
      id: 'active',
      dailyCalories: 2500,
      proteinG: 180,
      carbsG: 260,
      fatG: 80,
      fiberG: 35,
      micronutrientTargets: {},
      mealSlots: [],
      updatedAt: 2000,
    });

    const stalePayload = JSON.stringify({
      version: 1,
      exportedAt: 1000,
      tables: {
        foodLogs: [
          {
            id: 'log-1',
            date: '2026-11-14',
            mealSlot: 'lunch',
            foodId: 'staple:1',
            name: 'Rice',
            source: 'staple',
            amount: 150,
            unit: 'g',
            nutritionSnapshot: {
              calories: 195,
              protein: 4,
              carbs: 42,
              fat: 0.4,
              fiber: 0.6,
              micros: {},
            },
            createdAt: 1000,
          },
        ],
        foodsCache: [],
        customRecipes: [],
        userGoals: [
          {
            id: 'active',
            dailyCalories: 1800,
            proteinG: 140,
            carbsG: 180,
            fatG: 55,
            fiberG: 25,
            micronutrientTargets: {},
            mealSlots: [],
            updatedAt: 1000,
          },
        ],
      },
    });

    await importBackupJson(stalePayload, 'merge');
    await importBackupJson(stalePayload, 'merge');

    expect(await db.foodLogs.count()).toBe(1);
    expect((await db.userGoals.get('active'))?.dailyCalories).toBe(2500);
  });

  it('corrupt JSON leaves existing openCaloryDB tables untouched', async () => {
    await db.userGoals.put({
      id: 'active',
      dailyCalories: 2500,
      proteinG: 180,
      carbsG: 260,
      fatG: 80,
      fiberG: 35,
      micronutrientTargets: {},
      mealSlots: [],
      updatedAt: 2000,
    });

    await expect(importBackupJson('{"version": 99}', 'replace')).rejects.toThrow();
    expect((await db.userGoals.get('active'))?.dailyCalories).toBe(2500);

    // Invalid JSON syntax
    await expect(importBackupJson('{not-json', 'replace')).rejects.toThrow();
    expect((await db.userGoals.get('active'))?.dailyCalories).toBe(2500);

    // Version as string
    await expect(importBackupJson('{"version": "1", "exportedAt": 1000, "tables": {}}', 'replace')).rejects.toThrow();
    expect((await db.userGoals.get('active'))?.dailyCalories).toBe(2500);

    // Missing tables
    await expect(importBackupJson('{"version": 1, "exportedAt": 1000}', 'replace')).rejects.toThrow();
    expect((await db.userGoals.get('active'))?.dailyCalories).toBe(2500);
  });

  it('exports valid JSON and performs full round-trip in replace mode', async () => {
    const foodLog: FoodLogEntry = {
      id: 'log-1',
      date: '2026-11-14',
      mealSlot: 'breakfast',
      foodId: 'staple:eggs',
      name: 'Boiled Eggs',
      source: 'staple',
      amount: 100,
      unit: 'g',
      nutritionSnapshot: {
        calories: 155,
        protein: 13,
        carbs: 1.1,
        fat: 11,
        fiber: 0,
        micros: { ironMg: 1.2 },
      },
      createdAt: 1500,
    };

    const foodItem: FoodItem = {
      id: 'staple:eggs',
      source: 'staple',
      name: 'Boiled Eggs',
      basis: 'per100g',
      servingSize: 50,
      servingUnit: 'egg',
      nutrientsPerBasis: { calories: 155, protein: 13, carbs: 1.1, fat: 11, fiber: 0 },
      micronutrientsPerBasis: { ironMg: 1.2 },
      updatedAt: 1500,
    };

    const recipe: CustomRecipe = {
      id: 'recipe-1',
      name: 'Egg Toast',
      ingredients: [],
      basis: 'perServing',
      totalGrams: 150,
      nutrientsPerBasis: { calories: 250, protein: 15, carbs: 25, fat: 12, fiber: 2 },
      micronutrientsPerBasis: {},
      defaultServings: 1,
      createdAt: 1500,
    };

    const goals: UserGoals = {
      id: 'active',
      dailyCalories: 2200,
      proteinG: 160,
      carbsG: 220,
      fatG: 70,
      fiberG: 30,
      micronutrientTargets: { calciumMg: 1000 },
      mealSlots: [{ id: 'breakfast', name: 'Breakfast', weightPct: 30 }],
      profile: {
        sex: 'female',
        age: 30,
        weightKg: 65,
        heightCm: 168,
        activityMultiplier: 1.4,
        goalDeltaKcal: 0,
        proteinPerKg: 2.0,
      },
      updatedAt: 1500,
    };

    const weightLog: WeightLogEntry = {
      id: 'w-1',
      date: '2026-11-14',
      weightKg: 76.4,
      note: 'Morning fasted',
      source: 'manual',
      recordedAt: '2026-11-14T07:30:00.000Z',
      createdAt: 1500,
      updatedAt: 1500,
    };

    const pinnedFood: PinnedFood = {
      id: 'food:staple:eggs',
      kind: 'food',
      refId: 'staple:eggs',
      pinnedAt: 1500,
    };

    await db.foodLogs.put(foodLog);
    await db.foodsCache.put(foodItem);
    await db.customRecipes.put(recipe);
    await db.userGoals.put(goals);
    await db.weightLogs.put(weightLog);
    await db.pinnedFoods.put(pinnedFood);

    const exportedJson = await exportBackupJson();
    const parsed = JSON.parse(exportedJson);

    expect(parsed.version).toBe(2);
    expect(typeof parsed.exportedAt).toBe('number');
    expect(parsed.tables.foodLogs).toHaveLength(1);
    expect(parsed.tables.foodsCache).toHaveLength(1);
    expect(parsed.tables.customRecipes).toHaveLength(1);
    expect(parsed.tables.userGoals).toHaveLength(1);
    expect(parsed.tables.weightLogs).toHaveLength(1);
    expect(parsed.tables.pinnedFoods).toHaveLength(1);

    // Wipe database
    await db.foodLogs.clear();
    await db.foodsCache.clear();
    await db.customRecipes.clear();
    await db.userGoals.clear();
    await db.weightLogs.clear();
    await db.pinnedFoods.clear();

    expect(await db.foodLogs.count()).toBe(0);

    // Import with replace mode
    const result = await importBackupJson(exportedJson, 'replace');
    expect(result.importedCounts.foodLogs).toBe(1);
    expect(result.importedCounts.foodsCache).toBe(1);
    expect(result.importedCounts.customRecipes).toBe(1);
    expect(result.importedCounts.userGoals).toBe(1);
    expect(result.importedCounts.weightLogs).toBe(1);
    expect(result.importedCounts.pinnedFoods).toBe(1);

    expect((await db.foodLogs.get('log-1'))?.name).toBe('Boiled Eggs');
    expect((await db.foodsCache.get('staple:eggs'))?.name).toBe('Boiled Eggs');
    expect((await db.customRecipes.get('recipe-1'))?.name).toBe('Egg Toast');
    expect((await db.userGoals.get('active'))?.dailyCalories).toBe(2200);
    expect((await db.userGoals.get('active'))?.profile?.weightKg).toBe(65);
    expect((await db.weightLogs.get('w-1'))?.weightKg).toBe(76.4);
    expect((await db.pinnedFoods.get('food:staple:eggs'))?.refId).toBe('staple:eggs');
  });

  it('exports version 2 with weightLogs/pinnedFoods and imports legacy version 1 backups cleanly', async () => {
    const v1Payload = JSON.stringify({
      version: 1,
      exportedAt: 100,
      tables: { foodLogs: [], foodsCache: [], customRecipes: [], userGoals: [] },
    });
    await expect(importBackupJson(v1Payload, 'merge')).resolves.toMatchObject({
      importedCounts: {
        foodLogs: 0,
        foodsCache: 0,
        customRecipes: 0,
        userGoals: 0,
        weightLogs: 0,
        pinnedFoods: 0,
      },
    });

    const exported = JSON.parse(await exportBackupJson());
    expect(exported.version).toBe(2);
    expect(exported.tables).toHaveProperty('weightLogs');
    expect(exported.tables).toHaveProperty('pinnedFoods');
  });

  it('merge mode resolves weightLogs by updatedAt and replace mode clears v2 tables even on v1 import', async () => {
    await db.weightLogs.put({
      id: 'w-keep',
      date: '2026-11-14',
      weightKg: 75.2,
      source: 'manual',
      recordedAt: '2026-11-14T08:00:00.000Z',
      createdAt: 1000,
      updatedAt: 2000,
    });

    const v2MergePayload = JSON.stringify({
      version: 2,
      exportedAt: 3000,
      tables: {
        foodLogs: [],
        foodsCache: [],
        customRecipes: [],
        userGoals: [],
        weightLogs: [
          {
            id: 'w-keep',
            date: '2026-11-14',
            weightKg: 99.9,
            source: 'manual',
            recordedAt: '2026-11-14T08:00:00.000Z',
            createdAt: 1000,
            updatedAt: 1000,
          },
          {
            id: 'w-new',
            date: '2026-11-15',
            weightKg: 74.9,
            source: 'apple_health',
            recordedAt: '2026-11-15T08:00:00.000Z',
            createdAt: 3000,
            updatedAt: 3000,
          },
        ],
        pinnedFoods: [
          {
            id: 'recipe:r-1',
            kind: 'recipe',
            refId: 'r-1',
            pinnedAt: 3000,
          },
        ],
      },
    });

    const mergeResult = await importBackupJson(v2MergePayload, 'merge');
    expect(mergeResult.importedCounts.weightLogs).toBe(1);
    expect(mergeResult.importedCounts.pinnedFoods).toBe(1);
    expect((await db.weightLogs.get('w-keep'))?.weightKg).toBe(75.2);
    expect((await db.weightLogs.get('w-new'))?.weightKg).toBe(74.9);
    expect((await db.pinnedFoods.get('recipe:r-1'))?.kind).toBe('recipe');

    const v1ReplacePayload = JSON.stringify({
      version: 1,
      exportedAt: 4000,
      tables: { foodLogs: [], foodsCache: [], customRecipes: [], userGoals: [] },
    });
    await importBackupJson(v1ReplacePayload, 'replace');
    expect(await db.weightLogs.count()).toBe(0);
    expect(await db.pinnedFoods.count()).toBe(0);
  });

  it('merge mode overwrites userGoals when incoming.updatedAt > existing.updatedAt', async () => {
    await db.userGoals.put({
      id: 'active',
      dailyCalories: 2000,
      proteinG: 150,
      carbsG: 200,
      fatG: 65,
      fiberG: 25,
      micronutrientTargets: {},
      mealSlots: [],
      updatedAt: 1000,
    });

    const newerPayload = JSON.stringify({
      version: 1,
      exportedAt: 3000,
      tables: {
        foodLogs: [],
        foodsCache: [],
        customRecipes: [],
        userGoals: [
          {
            id: 'active',
            dailyCalories: 2600,
            proteinG: 190,
            carbsG: 270,
            fatG: 85,
            fiberG: 35,
            micronutrientTargets: {},
            mealSlots: [],
            updatedAt: 3000,
          },
        ],
      },
    });

    const result = await importBackupJson(newerPayload, 'merge');
    expect(result.importedCounts.userGoals).toBe(1);
    expect((await db.userGoals.get('active'))?.dailyCalories).toBe(2600);
    expect((await db.userGoals.get('active'))?.updatedAt).toBe(3000);
  });

  it('merge mode inserts userGoals when no existing userGoals record is present', async () => {
    expect(await db.userGoals.count()).toBe(0);

    const payload = JSON.stringify({
      version: 1,
      exportedAt: 1000,
      tables: {
        foodLogs: [],
        foodsCache: [],
        customRecipes: [],
        userGoals: [
          {
            id: 'active',
            dailyCalories: 2100,
            proteinG: 155,
            carbsG: 215,
            fatG: 70,
            fiberG: 28,
            micronutrientTargets: {},
            mealSlots: [],
            updatedAt: 1000,
          },
        ],
      },
    });

    const result = await importBackupJson(payload, 'merge');
    expect(result.importedCounts.userGoals).toBe(1);
    expect((await db.userGoals.get('active'))?.dailyCalories).toBe(2100);
  });

  it('replace mode wipes previous data completely before inserting new backup data', async () => {
    await db.foodLogs.put({
      id: 'old-log',
      date: '2026-11-13',
      mealSlot: 'snack',
      foodId: 'staple:apple',
      name: 'Old Apple',
      source: 'staple',
      amount: 100,
      unit: 'g',
      nutritionSnapshot: { calories: 52, protein: 0.3, carbs: 14, fat: 0.2, fiber: 2.4, micros: {} },
      createdAt: 500,
    });

    const replacePayload = JSON.stringify({
      version: 1,
      exportedAt: 2000,
      tables: {
        foodLogs: [
          {
            id: 'new-log',
            date: '2026-11-14',
            mealSlot: 'breakfast',
            foodId: 'staple:oats',
            name: 'New Oats',
            source: 'staple',
            amount: 50,
            unit: 'g',
            nutritionSnapshot: { calories: 190, protein: 6.5, carbs: 34, fat: 3.5, fiber: 5, micros: {} },
            createdAt: 2000,
          },
        ],
        foodsCache: [],
        customRecipes: [],
        userGoals: [],
      },
    });

    await importBackupJson(replacePayload, 'replace');

    expect(await db.foodLogs.count()).toBe(1);
    expect(await db.foodLogs.get('old-log')).toBeUndefined();
    expect((await db.foodLogs.get('new-log'))?.name).toBe('New Oats');
  });
});
