import 'fake-indexeddb/auto';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { useLoggerStore, type AiDraftItem } from '@/stores/logger-store';
import { db } from '@/lib/db/opencalory-db';
import { AiMealScannerSheet, tryDeterministicRefine } from '../ai-meal-scanner-sheet';
import { AppShell } from '@/components/shell/app-shell';
import type { FoodItem } from '@/types/nutrition';

const originalCreateElement = document.createElement.bind(document);

describe('Task 10: AI Meal Scanner Sheet & HITL Review', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    useLoggerStore.setState({
      activeDate: '2026-11-14',
      activeMealSlot: 'lunch',
      activeSheet: null,
      aiDraft: null,
      syncAuthLocked: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // 1. Exact test from task-10-brief.md
  test('updates totals instantaneously on multiplier/gram change, swaps food preserving grams, and logs on confirm', async () => {
    useLoggerStore.getState().setAiDraft({
      imageDataUrl: 'data:image/jpeg;base64,abc',
      contextPrompt: 'chicken and rice',
      items: [
        {
          id: '1',
          name: 'AI Rice',
          grams: 100,
          per100g: { calories: 130, protein: 2.7, carbs: 28, fat: 0.3, fiber: 0.4 },
          verifiedSource: null,
        },
      ],
    });
    render(<AiMealScannerSheet open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);

    // Click 1.5x multiplier chip on the row
    fireEvent.click(screen.getByRole('button', { name: '1.5x' }));
    expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('195');
    expect(await db.foodLogs.count()).toBe(0); // never auto-logged

    // Click Confirm & Log
    fireEvent.click(screen.getByRole('button', { name: /confirm & log/i }));
    await waitFor(async () => expect(await db.foodLogs.count()).toBe(1));
    const entries = await db.foodLogs.toArray();
    expect(entries[0].amount).toBe(150);
    expect(entries[0].nutritionSnapshot.calories).toBe(195);
    expect(entries[0].source).toBe('ai_scan');
    expect(useLoggerStore.getState().aiDraft).toBeNull();
  });

  // 2. Multipliers and direct inputs without compounding
  test('handles quick multipliers (0.5x, 1x, 2x) and direct numeric/slider input cleanly without compounding', async () => {
    useLoggerStore.getState().setAiDraft({
      imageDataUrl: null,
      contextPrompt: '',
      items: [
        {
          id: 'item-1',
          name: 'Grilled Chicken',
          grams: 200,
          per100g: { calories: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 },
          verifiedSource: null,
        },
      ],
    });

    render(<AiMealScannerSheet open date="2026-11-14" mealSlot="dinner" onClose={() => {}} />);

    // Baseline is 200g -> 330 kcal
    expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('330');

    // Click 0.5x -> 100g -> 165 kcal
    fireEvent.click(screen.getByRole('button', { name: '0.5x' }));
    expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('165');

    // Click 2x -> 400g (200g baseline * 2, not 100g * 2) -> 660 kcal
    fireEvent.click(screen.getByRole('button', { name: '2x' }));
    expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('660');

    // Click 1x -> back to 200g -> 330 kcal
    fireEvent.click(screen.getByRole('button', { name: '1x' }));
    expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('330');

    // Numeric input direct edit
    const numInput = screen.getByRole('spinbutton', { name: /grams for Grilled Chicken/i });
    fireEvent.change(numInput, { target: { value: '150' } });
    expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('248'); // 165 * 1.5 = 247.5 -> 248

    // Range slider edit
    const rangeSlider = screen.getByRole('slider', { name: /gram slider for Grilled Chicken/i });
    fireEvent.change(rangeSlider, { target: { value: '250' } });
    expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('413'); // 165 * 2.5 = 412.5 -> 413
  });

  // 3. Verification Swap preserves row grams and handles perServing conversion
  test('verification swap modal searches staples/cache/usda, swaps food preserving current grams, and handles perServing density', async () => {
    // Seed cached custom product with perServing basis
    const cachedItem: FoodItem = {
      id: 'custom:protein-shake',
      name: 'Custom Protein Shake',
      source: 'custom_barcode',
      basis: 'perServing',
      servingSize: 50,
      servingUnit: 'g',
      nutrientsPerBasis: { calories: 180, protein: 30, carbs: 4, fat: 2, fiber: 1 },
      micronutrientsPerBasis: { calciumMg: 200 },
      updatedAt: Date.now(),
    };
    await db.foodsCache.put(cachedItem);

    // Seed staple in mock staples or staple search
    useLoggerStore.getState().setAiDraft({
      imageDataUrl: null,
      contextPrompt: '',
      items: [
        {
          id: 'item-swap',
          name: 'Generic White Rice',
          grams: 150,
          per100g: { calories: 130, protein: 2.7, carbs: 28, fat: 0.3, fiber: 0.4 },
          verifiedSource: null,
        },
      ],
    });

    render(<AiMealScannerSheet open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);

    // Click Verify / Swap button on the row
    fireEvent.click(screen.getByRole('button', { name: /verify \/ swap/i }));

    // Modal opens
    expect(screen.getByRole('dialog', { name: /verify or swap food/i })).toBeInTheDocument();

    // Search for cached protein shake
    const searchInput = screen.getByPlaceholderText(/search staples, usda, or saved foods/i);
    fireEvent.change(searchInput, { target: { value: 'Protein Shake' } });

    // Wait for search results
    await waitFor(() => {
      expect(screen.getByText('Custom Protein Shake')).toBeInTheDocument();
    });

    // Select the food
    fireEvent.click(screen.getByText('Custom Protein Shake'));

    // Modal closes
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /verify or swap food/i })).not.toBeInTheDocument();
    });

    // Current grams (150g) must be preserved!
    // Density converted from perServing (50g): 180 kcal / 50g = 360 kcal / 100g.
    // For 150g: 360 * 1.5 = 540 kcal!
    expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('540');
    expect(screen.getByText('Custom Protein Shake')).toBeInTheDocument();
    // Badge shows verified source
    expect(screen.getByText(/verified/i)).toBeInTheDocument();
  });

  // 4. Add missing ingredient and delete item
  test('allows deleting an item and adding a missing ingredient', async () => {
    useLoggerStore.getState().setAiDraft({
      imageDataUrl: null,
      contextPrompt: '',
      items: [
        {
          id: 'item-del',
          name: 'Extra Butter',
          grams: 20,
          per100g: { calories: 717, protein: 0.9, carbs: 0.1, fat: 81, fiber: 0 },
          verifiedSource: null,
        },
        {
          id: 'item-keep',
          name: 'Steamed Broccoli',
          grams: 100,
          per100g: { calories: 35, protein: 2.4, carbs: 7.2, fat: 0.4, fiber: 2.6 },
          verifiedSource: null,
        },
      ],
    });

    render(<AiMealScannerSheet open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);

    // Initial calories: 20g butter (143.4) + 100g broccoli (35) = 178 kcal
    expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('178');

    // Delete butter
    const deleteButterBtn = screen.getByRole('button', { name: /delete Extra Butter/i });
    fireEvent.click(deleteButterBtn);

    // Only broccoli remains: 35 kcal
    expect(screen.queryByText('Extra Butter')).not.toBeInTheDocument();
    expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('35');

    // Add missing ingredient
    fireEvent.click(screen.getByRole('button', { name: /add missing ingredient/i }));
    expect(screen.getByRole('dialog', { name: /verify or swap food|add ingredient/i })).toBeInTheDocument();

    // Type manual ingredient if not searching, or select food
    const nameInput = screen.getByPlaceholderText(/ingredient name/i);
    const gramsInput = screen.getByPlaceholderText(/grams/i);
    const calInput = screen.getByPlaceholderText(/calories per 100g/i);
    fireEvent.change(nameInput, { target: { value: 'Olive Oil' } });
    fireEvent.change(gramsInput, { target: { value: '10' } });
    fireEvent.change(calInput, { target: { value: '884' } });

    fireEvent.click(screen.getByRole('button', { name: /add to meal/i }));

    // Olive oil added: 10g of 884 kcal/100g = 88.4 kcal + 35 = 123 kcal
    await waitFor(() => {
      expect(screen.getByText('Olive Oil')).toBeInTheDocument();
      expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('123');
    });
  });

  // 5. Stage 1 Image Intake -> Stage 2 Pre-Scan HITL Context -> /api/ai/meal-scan -> Stage 3 Review
  test('Stage 1 intakes photo first, transitions to pre-scan HITL context, analyzes via /api/ai/meal-scan, and transitions to review', async () => {
    // Mock createImageBitmap and canvas for compressImageToJpeg
    const mockClose = vi.fn();
    const mockBitmap = { width: 800, height: 600, close: mockClose };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(mockBitmap));

    const mockDrawImage = vi.fn();
    const mockToDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,compressed-jpeg-data');

    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: mockDrawImage }),
          toDataURL: mockToDataURL,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    });

    // Mock fetch for /api/ai/meal-scan
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/ai/meal-scan')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                name: 'Grilled Salmon',
                grams: 180,
                per100g: { calories: 208, protein: 22, carbs: 0, fat: 13, fiber: 0 },
              },
              {
                name: 'Asparagus',
                grams: 100,
                per100g: { calories: 20, protein: 2.2, carbs: 3.9, fat: 0.1, fiber: 2.1 },
              },
            ],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    render(<AiMealScannerSheet open date="2026-11-14" mealSlot="dinner" onClose={() => {}} />);

    // Stage 1: Image Intake only (no context prompt or Analyze button yet)
    expect(screen.getByText(/ai meal scanner/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/cooking oil, sauces, prep style/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /analyze meal/i })).not.toBeInTheDocument();

    // Upload an image file
    const file = new File(['fake-image'], 'meal.jpg', { type: 'image/jpeg' });
    const fileInput = screen.getByLabelText(/upload meal photo|take photo/i, { selector: 'input' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Wait for Stage 2 Pre-Scan HITL transition with image preview and context prompt
    await waitFor(() => {
      expect(screen.getByAltText(/meal preview/i)).toBeInTheDocument();
      expect(screen.getByText(/what's in this meal\?/i)).toBeInTheDocument();
    });

    // Type what's in the meal (HITL before vision scan)
    const promptTextarea = screen.getByPlaceholderText(/cooking oil, sauces, prep style/i);
    fireEvent.change(promptTextarea, { target: { value: 'Cooked with 1 tbsp butter and garlic' } });

    // Vision scan has NOT fired automatically on upload
    expect(fetchSpy).not.toHaveBeenCalled();

    // Click Analyze Meal
    const analyzeBtn = screen.getByRole('button', { name: /analyze meal/i });
    expect(analyzeBtn).not.toBeDisabled();
    fireEvent.click(analyzeBtn);

    // Verify Stage 3 review transition with returned items
    await waitFor(() => {
      expect(screen.getByText('Grilled Salmon')).toBeInTheDocument();
      expect(screen.getByText('Asparagus')).toBeInTheDocument();
    });

    // Total calories: 180g salmon (374.4) + 100g asparagus (20) = 394 kcal
    expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('394');

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/ai/meal-scan',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          imageDataUrl: 'data:image/jpeg;base64,compressed-jpeg-data',
          contextPrompt: 'Cooked with 1 tbsp butter and garlic',
        }),
      })
    );
  });

  // 6. Pre-Scan HITL error handling retains image & context prompt
  test('Pre-Scan HITL shows inline error banner on scan failure while retaining image & context prompt', async () => {
    const mockClose = vi.fn();
    const mockBitmap = { width: 500, height: 500, close: mockClose };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(mockBitmap));

    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: vi.fn() }),
          toDataURL: () => 'data:image/jpeg;base64,retry-data',
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    });

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: 'AI service unavailable. Please try again.' }),
    } as Response);

    render(<AiMealScannerSheet open date="2026-11-14" mealSlot="dinner" onClose={() => {}} />);

    // Intake photo first
    const file = new File(['fake-image'], 'meal.jpg', { type: 'image/jpeg' });
    const fileInput = screen.getByLabelText(/upload meal photo|take photo/i, { selector: 'input' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByAltText(/meal preview/i)).toBeInTheDocument();
    });

    const promptTextarea = screen.getByPlaceholderText(/cooking oil, sauces, prep style/i);
    fireEvent.change(promptTextarea, { target: { value: 'Keep my prompt intact' } });

    fireEvent.click(screen.getByRole('button', { name: /analyze meal/i }));

    // Error banner appears
    await waitFor(() => {
      expect(screen.getByText(/AI service unavailable\. Please try again\./i)).toBeInTheDocument();
    });

    // Image and prompt are preserved
    expect(screen.getByAltText(/meal preview/i)).toBeInTheDocument();
    expect(promptTextarea).toHaveValue('Keep my prompt intact');

    // Can return back to Stage 1 photo intake via back button
    fireEvent.click(screen.getByRole('button', { name: /back to photo upload/i }));
    expect(screen.queryByAltText(/meal preview/i)).not.toBeInTheDocument();
    expect(screen.getByText(/take photo or upload image/i)).toBeInTheDocument();
  });

  // 7. Conversational "Refine with AI" success and error handling
  test('Conversational "Refine with AI" updates draft items on success, and keeps draft intact on error', async () => {
    useLoggerStore.getState().setAiDraft({
      imageDataUrl: 'data:image/jpeg;base64,initial-photo',
      contextPrompt: 'initial context',
      items: [
        {
          id: '1',
          name: 'Pork Chop',
          grams: 150,
          per100g: { calories: 242, protein: 27, carbs: 0, fat: 14, fiber: 0 },
          verifiedSource: null,
        },
      ],
    });

    let refineSuccess = true;
    vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/ai/refine')) {
        if (!refineSuccess) {
          return {
            ok: false,
            status: 422,
            json: async () => ({ error: 'Could not understand refinement instruction' }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                name: 'Pork Chop (Trimmed)',
                grams: 120,
                per100g: { calories: 200, protein: 28, carbs: 0, fat: 9, fiber: 0 },
              },
            ],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    render(<AiMealScannerSheet open date="2026-11-14" mealSlot="dinner" onClose={() => {}} />);

    const refineInput = screen.getByPlaceholderText(/e\.g\., remove the cheese, make the chicken 200g/i);
    const refineBtn = screen.getByRole('button', { name: /refine/i });

    // First test successful refine
    fireEvent.change(refineInput, { target: { value: 'Make it trimmed and 120 grams' } });
    fireEvent.click(refineBtn);

    await waitFor(() => {
      expect(screen.getByText('Pork Chop (Trimmed)')).toBeInTheDocument();
      // 120g * 200 kcal / 100g = 240 kcal
      expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('240');
    });

    // Second test error handling
    refineSuccess = false;
    fireEvent.change(refineInput, { target: { value: 'Invalid gibberish command' } });
    fireEvent.click(refineBtn);

    await waitFor(() => {
      expect(screen.getByText(/Could not understand refinement instruction/i)).toBeInTheDocument();
    });
    // Draft items still intact
    expect(screen.getByText('Pork Chop (Trimmed)')).toBeInTheDocument();
  });

  // 8. AppShell integration and escape key close
  test('AppShell renders AiMealScannerSheet when activeSheet is "ai-scan" and supports Escape key close', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>
    );

    // Initially sheet is closed
    expect(screen.queryByTestId('ai-meal-scanner-sheet')).not.toBeInTheDocument();

    // Open sheet via quick action dock
    fireEvent.click(screen.getByRole('button', { name: /open quick actions/i }));
    const aiScanAction = screen.getByRole('button', { name: /ai meal scan/i });
    fireEvent.click(aiScanAction);

    expect(screen.getByTestId('ai-meal-scanner-sheet')).toBeInTheDocument();

    // Press Escape to close
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useLoggerStore.getState().activeSheet).toBeNull();
  });

  // 9. Regression: Escape key handling with open HitlVerificationSwapModal
  test('regression: opening HitlVerificationSwapModal and pressing Escape closes ONLY swap modal while keeping AiMealScannerSheet open', () => {
    const handleClose = vi.fn();
    useLoggerStore.getState().setAiDraft({
      imageDataUrl: 'data:image/jpeg;base64,photo',
      contextPrompt: '',
      items: [
        {
          id: 'item-esc',
          name: 'Sweet Potato',
          grams: 150,
          per100g: { calories: 86, protein: 1.6, carbs: 20, fat: 0.1, fiber: 3 },
          verifiedSource: null,
        },
      ],
    });

    render(<AiMealScannerSheet open date="2026-11-14" mealSlot="lunch" onClose={handleClose} />);

    // Open swap modal
    fireEvent.click(screen.getByRole('button', { name: /verify \/ swap/i }));
    expect(screen.getByRole('dialog', { name: /verify or swap food/i })).toBeInTheDocument();

    // Press Escape
    fireEvent.keyDown(window, { key: 'Escape' });

    // Swap modal must be closed
    expect(screen.queryByRole('dialog', { name: /verify or swap food/i })).not.toBeInTheDocument();

    // Parent sheet must still be open and handleClose NOT called
    expect(handleClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-meal-scanner-sheet')).toBeInTheDocument();
  });

  // 10. Regression: Confirming & logging resets draft and local state so reopening starts clean in Stage 1
  test('regression: confirming and logging resets draft and local state so reopening starts clean in Stage 1', async () => {
    const handleClose = vi.fn();
    useLoggerStore.getState().setAiDraft({
      imageDataUrl: 'data:image/jpeg;base64,my-test-photo',
      contextPrompt: 'cooked with olive oil',
      items: [
        {
          id: 'item-log',
          name: 'Steak',
          grams: 200,
          per100g: { calories: 250, protein: 26, carbs: 0, fat: 17, fiber: 0 },
          verifiedSource: null,
        },
      ],
    });

    const { rerender } = render(
      <AiMealScannerSheet open date="2026-11-14" mealSlot="dinner" onClose={handleClose} />
    );

    // Confirm and log
    fireEvent.click(screen.getByRole('button', { name: /confirm & log/i }));
    await waitFor(async () => expect(await db.foodLogs.count()).toBe(1));
    expect(handleClose).toHaveBeenCalled();

    // Reopen sheet (simulate close then reopen in AppShell)
    rerender(<AiMealScannerSheet open={false} date="2026-11-14" mealSlot="dinner" onClose={handleClose} />);
    rerender(<AiMealScannerSheet open={true} date="2026-11-14" mealSlot="dinner" onClose={handleClose} />);

    // Should be back to Stage 1 with clean state (no leftover image preview, back on upload screen)
    expect(screen.queryByAltText(/meal preview/i)).not.toBeInTheDocument();
    expect(screen.getByText(/take photo or upload image/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/cooking oil, sauces, prep style/i)).not.toBeInTheDocument();
  });

  // 11. Regression: Refine with AI updates baselineGrams cleanly
  test('regression: clicking 1x after Refine with AI preserves refined gram value instead of reverting to stale pre-refine grams', async () => {
    useLoggerStore.getState().setAiDraft({
      imageDataUrl: 'data:image/jpeg;base64,test',
      contextPrompt: '',
      items: [
        {
          id: '1',
          name: 'Pork Chop',
          grams: 100,
          per100g: { calories: 200, protein: 25, carbs: 0, fat: 10, fiber: 0 },
          verifiedSource: null,
        },
      ],
    });

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: '1',
            name: 'Pork Chop',
            grams: 250,
            per100g: { calories: 200, protein: 25, carbs: 0, fat: 10, fiber: 0 },
          },
        ],
      }),
    } as Response);

    render(<AiMealScannerSheet open date="2026-11-14" mealSlot="dinner" onClose={() => {}} />);

    // Initial grams: 100g -> 200 kcal
    expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('200');

    // Refine to 250g
    const refineInput = screen.getByPlaceholderText(/e\.g\., remove the cheese, make the chicken 200g/i);
    fireEvent.change(refineInput, { target: { value: 'Make it 250 grams' } });
    fireEvent.click(screen.getByRole('button', { name: /refine/i }));

    await waitFor(() => {
      // 250g * 2 = 500 kcal
      expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('500');
    });

    // Now click '1x' multiplier: it must preserve the 250g refined baseline, NOT snap back to 100g!
    fireEvent.click(screen.getByRole('button', { name: '1x' }));
    expect(screen.getByTestId('hitl-total-calories')).toHaveTextContent('500');
  });

  // 12. Fiber and 12 micronutrients display, live scaling, and persistence on Confirm & Log
  test('displays estimated fiber and all 12 micronutrients, updates live on scaling, and logs them to foodLogs', async () => {
    useLoggerStore.getState().setAiDraft({
      imageDataUrl: 'data:image/jpeg;base64,test',
      contextPrompt: 'spinach salmon bowl',
      items: [
        {
          id: 'item-micros',
          name: 'Spinach & Salmon',
          grams: 100,
          per100g: { calories: 150, protein: 16, carbs: 4, fat: 8, fiber: 2.5 },
          microsPer100g: {
            sodiumMg: 120,
            potassiumMg: 450,
            calciumMg: 80,
            ironMg: 2.1,
            magnesiumMg: 60,
            zincMg: 0.9,
            vitaminAMcg: 350,
            vitaminCMg: 18,
            vitaminDMcg: 5.5,
            vitaminB6Mg: 0.4,
            vitaminB12Mcg: 1.8,
            folateMcg: 95,
          },
          verifiedSource: null,
        },
      ],
    });

    render(<AiMealScannerSheet open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);

    // Fiber total is shown
    expect(screen.getByTestId('hitl-total-fiber')).toHaveTextContent('2.5g');

    // Expand Estimated Micronutrients (12)
    fireEvent.click(screen.getByRole('button', { name: /estimated micronutrients/i }));
    const microsGrid = screen.getByTestId('hitl-micronutrients-grid');
    expect(microsGrid).toHaveTextContent('Sodium');
    expect(microsGrid).toHaveTextContent('120mg');
    expect(microsGrid).toHaveTextContent('Potassium');
    expect(microsGrid).toHaveTextContent('450mg');
    expect(microsGrid).toHaveTextContent('Folate');
    expect(microsGrid).toHaveTextContent('95mcg');

    // Scale to 2x (200g) -> values double live
    fireEvent.click(screen.getByRole('button', { name: '2x' }));
    expect(screen.getByTestId('hitl-total-fiber')).toHaveTextContent('5g');
    expect(microsGrid).toHaveTextContent('240mg');
    expect(microsGrid).toHaveTextContent('900mg');
    expect(microsGrid).toHaveTextContent('190mcg');

    // Confirm & Log persists scaled fiber and all 12 micronutrients
    fireEvent.click(screen.getByRole('button', { name: /confirm & log/i }));
    await waitFor(async () => expect(await db.foodLogs.count()).toBe(1));
    const entries = await db.foodLogs.toArray();
    expect(entries[0].nutritionSnapshot.fiber).toBe(5);
    expect(entries[0].nutritionSnapshot.micros).toEqual({
      sodiumMg: 240,
      potassiumMg: 900,
      calciumMg: 160,
      ironMg: 4.2,
      magnesiumMg: 120,
      zincMg: 1.8,
      vitaminAMcg: 700,
      vitaminCMg: 36,
      vitaminDMcg: 11,
      vitaminB6Mg: 0.8,
      vitaminB12Mcg: 3.6,
      folateMcg: 190,
    });
  });

  test('tryDeterministicRefine handles local portion edits without API calls and defers qualitative edits to AI', () => {
    const sampleItems: AiDraftItem[] = [
      {
        id: 'i-chicken',
        name: 'Chicken Breast',
        grams: 150,
        per100g: { calories: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 },
        microsPer100g: {},
        verifiedSource: null,
      },
      {
        id: 'i-rice',
        name: 'White Rice',
        grams: 100,
        per100g: { calories: 130, protein: 2.7, carbs: 28, fat: 0.3, fiber: 0.4 },
        microsPer100g: {},
        verifiedSource: null,
      },
      {
        id: 'i-butter',
        name: 'Butter',
        grams: 15,
        per100g: { calories: 717, protein: 0.9, carbs: 0.1, fat: 81, fiber: 0 },
        microsPer100g: {},
        verifiedSource: null,
      },
    ];

    const singleUpdated = tryDeterministicRefine([sampleItems[0]], 'Make it 250 grams');
    expect(singleUpdated).toHaveLength(1);
    expect(singleUpdated?.[0].grams).toBe(250);

    const doubledRice = tryDeterministicRefine(sampleItems, 'double the rice');
    expect(doubledRice?.find((i) => i.id === 'i-rice')?.grams).toBe(200);

    const removedButter = tryDeterministicRefine(sampleItems, 'remove the butter');
    expect(removedButter).toHaveLength(2);
    expect(removedButter?.some((i) => i.id === 'i-butter')).toBe(false);

    // Qualitative prep changes must still defer to LLM refinement
    expect(tryDeterministicRefine(sampleItems, 'Make it trimmed and 120 grams')).toBeNull();
  });

  // 14. Task 11: Text-Only Describe Meal mode, extended nutrients, and separate Save as Recipe action
  test('supports Describe Meal (Text) without uploading a photo, displays extended nutrients, and renders separate Save as Recipe action in Stage 3', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/ai/meal-scan')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                name: 'Boiled Eggs',
                grams: 100,
                per100g: { calories: 155, protein: 12.6, carbs: 1.1, fat: 10.6, fiber: 0 },
                microsPer100g: {
                  sodiumMg: 124,
                  sugarG: 1.1,
                  saturatedFatG: 3.3,
                  cholesterolMg: 373,
                },
              },
              {
                name: 'White Rice',
                grams: 150,
                per100g: { calories: 130, protein: 2.7, carbs: 28, fat: 0.3, fiber: 0.4 },
                microsPer100g: {
                  sugarG: 0.1,
                  saturatedFatG: 0.1,
                },
              },
              {
                name: 'Black Coffee',
                grams: 240,
                per100g: { calories: 2, protein: 0.2, carbs: 0, fat: 0, fiber: 0 },
                microsPer100g: {
                  caffeineMg: 40,
                },
              },
            ],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    render(<AiMealScannerSheet open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);

    // Strictly NO voice or microphone UI anywhere
    expect(screen.queryByRole('button', { name: /voice|mic|microphone|speak/i })).not.toBeInTheDocument();

    // Photo mode has separate Take Photo (with capture="environment") and Upload Photo (without capture) inputs
    const cameraInput = screen.getByTestId('meal-camera-input');
    const galleryInput = screen.getByLabelText(/upload meal photo/i, { selector: 'input' });
    expect(cameraInput).toHaveAttribute('capture', 'environment');
    expect(galleryInput).not.toHaveAttribute('capture');

    // Switch to "Describe Meal" tab
    const describeTab = screen.getByRole('tab', { name: /describe meal/i });
    fireEvent.click(describeTab);
    expect(describeTab).toHaveAttribute('aria-selected', 'true');

    // Type meal description and click Analyze Meal
    const descInput = screen.getByPlaceholderText(/2 boiled eggs, 150g white rice/i);
    fireEvent.change(descInput, {
      target: { value: '2 boiled eggs, 150g white rice, and 1 cup black coffee' },
    });

    const analyzeBtn = screen.getByRole('button', { name: /analyze meal/i });
    expect(analyzeBtn).not.toBeDisabled();
    fireEvent.click(analyzeBtn);

    // Verify POST /api/ai/meal-scan was called without imageDataUrl
    await waitFor(() => {
      expect(screen.getByText('Boiled Eggs')).toBeInTheDocument();
      expect(screen.getByText('White Rice')).toBeInTheDocument();
      expect(screen.getByText('Black Coffee')).toBeInTheDocument();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/ai/meal-scan',
      expect.objectContaining({
        method: 'POST',
      })
    );
    const scanCallBody = JSON.parse(
      (fetchSpy.mock.calls.find((c) => String(c[0]).includes('/api/ai/meal-scan'))?.[1] as RequestInit)
        .body as string
    );
    expect(scanCallBody.imageDataUrl).toBeUndefined();
    expect(scanCallBody.contextPrompt).toBe('2 boiled eggs, 150g white rice, and 1 cup black coffee');

    // Expand collapsible nutrients breakdown and verify extended nutrients are displayed
    fireEvent.click(screen.getByRole('button', { name: /estimated micronutrients/i }));
    const microsGrid = screen.getByTestId('hitl-micronutrients-grid');
    expect(microsGrid).toHaveTextContent('Sugar');
    expect(microsGrid).toHaveTextContent('Added Sugar');
    expect(microsGrid).toHaveTextContent('Sat. Fat');
    expect(microsGrid).toHaveTextContent('Cholesterol');
    expect(microsGrid).toHaveTextContent('373mg');
    expect(microsGrid).toHaveTextContent('Caffeine');
    expect(microsGrid).toHaveTextContent('96mg'); // 240g * 40mg / 100g = 96mg
    expect(microsGrid).toHaveTextContent('Alcohol');

    // Verify separate "Save as Recipe" button exists alongside "Confirm & Log"
    const saveAsRecipeBtn = screen.getByRole('button', { name: /save as recipe/i });
    expect(saveAsRecipeBtn).toBeInTheDocument();
    fireEvent.click(saveAsRecipeBtn);

    // RecipeBuilderModal opens pre-populated with finalized HITL items
    expect(screen.getByRole('dialog', { name: /new custom recipe/i })).toBeInTheDocument();
    const recipeTitleInput = screen.getByPlaceholderText(/recipe title/i);
    fireEvent.change(recipeTitleInput, { target: { value: 'Power Breakfast Bowl' } });
    fireEvent.click(screen.getByRole('button', { name: /^save recipe$/i }));

    await waitFor(async () => {
      expect(await db.customRecipes.count()).toBe(1);
    });
    const savedRecipes = await db.customRecipes.toArray();
    expect(savedRecipes[0].name).toBe('Power Breakfast Bowl');
    expect(savedRecipes[0].ingredients).toHaveLength(3);
    expect(savedRecipes[0].totalGrams).toBe(490); // 100 + 150 + 240

    // Still not logged to foodLogs until Confirm & Log is clicked
    expect(await db.foodLogs.count()).toBe(0);

    // Confirm & Log preserves extended nutrients in nutritionSnapshot.micros
    fireEvent.click(screen.getByRole('button', { name: /confirm & log/i }));
    await waitFor(async () => {
      expect(await db.foodLogs.count()).toBe(3);
    });
    const logs = await db.foodLogs.toArray();
    const eggLog = logs.find((l) => l.name === 'Boiled Eggs');
    const coffeeLog = logs.find((l) => l.name === 'Black Coffee');
    expect(eggLog?.nutritionSnapshot.micros.saturatedFatG).toBe(3.3);
    expect(eggLog?.nutritionSnapshot.micros.cholesterolMg).toBe(373);
    expect(coffeeLog?.nutritionSnapshot.micros.caffeineMg).toBe(96);
  });

  // 15. Task 11: 401 Unauthorized handling with inline SyncUnlockCard
  test('renders inline SyncUnlockCard on 401 from /api/ai/meal-scan or /api/ai/refine without losing user input', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized', authRequired: true }),
    } as Response);

    render(<AiMealScannerSheet open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);

    // Switch to Describe Meal and trigger scan that returns 401
    fireEvent.click(screen.getByRole('tab', { name: /describe meal/i }));
    const descInput = screen.getByPlaceholderText(/2 boiled eggs, 150g white rice/i);
    fireEvent.change(descInput, { target: { value: '150g grilled chicken breast' } });
    fireEvent.click(screen.getByRole('button', { name: /analyze meal/i }));

    await waitFor(() => {
      expect(useLoggerStore.getState().syncAuthLocked).toBe(true);
      expect(screen.getByTestId('sync-unlock-card')).toBeInTheDocument();
    });
    // Meal description is preserved so user can retry after unlocking
    expect(descInput).toHaveValue('150g grilled chicken breast');

    // Also test 401 from /api/ai/refine in Stage 3
    cleanup();
    useLoggerStore.setState({
      syncAuthLocked: false,
      aiDraft: {
        imageDataUrl: null,
        contextPrompt: 'grilled chicken',
        items: [
          {
            id: 'item-1',
            name: 'Grilled Chicken Breast',
            grams: 150,
            per100g: { calories: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 },
            verifiedSource: null,
          },
        ],
      },
    });

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized', authRequired: true }),
    } as Response);

    render(<AiMealScannerSheet open date="2026-11-14" mealSlot="lunch" onClose={() => {}} />);
    const refineInput = screen.getByPlaceholderText(/e\.g\., remove the cheese, make the chicken 200g/i);
    fireEvent.change(refineInput, { target: { value: 'Swap to grilled salmon fillet' } });
    fireEvent.click(screen.getByRole('button', { name: /refine/i }));

    await waitFor(() => {
      expect(useLoggerStore.getState().syncAuthLocked).toBe(true);
      expect(screen.getByTestId('sync-unlock-card')).toBeInTheDocument();
    });
    expect(screen.getByText('Grilled Chicken Breast')).toBeInTheDocument();
    expect(refineInput).toHaveValue('Swap to grilled salmon fillet');
  });
});
