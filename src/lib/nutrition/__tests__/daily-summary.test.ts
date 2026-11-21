import React from 'react';
import { describe, it, test, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import {
  aggregateDailySummary,
  getMicronutrientMeta,
  RDA_MICRONUTRIENT_METADATA,
} from '../daily-summary';
import { MacroBentoGrid } from '@/components/dashboard/macro-bento-grid';
import { MicronutrientPanel } from '@/components/dashboard/micronutrient-panel';
import HomePage from '@/app/page';
import { useLoggerStore } from '@/stores/logger-store';
import { db } from '@/lib/db/opencalory-db';
import type { FoodLogEntry, UserGoals } from '@/types/nutrition';

describe('aggregateDailySummary & Adherence-Neutral Analytics', () => {
  // Exact test specified in task-11-brief.md
  test('sums macros and micronutrients without punitive state when over target', () => {
    const summary = aggregateDailySummary(
      [
        {
          id: '1',
          date: '2026-11-14',
          mealSlot: 'lunch',
          foodId: 'x',
          name: 'Steak',
          source: 'staple',
          amount: 200,
          unit: 'g',
          nutritionSnapshot: {
            calories: 2200,
            protein: 190,
            carbs: 100,
            fat: 90,
            fiber: 10,
            micros: { ironMg: 9 },
          },
          createdAt: 1,
        },
      ],
      {
        id: 'active',
        dailyCalories: 2000,
        proteinG: 160,
        carbsG: 200,
        fatG: 70,
        fiberG: 30,
        micronutrientTargets: { ironMg: 18 },
        mealSlots: [],
        updatedAt: 1,
      }
    );

    expect(summary.calories.consumed).toBe(2200);
    expect(summary.calories.delta).toBe(200);
    expect(summary.calories.status).toBe('over');
    expect(summary.micros.ironMg.percent).toBe(50);
  });

  describe('Adherence statuses: under, near, and over', () => {
    const baseGoals: UserGoals = {
      id: 'active',
      dailyCalories: 2000,
      proteinG: 150,
      carbsG: 200,
      fatG: 65,
      fiberG: 30,
      micronutrientTargets: { sodiumMg: 2300 },
      mealSlots: [],
      updatedAt: 1,
    };

    it('identifies "under" when consumed is below 90% of target', () => {
      // 1500 / 2000 = 75% (< 90%)
      const summary = aggregateDailySummary(
        [
          {
            id: 'log-1',
            date: '2026-11-14',
            mealSlot: 'breakfast',
            foodId: 'f1',
            name: 'Oatmeal',
            source: 'staple',
            amount: 100,
            unit: 'g',
            nutritionSnapshot: {
              calories: 1500,
              protein: 50,
              carbs: 200,
              fat: 20,
              fiber: 15,
              micros: {},
            },
            createdAt: 1,
          },
        ],
        baseGoals
      );

      expect(summary.calories.consumed).toBe(1500);
      expect(summary.calories.remaining).toBe(500);
      expect(summary.calories.delta).toBe(-500);
      expect(summary.calories.status).toBe('under');
      expect(summary.calories.overTarget).toBe(false);
      expect(summary.calories.percent).toBe(75);
      expect(summary.calories.rawPercent).toBe(75);
    });

    it('identifies "near" when consumed is between 90% and 100% of target', () => {
      // 1850 / 2000 = 92.5% (>= 90% and <= 100%)
      const summary = aggregateDailySummary(
        [
          {
            id: 'log-2',
            date: '2026-11-14',
            mealSlot: 'lunch',
            foodId: 'f2',
            name: 'Chicken Rice',
            source: 'staple',
            amount: 100,
            unit: 'g',
            nutritionSnapshot: {
              calories: 1850,
              protein: 140,
              carbs: 180,
              fat: 60,
              fiber: 28,
              micros: {},
            },
            createdAt: 1,
          },
        ],
        baseGoals
      );

      expect(summary.calories.consumed).toBe(1850);
      expect(summary.calories.remaining).toBe(150);
      expect(summary.calories.delta).toBe(-150);
      expect(summary.calories.status).toBe('near');
      expect(summary.calories.overTarget).toBe(false);
      expect(summary.calories.percent).toBe(93);
    });

    it('identifies "near" at exact 100% of target', () => {
      const summary = aggregateDailySummary(
        [
          {
            id: 'log-exact',
            date: '2026-11-14',
            mealSlot: 'dinner',
            foodId: 'f3',
            name: 'Exact meal',
            source: 'staple',
            amount: 100,
            unit: 'g',
            nutritionSnapshot: {
              calories: 2000,
              protein: 150,
              carbs: 200,
              fat: 65,
              fiber: 30,
              micros: {},
            },
            createdAt: 1,
          },
        ],
        baseGoals
      );

      expect(summary.calories.consumed).toBe(2000);
      expect(summary.calories.remaining).toBe(0);
      expect(summary.calories.delta).toBe(0);
      expect(summary.calories.status).toBe('near');
      expect(summary.calories.overTarget).toBe(false);
      expect(summary.calories.percent).toBe(100);
    });

    it('identifies "over" when consumed is strictly above target', () => {
      const summary = aggregateDailySummary(
        [
          {
            id: 'log-over',
            date: '2026-11-14',
            mealSlot: 'dinner',
            foodId: 'f4',
            name: 'Surplus meal',
            source: 'staple',
            amount: 100,
            unit: 'g',
            nutritionSnapshot: {
              calories: 2200,
              protein: 160,
              carbs: 210,
              fat: 80,
              fiber: 32,
              micros: {},
            },
            createdAt: 1,
          },
        ],
        baseGoals
      );

      expect(summary.calories.consumed).toBe(2200);
      expect(summary.calories.remaining).toBe(0);
      expect(summary.calories.delta).toBe(200);
      expect(summary.calories.status).toBe('over');
      expect(summary.calories.overTarget).toBe(true);
      expect(summary.calories.percent).toBe(100); // Clamped for bar width
      expect(summary.calories.rawPercent).toBe(110); // Unclamped
    });
  });

  describe('Empty logs and edge cases', () => {
    it('handles empty logs gracefully with 0 consumed and positive remaining', () => {
      const emptyGoals: UserGoals = {
        id: 'active',
        dailyCalories: 2100,
        proteinG: 160,
        carbsG: 220,
        fatG: 70,
        fiberG: 30,
        micronutrientTargets: { ironMg: 18, sodiumMg: 2300 },
        mealSlots: [],
        updatedAt: 1,
      };

      const summary = aggregateDailySummary([], emptyGoals);

      expect(summary.calories.consumed).toBe(0);
      expect(summary.calories.remaining).toBe(2100);
      expect(summary.calories.delta).toBe(-2100);
      expect(summary.calories.status).toBe('under');
      expect(summary.calories.percent).toBe(0);
      expect(summary.calories.rawPercent).toBe(0);

      expect(summary.protein.consumed).toBe(0);
      expect(summary.protein.remaining).toBe(160);

      expect(summary.micros.ironMg.consumed).toBe(0);
      expect(summary.micros.ironMg.target).toBe(18);
      expect(summary.micros.ironMg.percent).toBe(0);
      expect(summary.logsCount).toBe(0);
    });

    it('guards against NaN, null, and undefined nutrition fields safely', () => {
      const oddLog = {
        id: 'odd',
        date: '2026-11-14',
        mealSlot: 'snack',
        foodId: 'odd-1',
        name: 'Odd item',
        source: 'quick_add' as const,
        amount: 1,
        unit: 'serving',
        nutritionSnapshot: {
          calories: (NaN as unknown) as number,
          protein: (undefined as unknown) as number,
          carbs: -10, // negative guard
          fat: 15.5,
          fiber: (null as unknown) as number,
          micros: {
            calciumMg: (NaN as unknown) as number,
            sodiumMg: 100,
          },
        },
        createdAt: 1,
      };

      const summary = aggregateDailySummary([oddLog as unknown as FoodLogEntry], {
        id: 'active',
        dailyCalories: 2000,
        proteinG: 150,
        carbsG: 200,
        fatG: 65,
        fiberG: 30,
        micronutrientTargets: {},
        mealSlots: [],
        updatedAt: 1,
      });

      expect(summary.calories.consumed).toBe(0);
      expect(summary.protein.consumed).toBe(0);
      expect(summary.carbs.consumed).toBe(0);
      expect(summary.fat.consumed).toBe(15.5);
      expect(summary.fiber.consumed).toBe(0);
      expect(summary.micros.calciumMg.consumed).toBe(0);
      expect(summary.micros.sodiumMg.consumed).toBe(100);
    });
  });

  describe('Micronutrient merge & RDA metadata', () => {
    it('sums micronutrients across multiple logs correctly', () => {
      const logs: FoodLogEntry[] = [
        {
          id: 'log-1',
          date: '2026-11-14',
          mealSlot: 'breakfast',
          foodId: 'f1',
          name: 'Spinach',
          source: 'staple',
          amount: 100,
          unit: 'g',
          nutritionSnapshot: {
            calories: 23,
            protein: 2.9,
            carbs: 3.6,
            fat: 0.4,
            fiber: 2.2,
            micros: { ironMg: 2.7, vitaminCMg: 28 },
          },
          createdAt: 1,
        },
        {
          id: 'log-2',
          date: '2026-11-14',
          mealSlot: 'lunch',
          foodId: 'f2',
          name: 'Beef',
          source: 'staple',
          amount: 150,
          unit: 'g',
          nutritionSnapshot: {
            calories: 350,
            protein: 38,
            carbs: 0,
            fat: 20,
            fiber: 0,
            micros: { ironMg: 3.3, zincMg: 6.5 },
          },
          createdAt: 2,
        },
      ];

      const summary = aggregateDailySummary(logs, {
        id: 'active',
        dailyCalories: 2000,
        proteinG: 150,
        carbsG: 200,
        fatG: 65,
        fiberG: 30,
        micronutrientTargets: { ironMg: 18, vitaminCMg: 90, zincMg: 11 },
        mealSlots: [],
        updatedAt: 1,
      });

      // Iron: 2.7 + 3.3 = 6.0 mg out of 18 mg = 33%
      expect(summary.micros.ironMg.consumed).toBe(6);
      expect(summary.micros.ironMg.target).toBe(18);
      expect(summary.micros.ironMg.percent).toBe(33);

      // Vitamin C: 28 mg out of 90 mg = 31%
      expect(summary.micros.vitaminCMg.consumed).toBe(28);

      // Zinc: 6.5 mg out of 11 mg = 59%
      expect(summary.micros.zincMg.consumed).toBe(6.5);
    });

    it('computes netCarbsG, potassiumSodiumRatio, and extended nutrient metrics', () => {
      const makeEntryWithMicros = ({
        carbs = 0,
        fiber = 0,
        potassiumMg = 0,
        sodiumMg = 0,
        caffeineMg = 0,
      }: {
        carbs?: number;
        fiber?: number;
        potassiumMg?: number;
        sodiumMg?: number;
        caffeineMg?: number;
      }): FoodLogEntry => ({
        id: 'ext-1',
        date: '2026-11-20',
        mealSlot: 'lunch',
        foodId: 'f-ext',
        name: 'Coffee & Oats',
        source: 'staple',
        amount: 100,
        unit: 'g',
        nutritionSnapshot: {
          calories: 300,
          protein: 10,
          carbs,
          fat: 5,
          fiber,
          micros: {
            potassiumMg,
            sodiumMg,
            caffeineMg,
          },
        },
        createdAt: 1,
      });

      const summary = aggregateDailySummary([
        makeEntryWithMicros({
          carbs: 50,
          fiber: 12,
          potassiumMg: 1500,
          sodiumMg: 1000,
          caffeineMg: 120,
        }),
      ]);
      expect(summary.netCarbsG).toBe(38);
      expect(summary.potassiumSodiumRatio).toBe(1.5);
      expect(summary.micros.caffeineMg.consumed).toBe(120);
      expect(summary.micros.caffeineMg.category).toBe('extended');
      expect(summary.micros.caffeineMg.target).toBe(400);

      const zeroSodiumSummary = aggregateDailySummary([]);
      expect(zeroSodiumSummary.netCarbsG).toBe(0);
      expect(zeroSodiumSummary.potassiumSodiumRatio).toBeNull();
    });

    it('provides human-readable labels and units for all 12 RDA micronutrients', () => {
      const keys = Object.keys(RDA_MICRONUTRIENT_METADATA);
      expect(keys.length).toBe(12);

      expect(getMicronutrientMeta('sodiumMg')).toEqual({
        key: 'sodiumMg',
        name: 'Sodium',
        unit: 'mg',
        category: 'mineral',
      });
      expect(getMicronutrientMeta('ironMg')).toEqual({
        key: 'ironMg',
        name: 'Iron',
        unit: 'mg',
        category: 'mineral',
      });
      expect(getMicronutrientMeta('vitaminDMcg')).toEqual({
        key: 'vitaminDMcg',
        name: 'Vitamin D',
        unit: 'mcg',
        category: 'vitamin',
      });
      expect(getMicronutrientMeta('folateMcg')).toEqual({
        key: 'folateMcg',
        name: 'Folate',
        unit: 'mcg',
        category: 'vitamin',
      });
    });
  });

  describe('Component render check: non-punitive over-target display in MacroBentoGrid', () => {
    it('displays "+200 kcal" delta without red alert styling or destructive classes when over target', () => {
      const summary = aggregateDailySummary(
        [
          {
            id: '1',
            date: '2026-11-14',
            mealSlot: 'lunch',
            foodId: 'x',
            name: 'Steak',
            source: 'staple',
            amount: 200,
            unit: 'g',
            nutritionSnapshot: {
              calories: 2200,
              protein: 190,
              carbs: 100,
              fat: 90,
              fiber: 10,
              micros: { ironMg: 9 },
            },
            createdAt: 1,
          },
        ],
        {
          id: 'active',
          dailyCalories: 2000,
          proteinG: 160,
          carbsG: 200,
          fatG: 70,
          fiberG: 30,
          micronutrientTargets: { ironMg: 18 },
          mealSlots: [],
          updatedAt: 1,
        }
      );

      const { container } = render(React.createElement(MacroBentoGrid, { summary }));

      expect(screen.getByText('Daily Nutrition')).toBeInTheDocument();
      expect(screen.getByText('Surplus')).toBeInTheDocument();

      // Must display +200 analytical surplus delta without punitive styling
      const deltaMatches = screen.getAllByText(/\+200/);
      expect(deltaMatches.length).toBeGreaterThan(0);

      // Must toggle cleanly between Consumed and Remaining + Today and 7-Day views
      fireEvent.click(screen.getByRole('button', { name: /^remaining$/i }));
      expect(screen.getAllByText('Surplus').length).toBeGreaterThanOrEqual(2);
      fireEvent.click(screen.getByRole('tab', { name: /7-day/i }));
      expect(screen.getByText('Nutrition & Targets')).toBeInTheDocument();

      // Must NEVER contain punitive red alert classes anywhere in rendered markup
      const html = container.innerHTML;
      expect(html).not.toMatch(/text-red/);
      expect(html).not.toMatch(/bg-red/);
      expect(html).not.toMatch(/border-red/);
      expect(html).not.toMatch(/destructive/);
    });
  });

  describe('Component render check: MicronutrientPanel', () => {
    it('renders clean 0% values when no logs and groups key minerals & vitamins', () => {
      const summary = aggregateDailySummary([], null);
      const { container } = render(React.createElement(MicronutrientPanel, { micros: summary.micros }));

      expect(screen.getByText('Micronutrient Targets')).toBeInTheDocument();
      expect(screen.getByText(/0\/(12|18) targets on track/i)).toBeInTheDocument();

      // Check iron presence in top 6
      expect(screen.getByText('Iron')).toBeInTheDocument();

      // Expand to verify all 12 including vitamins
      fireEvent.click(screen.getByRole('button', { name: /show all \d+ micronutrients/i }));
      expect(screen.getByText('Vitamin C')).toBeInTheDocument();

      // Non-punitive styling check
      const html = container.innerHTML;
      expect(html).not.toMatch(/text-red/);
      expect(html).not.toMatch(/bg-red/);
      expect(html).not.toMatch(/border-red/);
      expect(html).not.toMatch(/destructive/);
    });

    it('filters between Minerals and Vitamins tabs and toggles expand/collapse', () => {
      const summary = aggregateDailySummary([], null);
      render(React.createElement(MicronutrientPanel, { micros: summary.micros }));

      // Click Minerals tab
      fireEvent.click(screen.getByRole('button', { name: /^minerals$/i }));
      expect(screen.getByText('Iron')).toBeInTheDocument();
      expect(screen.queryByText('Vitamin C')).not.toBeInTheDocument();

      // Click Vitamins tab
      fireEvent.click(screen.getByRole('button', { name: /^vitamins$/i }));
      expect(screen.queryByText('Iron')).not.toBeInTheDocument();
      expect(screen.getByText('Vitamin C')).toBeInTheDocument();

      // Click All tab
      fireEvent.click(screen.getByRole('button', { name: /all/i }));
      expect(screen.getByText('Iron')).toBeInTheDocument();

      // Toggle Show All / Show Less
      const expandBtn = screen.getByRole('button', { name: /show all \d+ micronutrients/i });
      fireEvent.click(expandBtn);
      expect(screen.getByRole('button', { name: /show less/i })).toBeInTheDocument();
    });
  });

  describe('HomePage dashboard integration', () => {
    it('renders dashboard with date navigation and opens quick log sheet', () => {
      useLoggerStore.setState({
        activeDate: '2026-11-14',
        activeMealSlot: 'breakfast',
        activeSheet: null,
      });

      render(React.createElement(HomePage));

      // Header & MacroFactor Pics 1-4 dashboard checks
      expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
      expect(screen.getByText('openCalory')).toBeInTheDocument();
      expect(screen.getByText('Daily Nutrition')).toBeInTheDocument();
      expect(screen.getByText('Food Logging')).toBeInTheDocument();
      expect(screen.getByText('7-Day Pace')).toBeInTheDocument();
      expect(screen.getByText('7D Bank')).toBeInTheDocument();
      expect(screen.getByText('Logged Entries')).toBeInTheDocument();

      expect(screen.queryByText('Breakfast')).not.toBeInTheDocument();
      expect(screen.queryByText('Lunch')).not.toBeInTheDocument();
      expect(screen.queryByText('Dinner')).not.toBeInTheDocument();
      expect(screen.queryByText('Snacks')).not.toBeInTheDocument();

      const loggedSection = screen.getByRole('region', { name: 'Logged Entries' });
      expect(within(loggedSection).getByText('No entries logged yet')).toBeInTheDocument();

      // Date navigation: click previous day
      const prevBtn = screen.getByRole('button', { name: /previous day/i });
      fireEvent.click(prevBtn);
      expect(useLoggerStore.getState().activeDate).toBe('2026-11-13');

      // Click next day
      const nextBtn = screen.getByRole('button', { name: /next day/i });
      fireEvent.click(nextBtn);
      expect(useLoggerStore.getState().activeDate).toBe('2026-11-14');

      // Logged Entries quick add button opens search drawer
      const addFoodBtn = within(loggedSection).getByRole('button', { name: /add food/i });
      fireEvent.click(addFoodBtn);
      expect(useLoggerStore.getState().activeSheet).toBe('search');
    });

    it('renders logged entries as a flat list without meal-slot groupings and deletes entries', async () => {
      await db.foodLogs.clear();
      await db.foodLogs.bulkAdd([
        {
          id: 'dash-log-1',
          date: '2026-11-14',
          mealSlot: 'breakfast',
          foodId: 'f1',
          name: 'Oatmeal Bowl',
          source: 'staple',
          amount: 100,
          unit: 'g',
          nutritionSnapshot: {
            calories: 320,
            protein: 12,
            carbs: 54,
            fat: 6,
            fiber: 8,
            micros: {},
          },
          createdAt: 1000,
        },
        {
          id: 'dash-log-2',
          date: '2026-11-14',
          mealSlot: 'dinner',
          foodId: 'f2',
          name: 'Grilled Salmon',
          source: 'staple',
          amount: 180,
          unit: 'g',
          nutritionSnapshot: {
            calories: 375,
            protein: 39,
            carbs: 0,
            fat: 23,
            fiber: 0,
            micros: {},
          },
          createdAt: 2000,
        },
      ]);

      useLoggerStore.setState({
        activeDate: '2026-11-14',
        activeMealSlot: 'breakfast',
        activeSheet: null,
      });

      render(React.createElement(HomePage));

      const loggedSection = screen.getByRole('region', { name: 'Logged Entries' });
      await waitFor(() => {
        expect(within(loggedSection).getByText('Grilled Salmon')).toBeInTheDocument();
        expect(within(loggedSection).getByText('Oatmeal Bowl')).toBeInTheDocument();
      });

      // Flat list with no meal-slot group distinctions
      expect(within(loggedSection).getByText('2 items')).toBeInTheDocument();
      expect(within(loggedSection).queryByText('Breakfast')).not.toBeInTheDocument();
      expect(within(loggedSection).queryByText('Lunch')).not.toBeInTheDocument();
      expect(within(loggedSection).queryByText('Dinner')).not.toBeInTheDocument();
      expect(within(loggedSection).queryByText('Snacks')).not.toBeInTheDocument();

      // Delete one item directly from the flat list
      fireEvent.click(within(loggedSection).getByRole('button', { name: /delete oatmeal bowl/i }));
      await waitFor(() => {
        expect(within(loggedSection).queryByText('Oatmeal Bowl')).not.toBeInTheDocument();
      });

      await db.foodLogs.clear();
    });
  });
});
