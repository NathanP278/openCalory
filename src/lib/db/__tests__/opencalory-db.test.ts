import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../opencalory-db';
import { scaleNutrition, computeMacroCalories } from '../../nutrition/scaling';
import {
  buildCyclingPreset,
  computeWeeklyScheduleAverage,
  getWeekdayKey,
  resolveGoalsForDate,
} from '../../nutrition/goals';
import type { FoodLogEntry, CustomRecipe, UserGoals } from '@/types/nutrition';

describe('openCaloryDB & Nutrition Scaling Helpers', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  describe('Nutrition Scaling Helpers', () => {
    const base = { calories: 200, protein: 20, carbs: 10, fat: 8, fiber: 2 };

    it('scales per100g, per100ml, perServing, and zero-amount safely', () => {
      expect(scaleNutrition(base, { sodiumMg: 100 }, 'per100g', 150).macros.calories).toBe(300);
      expect(scaleNutrition(base, {}, 'per100ml', 250).macros.protein).toBe(50);
      expect(scaleNutrition(base, {}, 'perServing', 1.5).macros.carbs).toBe(15);
      expect(scaleNutrition(base, {}, 'per100g', 0).macros.calories).toBe(0);
      expect(computeMacroCalories(30, 40, 10)).toBe(370);
    });

    it('correctly scales micronutrients alongside macronutrients', () => {
      const res = scaleNutrition(base, { sodiumMg: 120, calciumMg: 80 }, 'per100g', 150);
      expect(res.macros).toEqual({
        calories: 300,
        protein: 30,
        carbs: 15,
        fat: 12,
        fiber: 3,
      });
      expect(res.micros.sodiumMg).toBe(180);
      expect(res.micros.calciumMg).toBe(120);
    });

    it('safely handles negative and NaN amounts by clamping to 0', () => {
      const neg = scaleNutrition(base, { potassiumMg: 100 }, 'per100g', -50);
      expect(neg.macros.calories).toBe(0);
      expect(neg.macros.protein).toBe(0);
      expect(neg.micros.potassiumMg).toBe(0);

      const nanRes = scaleNutrition(base, { potassiumMg: 100 }, 'per100g', Number.NaN);
      expect(nanRes.macros.calories).toBe(0);
      expect(nanRes.macros.protein).toBe(0);
      expect(nanRes.micros.potassiumMg).toBe(0);
    });

    it('safely handles negative or NaN nutrient values in input', () => {
      const corruptBase = { calories: -100, protein: Number.NaN, carbs: 10, fat: -5, fiber: 0 };
      const corruptMicros = { sodiumMg: -50, ironMg: Number.NaN };
      const res = scaleNutrition(corruptBase, corruptMicros, 'per100g', 100);
      expect(res.macros.calories).toBe(0);
      expect(res.macros.protein).toBe(0);
      expect(res.macros.carbs).toBe(10);
      expect(res.macros.fat).toBe(0);
      expect(res.micros.sodiumMg).toBe(0);
      expect(res.micros.ironMg).toBe(0);
    });

    it('handles servingSize edge cases when passed (positive, zero, negative, NaN)', () => {
      // Normal servingSize passed as metadata / reference
      const resWithServing = scaleNutrition(base, {}, 'per100g', 150, 170);
      expect(resWithServing.macros.calories).toBe(300);

      // ServingSize zero, negative, or NaN should not throw or corrupt output
      const resZeroServing = scaleNutrition(base, {}, 'perServing', 2, 0);
      expect(resZeroServing.macros.calories).toBe(400);

      const resNegServing = scaleNutrition(base, {}, 'perServing', 2, -50);
      expect(resNegServing.macros.calories).toBe(400);

      const resNanServing = scaleNutrition(base, {}, 'per100ml', 100, Number.NaN);
      expect(resNanServing.macros.calories).toBe(200);
    });

    it('computeMacroCalories safely clamps negative and NaN inputs to 0', () => {
      expect(computeMacroCalories(0, 0, 0)).toBe(0);
      expect(computeMacroCalories(-10, 20, 5)).toBe(4 * 0 + 4 * 20 + 9 * 5); // 125
      expect(computeMacroCalories(Number.NaN, 10, Number.NaN)).toBe(40);
    });
  });

  describe('openCaloryDB Schema & Indexing', () => {
    it('persists foodLog with immutable nutritionSnapshot and barcode lookup', async () => {
      await db.foodsCache.put({
        id: 'off:12345',
        barcode: '12345',
        source: 'off',
        name: 'Greek Yogurt',
        basis: 'per100g',
        servingSize: 170,
        servingUnit: 'g',
        nutrientsPerBasis: { calories: 59, protein: 10, carbs: 3.6, fat: 0.4, fiber: 0 },
        micronutrientsPerBasis: { calciumMg: 110 },
        updatedAt: 1000,
      });

      const hit = await db.foodsCache.where('barcode').equals('12345').first();
      expect(hit?.name).toBe('Greek Yogurt');
      expect(hit?.nutrientsPerBasis.calories).toBe(59);
      expect(hit?.micronutrientsPerBasis.calciumMg).toBe(110);
    });

    it('persists and queries foodLogs by date and mealSlot', async () => {
      const entry: FoodLogEntry = {
        id: 'log-1',
        date: '2026-11-14',
        mealSlot: 'breakfast',
        foodId: 'off:12345',
        name: 'Greek Yogurt',
        source: 'off',
        amount: 170,
        unit: 'g',
        nutritionSnapshot: {
          calories: 100.3,
          protein: 17,
          carbs: 6.12,
          fat: 0.68,
          fiber: 0,
          micros: { calciumMg: 187 },
        },
        note: 'Post-workout',
        createdAt: Date.now(),
      };

      await db.foodLogs.put(entry);

      const byDate = await db.foodLogs.where('date').equals('2026-11-14').toArray();
      expect(byDate).toHaveLength(1);
      expect(byDate[0].nutritionSnapshot.micros.calciumMg).toBe(187);

      const bySlot = await db.foodLogs.where('mealSlot').equals('breakfast').toArray();
      expect(bySlot).toHaveLength(1);
      expect(bySlot[0].name).toBe('Greek Yogurt');
    });

    it('persists customRecipes and supports retrieval by id and name', async () => {
      const recipe: CustomRecipe = {
        id: 'recipe-1',
        name: 'Overnight Oats Bowl',
        ingredients: [
          {
            foodId: 'staple:oats',
            name: 'Rolled Oats',
            amount: 50,
            unit: 'g',
            nutritionSnapshot: {
              calories: 190,
              protein: 6.5,
              carbs: 34,
              fat: 3.5,
              fiber: 5,
              micros: { ironMg: 1.8 },
            },
          },
        ],
        basis: 'perServing',
        totalGrams: 250,
        nutrientsPerBasis: { calories: 350, protein: 25, carbs: 45, fat: 8, fiber: 6 },
        micronutrientsPerBasis: { calciumMg: 200, ironMg: 2.5 },
        defaultServings: 1,
        createdAt: 1700000000,
      };

      await db.customRecipes.put(recipe);

      const hit = await db.customRecipes.where('name').equals('Overnight Oats Bowl').first();
      expect(hit?.id).toBe('recipe-1');
      expect(hit?.ingredients[0].nutritionSnapshot.micros.ironMg).toBe(1.8);
    });

    it('persists userGoals singleton with optional profile', async () => {
      const goals: UserGoals = {
        id: 'active',
        dailyCalories: 2400,
        proteinG: 180,
        carbsG: 240,
        fatG: 80,
        fiberG: 35,
        micronutrientTargets: { sodiumMg: 2300, calciumMg: 1000 },
        mealSlots: [
          { id: 'breakfast', name: 'Breakfast', weightPct: 25 },
          { id: 'lunch', name: 'Lunch', weightPct: 35 },
          { id: 'dinner', name: 'Dinner', weightPct: 40 },
        ],
        profile: {
          sex: 'male',
          age: 28,
          weightKg: 82,
          heightCm: 180,
          activityMultiplier: 1.55,
          goalDeltaKcal: -300,
          proteinPerKg: 2.2,
        },
        updatedAt: Date.now(),
      };

      await db.userGoals.put(goals);

      const active = await db.userGoals.get('active');
      expect(active?.dailyCalories).toBe(2400);
      expect(active?.profile?.weightKg).toBe(82);
      expect(active?.mealSlots).toHaveLength(3);
    });

    it('persists weightLogs, pinnedFoods, and tombstones in Dexie v2', async () => {
      await db.weightLogs.put({
        id: 'w-1',
        date: '2026-11-20',
        weightKg: 76.5,
        source: 'manual',
        recordedAt: '2026-11-20T08:00:00.000Z',
        createdAt: 100,
        updatedAt: 100,
      });
      await db.pinnedFoods.put({
        id: 'food:staple:1',
        kind: 'food',
        refId: 'staple:1',
        pinnedAt: 100,
      });
      await db.tombstones.put({
        id: 'foodLogs:log-1',
        tableName: 'foodLogs',
        recordId: 'log-1',
        deletedAt: 200,
      });

      expect((await db.weightLogs.get('w-1'))?.weightKg).toBe(76.5);
      expect((await db.pinnedFoods.get('food:staple:1'))?.refId).toBe('staple:1');
      expect((await db.tombstones.get('foodLogs:log-1'))?.deletedAt).toBe(200);
    });

    it('upgrades an existing v1 openCaloryDB database to v2 without losing v1 records', async () => {
      db.close();
      await Dexie.delete('openCaloryDB');

      const v1Db = new Dexie('openCaloryDB');
      v1Db.version(1).stores({
        foodLogs: 'id, date, mealSlot, foodId, createdAt',
        foodsCache: 'id, barcode, source, name, updatedAt',
        customRecipes: 'id, name, createdAt',
        userGoals: 'id, updatedAt',
      });
      await v1Db.open();
      await v1Db.table('foodLogs').put({
        id: 'v1-log-1',
        date: '2026-11-19',
        mealSlot: 'lunch',
        foodId: 'staple:1',
        name: 'Steamed Rice',
        source: 'staple',
        amount: 200,
        unit: 'g',
        nutritionSnapshot: {
          calories: 260,
          protein: 5.4,
          carbs: 56,
          fat: 0.6,
          fiber: 0.8,
          micros: {},
        },
        createdAt: 1000,
      });
      v1Db.close();

      await db.open();
      expect(db.verno).toBe(2);
      const preserved = await db.foodLogs.get('v1-log-1');
      expect(preserved?.name).toBe('Steamed Rice');

      await db.weightLogs.put({
        id: 'w-upgrade',
        date: '2026-11-20',
        weightKg: 75.8,
        source: 'manual',
        recordedAt: '2026-11-20T07:00:00.000Z',
        createdAt: 2000,
        updatedAt: 2000,
      });
      expect((await db.weightLogs.get('w-upgrade'))?.weightKg).toBe(75.8);
    });
  });

  describe('Date-Resolved Goals & Weekly Calorie Cycling', () => {
    it('maps ISO calendar dates to weekday keys without timezone drift', () => {
      expect(getWeekdayKey('2026-11-16')).toBe('mon');
      expect(getWeekdayKey('2026-11-17')).toBe('tue');
      expect(getWeekdayKey('2026-11-18')).toBe('wed');
      expect(getWeekdayKey('2026-11-19')).toBe('thu');
      expect(getWeekdayKey('2026-11-20')).toBe('fri');
      expect(getWeekdayKey('2026-11-21')).toBe('sat');
      expect(getWeekdayKey('2026-11-22')).toBe('sun');
    });

    it('resolves weekday-specific targets via resolveGoalsForDate when weeklyCyclingEnabled is true', () => {
      const schedule = buildCyclingPreset(
        { calories: 2000, proteinG: 160, carbsG: 200, fatG: 62, fiberG: 28 },
        'weekend_plus_250'
      );
      const goals: UserGoals = {
        id: 'active',
        dailyCalories: 2000,
        proteinG: 160,
        carbsG: 200,
        fatG: 62,
        fiberG: 28,
        micronutrientTargets: {},
        updatedAt: 1,
        weeklyCyclingEnabled: true,
        weeklySchedule: schedule,
      };
      // 2026-11-21 is Saturday
      const sat = resolveGoalsForDate(goals, '2026-11-21');
      expect(sat.dailyCalories).toBe(schedule.sat.calories);
      expect(sat.dailyCalories).toBeGreaterThan(2000);
      const mon = resolveGoalsForDate(goals, '2026-11-16');
      expect(mon.dailyCalories).toBe(schedule.mon.calories);
      expect(computeWeeklyScheduleAverage(schedule).calories).toBeCloseTo(2000, -1);
    });

    it('returns base goals unchanged when weeklyCyclingEnabled is false or schedule is absent', () => {
      const schedule = buildCyclingPreset(
        { calories: 2100, proteinG: 165, carbsG: 210, fatG: 66, fiberG: 29 },
        'training_split'
      );
      const disabledGoals: UserGoals = {
        id: 'active',
        dailyCalories: 2100,
        proteinG: 165,
        carbsG: 210,
        fatG: 66,
        fiberG: 29,
        micronutrientTargets: {},
        updatedAt: 1,
        weeklyCyclingEnabled: false,
        weeklySchedule: schedule,
      };
      expect(resolveGoalsForDate(disabledGoals, '2026-11-16')).toEqual(disabledGoals);
      expect(computeWeeklyScheduleAverage(schedule).calories).toBeCloseTo(2100, -1);

      const even = buildCyclingPreset(
        { calories: 2200, proteinG: 170, carbsG: 220, fatG: 70, fiberG: 31 },
        'even'
      );
      expect(even.mon.calories).toBe(2200);
      expect(even.sat.calories).toBe(2200);
      expect(computeWeeklyScheduleAverage(even).calories).toBe(2200);
    });
  });
});
