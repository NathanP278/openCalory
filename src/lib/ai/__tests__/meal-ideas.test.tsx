import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import {
  AiMealIdeaSchema,
  AiMealIdeasResponseSchema,
  parseAiJsonResponse,
} from '@/lib/ai/schemas';
import { clearAiRuntimeCaches } from '@/lib/ai/openai-compat';
import { setStaplesCache } from '@/lib/foods/staples-search';
import { POST as postMealIdeas } from '@/app/api/ai/meal-ideas/route';
import { AiMealIdeasDrawer } from '@/components/scanner/ai-meal-ideas-drawer';
import { AiMealScannerSheet } from '@/components/scanner/ai-meal-scanner-sheet';
import { AppShell } from '@/components/shell/app-shell';
import { useLoggerStore } from '@/stores/logger-store';
import { db } from '@/lib/db/opencalory-db';
import { DEFAULT_RDA_MICROS } from '@/lib/nutrition/goals';
import type { FoodItem } from '@/types/nutrition';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

describe('Task 12: AI Meal Ideas ("Fill My Remaining Macros")', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.SYNC_ACCESS_KEY;
    clearAiRuntimeCaches();
    await db.delete();
    await db.open();
    useLoggerStore.setState({
      activeDate: '2026-11-20',
      dateDirection: null,
      activeMealSlot: 'log',
      activeSheet: null,
      searchInitialQuery: '',
      aiDraft: null,
      editingEntry: null,
      recipeSeedIngredients: null,
      undoToast: null,
      isCommandPaletteOpen: false,
      syncAuthLocked: false,
    });
  });

  afterEach(() => {
    cleanup();
    process.env = originalEnv;
    setStaplesCache(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('AiMealIdeaSchema & AiMealIdeasResponseSchema', () => {
    it('validates structured meal ideas with title, prepMinutes, summary, and items', () => {
      const raw = JSON.stringify({
        ideas: [
          {
            title: 'Chicken Adobo Rice Bowl',
            prepMinutes: 15,
            summary: 'High-protein Filipino bowl fitting remaining macros.',
            items: [
              {
                name: 'Chicken Breast, Cooked',
                grams: 180,
                per100g: { calories: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 },
                microsPer100g: { sodiumMg: 340, cholesterolMg: 85, saturatedFatG: 1.0 },
              },
              {
                name: 'Steamed White Rice',
                grams: 150,
                per100g: { calories: 130, protein: 2.7, carbs: 28.2, fat: 0.3, fiber: 0.4 },
              },
            ],
          },
        ],
      });

      const parsed = parseAiJsonResponse(raw, AiMealIdeasResponseSchema);
      expect(parsed.ideas).toHaveLength(1);
      expect(parsed.ideas[0].title).toBe('Chicken Adobo Rice Bowl');
      expect(parsed.ideas[0].prepMinutes).toBe(15);
      expect(parsed.ideas[0].items).toHaveLength(2);
      expect(parsed.ideas[0].items[0].microsPer100g?.cholesterolMg).toBe(85);
    });

    it('rejects empty title, negative prepMinutes, empty items, or out-of-range ideas count', () => {
      expect(() =>
        AiMealIdeaSchema.parse({
          title: '   ',
          items: [
            {
              name: 'Egg',
              grams: 50,
              per100g: { calories: 155, protein: 13, carbs: 1.1, fat: 11 },
            },
          ],
        })
      ).toThrow();

      expect(() =>
        AiMealIdeaSchema.parse({
          title: 'Bad Prep Time',
          prepMinutes: -5,
          items: [
            {
              name: 'Egg',
              grams: 50,
              per100g: { calories: 155, protein: 13, carbs: 1.1, fat: 11 },
            },
          ],
        })
      ).toThrow();

      expect(() =>
        AiMealIdeaSchema.parse({
          title: 'Empty Items',
          items: [],
        })
      ).toThrow();

      expect(() => AiMealIdeasResponseSchema.parse({ ideas: [] })).toThrow();

      const sevenIdeas = Array.from({ length: 7 }, (_, i) => ({
        title: `Idea ${i + 1}`,
        items: [
          {
            name: 'Egg',
            grams: 50,
            per100g: { calories: 155, protein: 13, carbs: 1.1, fat: 11 },
          },
        ],
      }));
      expect(() => AiMealIdeasResponseSchema.parse({ ideas: sevenIdeas })).toThrow();
    });
  });

  describe('POST /api/ai/meal-ideas', () => {
    it('enforces requireSyncAuth (401 when SYNC_ACCESS_KEY is set and request is unauthenticated)', async () => {
      process.env.SYNC_ACCESS_KEY = 'my-secret-passphrase';
      process.env.AI_BASE_URL = 'https://api.openai.com/v1';
      process.env.AI_API_KEY = 'sk-test';
      process.env.AI_MODEL = 'gpt-4o-mini';

      const unauthReq = new Request('http://localhost/api/ai/meal-ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remaining: { calories: 600, protein: 45, carbs: 60, fat: 18, fiber: 10 },
        }),
      });

      const unauthRes = await postMealIdeas(unauthReq);
      expect(unauthRes.status).toBe(401);
      expect(unauthRes.headers.get('Cache-Control')).toContain('no-store');
      const unauthBody = await unauthRes.json();
      expect(unauthBody.authRequired).toBe(true);
    });

    it('returns 400 with no-store headers when remaining macros payload is missing or non-finite', async () => {
      const badBodies = [
        'not-json',
        JSON.stringify([]),
        JSON.stringify({}),
        JSON.stringify({ remaining: [] }),
        JSON.stringify({ remaining: { calories: '600', protein: 40, carbs: 50, fat: 15 } }),
        JSON.stringify({ remaining: { calories: 600, protein: null, carbs: 50, fat: 15 } }),
      ];

      for (const rawBody of badBodies) {
        const req = new Request('http://localhost/api/ai/meal-ideas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: rawBody,
        });
        const res = await postMealIdeas(req);
        expect(res.status).toBe(400);
        expect(res.headers.get('Cache-Control')).toContain('no-store');
      }
    });

    it('returns 503 with no-store headers when server AI is not configured', async () => {
      delete process.env.AI_BASE_URL;
      delete process.env.AI_API_KEY;
      delete process.env.AI_MODEL;

      const req = new Request('http://localhost/api/ai/meal-ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remaining: { calories: 650, protein: 50, carbs: 65, fat: 20, fiber: 8 },
        }),
      });

      const res = await postMealIdeas(req);
      expect(res.status).toBe(503);
      expect(res.headers.get('Cache-Control')).toContain('no-store');
    });

    it('generates meal ideas tailored to remaining macros + preferencePrompt and enriches items with staples micronutrients', async () => {
      process.env.AI_BASE_URL = 'https://api.openai.com/v1';
      process.env.AI_API_KEY = 'sk-test';
      process.env.AI_MODEL = 'gpt-4o-mini';

      const mockStaples: FoodItem[] = [
        {
          id: 'staple:chicken-breast',
          name: 'Chicken Breast',
          source: 'staple',
          basis: 'per100g',
          servingSize: 100,
          servingUnit: 'g',
          nutrientsPerBasis: { calories: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 },
          micronutrientsPerBasis: {
            sodiumMg: 74,
            potassiumMg: 256,
            ironMg: 1.0,
            vitaminB6Mg: 0.6,
          },
          updatedAt: 1000,
        },
      ];
      setStaplesCache(mockStaples);

      const mockAiIdeas = {
        ideas: [
          {
            title: 'Garlic Chicken & Egg Rice Bowl',
            prepMinutes: 12,
            summary: 'High protein post-workout meal with garlic rice.',
            items: [
              {
                name: 'Chicken Breast',
                grams: 150,
                per100g: { calories: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 },
              },
              {
                name: 'Cooked White Rice',
                grams: 160,
                per100g: { calories: 130, protein: 2.7, carbs: 28.2, fat: 0.3, fiber: 0.4 },
              },
            ],
          },
        ],
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(mockAiIdeas) } }],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const req = new Request('http://localhost/api/ai/meal-ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remaining: { calories: 500, protein: 50, carbs: 50, fat: 12, fiber: 8 },
          preferencePrompt: 'High protein, 10 min prep, use chicken and rice',
        }),
      });

      const res = await postMealIdeas(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toContain('no-store');

      // Prompt sent to upstream LLM includes remaining macros and preferencePrompt
      const [, fetchInit] = fetchMock.mock.calls[0];
      const upstreamPayload = JSON.parse(fetchInit.body as string);
      const promptContent = upstreamPayload.messages[0].content as string;
      expect(promptContent).toContain('500');
      expect(promptContent).toContain('High protein, 10 min prep, use chicken and rice');

      const data = await res.json();
      expect(data.ideas).toHaveLength(1);
      expect(data.ideas[0].title).toBe('Garlic Chicken & Egg Rice Bowl');
      expect(data.ideas[0].prepMinutes).toBe(12);
      // Enriched from staples cache
      expect(data.ideas[0].items[0].microsPer100g?.potassiumMg).toBe(256);
      expect(data.ideas[0].items[0].microsPer100g?.sodiumMg).toBe(74);
    });
  });

  describe('AiMealIdeasDrawer & HITL Handoff', () => {
    it('returns structured meal ideas fitting remaining macros and hands selected idea to HITL review without auto-logging', async () => {
      // Seed goals with weekly cycling for Friday 2026-11-20
      await db.userGoals.put({
        id: 'active',
        dailyCalories: 2000,
        proteinG: 150,
        carbsG: 200,
        fatG: 65,
        fiberG: 30,
        weeklyCyclingEnabled: true,
        weeklySchedule: {
          mon: { calories: 1900, proteinG: 150, carbsG: 180, fatG: 60, fiberG: 28 },
          tue: { calories: 1900, proteinG: 150, carbsG: 180, fatG: 60, fiberG: 28 },
          wed: { calories: 1900, proteinG: 150, carbsG: 180, fatG: 60, fiberG: 28 },
          thu: { calories: 1900, proteinG: 150, carbsG: 180, fatG: 60, fiberG: 28 },
          fri: { calories: 2200, proteinG: 160, carbsG: 230, fatG: 70, fiberG: 32 },
          sat: { calories: 2200, proteinG: 160, carbsG: 230, fatG: 70, fiberG: 32 },
          sun: { calories: 1900, proteinG: 150, carbsG: 180, fatG: 60, fiberG: 28 },
        },
        micronutrientTargets: { ...DEFAULT_RDA_MICROS },
        mealSlots: [],
        updatedAt: 1000,
      });

      // Seed 1 existing food log for 2026-11-20 (1500 kcal, 100P, 150C, 55F, 20Fib)
      // Remaining on Friday (2200 kcal, 160P, 230C, 70F, 32Fib): 700 kcal, 60P, 80C, 15F, 12Fib
      await db.foodLogs.add({
        id: 'log-existing-1',
        date: '2026-11-20',
        mealSlot: 'log',
        foodId: 'staple:lunch',
        name: 'Earlier Meals',
        source: 'staple',
        amount: 400,
        unit: 'g',
        nutritionSnapshot: {
          calories: 1500,
          protein: 100,
          carbs: 150,
          fat: 55,
          fiber: 20,
          micros: {},
        },
        createdAt: 1000,
      });

      const mockIdeasResponse = {
        ideas: [
          {
            title: 'Tinola Chicken & Jasmine Rice',
            prepMinutes: 15,
            summary: 'Light ginger chicken soup with steamed rice and green papaya.',
            items: [
              {
                name: 'Chicken Breast, Cooked',
                grams: 180,
                per100g: { calories: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 },
                microsPer100g: { sodiumMg: 220, potassiumMg: 310 },
              },
              {
                name: 'Jasmine Rice, Cooked',
                grams: 200,
                per100g: { calories: 130, protein: 2.7, carbs: 28.2, fat: 0.3, fiber: 0.4 },
              },
              {
                name: 'Green Papaya, Cooked',
                grams: 120,
                per100g: { calories: 43, protein: 0.5, carbs: 10.8, fat: 0.3, fiber: 1.7 },
              },
            ],
          },
          {
            title: 'Bangus & Egg Sinangag Plate',
            prepMinutes: 10,
            summary: 'Pan-seared milkfish with garlic rice and sunny-side egg.',
            items: [
              {
                name: 'Bangus (Milkfish), Cooked',
                grams: 150,
                per100g: { calories: 190, protein: 24, carbs: 0, fat: 10, fiber: 0 },
              },
              {
                name: 'Garlic Fried Rice',
                grams: 180,
                per100g: { calories: 165, protein: 3.2, carbs: 31, fat: 3.0, fiber: 0.6 },
              },
            ],
          },
        ],
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockIdeasResponse,
      });
      vi.stubGlobal('fetch', fetchMock);

      useLoggerStore.getState().openSheet('meal-ideas');

      const { unmount } = render(
        <AiMealIdeasDrawer
          open={true}
          date="2026-11-20"
          onClose={() => useLoggerStore.getState().closeSheet()}
        />
      );

      // Verify remaining macros from resolveGoalsForDate (700 kcal, 60g P, 80g C, 15g F, 12g Fib)
      await waitFor(() => {
        expect(screen.getByTestId('meal-ideas-remaining-calories')).toHaveTextContent('700');
      });
      expect(screen.getByTestId('meal-ideas-remaining-protein')).toHaveTextContent('60g');
      expect(screen.getByTestId('meal-ideas-remaining-carbs')).toHaveTextContent('80g');
      expect(screen.getByTestId('meal-ideas-remaining-fat')).toHaveTextContent('15g');
      expect(screen.getByTestId('meal-ideas-remaining-fiber')).toHaveTextContent('12g');

      // Enter preference prompt
      const prefInput = screen.getByPlaceholderText(/high protein, 10 min prep/i);
      fireEvent.change(prefInput, { target: { value: 'High protein lutong bahay' } });

      // Click Generate Meal Ideas
      fireEvent.click(screen.getByRole('button', { name: /generate meal ideas/i }));

      // Wait for ideas to render
      await waitFor(() => {
        expect(screen.getByText('Tinola Chicken & Jasmine Rice')).toBeInTheDocument();
        expect(screen.getByText('Bangus & Egg Sinangag Plate')).toBeInTheDocument();
      });

      // Verify fetch payload sent to /api/ai/meal-ideas
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe('/api/ai/meal-ideas');
      const sentBody = JSON.parse(calledInit.body as string);
      expect(sentBody.remaining).toEqual({
        calories: 700,
        protein: 60,
        carbs: 80,
        fat: 15,
        fiber: 12,
      });
      expect(sentBody.preferencePrompt).toBe('High protein lutong bahay');

      // Click "Review & Log" on idea 1
      const reviewButtons = screen.getAllByRole('button', { name: /review & log/i });
      expect(reviewButtons).toHaveLength(2);
      fireEvent.click(reviewButtons[0]);

      // Assert useLoggerStore state transitioned to 'ai-scan', aiDraft.items populated, and db.foodLogs untouched
      const state = useLoggerStore.getState();
      expect(state.activeSheet).toBe('ai-scan');
      expect(state.aiDraft).not.toBeNull();
      expect(state.aiDraft?.imageDataUrl).toBeNull();
      expect(state.aiDraft?.contextPrompt).toBe('Tinola Chicken & Jasmine Rice');
      expect(state.aiDraft?.items).toHaveLength(3);
      expect(state.aiDraft?.items[0].name).toBe('Chicken Breast, Cooked');
      expect(state.aiDraft?.items[0].grams).toBe(180);
      expect(await db.foodLogs.count()).toBe(1); // Only the pre-existing log; never auto-logged!

      unmount();

      // Verify AiMealScannerSheet opens directly in Stage 3 ('Review AI Meal') with the draft items loaded
      render(
        <AiMealScannerSheet
          open={state.activeSheet === 'ai-scan'}
          date="2026-11-20"
          onClose={() => useLoggerStore.getState().closeSheet()}
        />
      );

      expect(screen.getByRole('heading', { name: /review ai meal/i })).toBeInTheDocument();
      expect(screen.getByText('Chicken Breast, Cooked')).toBeInTheDocument();
      expect(screen.getByText('Jasmine Rice, Cooked')).toBeInTheDocument();
      expect(screen.getByText('Green Papaya, Cooked')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /confirm & log/i })).toBeInTheDocument();
    });

    it('clamps remaining macros to 0 and displays adherence-neutral surplus without red (#ef4444) when over target', async () => {
      await db.userGoals.put({
        id: 'active',
        dailyCalories: 2000,
        proteinG: 150,
        carbsG: 200,
        fatG: 65,
        fiberG: 30,
        micronutrientTargets: { ...DEFAULT_RDA_MICROS },
        mealSlots: [],
        updatedAt: 1000,
      });

      await db.foodLogs.add({
        id: 'log-surplus-1',
        date: '2026-11-20',
        mealSlot: 'log',
        foodId: 'staple:feast',
        name: 'Big Feast',
        source: 'staple',
        amount: 500,
        unit: 'g',
        nutritionSnapshot: {
          calories: 2250,
          protein: 170,
          carbs: 210,
          fat: 75,
          fiber: 35,
          micros: {},
        },
        createdAt: 1000,
      });

      render(<AiMealIdeasDrawer open={true} date="2026-11-20" onClose={() => {}} />);

      await waitFor(() => {
        expect(screen.getByText(/\+250 kcal surplus/i)).toBeInTheDocument();
      });

      expect(screen.getByTestId('meal-ideas-remaining-calories')).toHaveTextContent('0');
      expect(screen.getByTestId('meal-ideas-remaining-protein')).toHaveTextContent('0g');
      const drawerEl = screen.getByTestId('ai-meal-ideas-drawer');
      expect(drawerEl.innerHTML).not.toMatch(/#ef4444|text-red|bg-red|border-red/i);
    });

    it('handles 401 from /api/ai/meal-ideas by locking syncAuth and rendering SyncUnlockCard inline', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: async () => ({ ok: false, error: 'Unauthorized', authRequired: true }),
        })
      );

      render(<AiMealIdeasDrawer open={true} date="2026-11-20" onClose={() => {}} />);

      fireEvent.click(screen.getByRole('button', { name: /generate meal ideas/i }));

      await waitFor(() => {
        expect(useLoggerStore.getState().syncAuthLocked).toBe(true);
        expect(screen.getByTestId('sync-unlock-card')).toBeInTheDocument();
      });
    });

    it('registers AI Meal Ideas command in CommandPalette and mounts AiMealIdeasDrawer in AppShell', async () => {
      render(
        <AppShell>
          <div>Dashboard Workspace</div>
        </AppShell>
      );

      // Open Command Palette
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
      expect(screen.getByTestId('command-palette')).toBeInTheDocument();

      const mealIdeasOption = screen.getByRole('option', {
        name: /ai meal ideas/i,
      });
      expect(mealIdeasOption).toHaveTextContent(/fill my remaining macros/i);

      fireEvent.click(mealIdeasOption);

      expect(useLoggerStore.getState().activeSheet).toBe('meal-ideas');
      await waitFor(() => {
        expect(screen.getByTestId('ai-meal-ideas-drawer')).toBeInTheDocument();
      });
    });
  });
});
