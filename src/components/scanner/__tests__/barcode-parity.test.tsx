import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { db } from '@/lib/db/opencalory-db';
import { BarcodeScannerDrawer } from '../barcode-scanner-drawer';
import { CustomFoodModal } from '@/components/recipes/custom-food-modal';
import { getServingOptionsForFood, scaleFoodByOption } from '@/lib/nutrition/scaling';
import { useLoggerStore } from '@/stores/logger-store';

const originalCreateElement = document.createElement.bind(document);

describe('Task 8: Barcode Countable Servings Parity & Standalone CustomFoodModal', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    useLoggerStore.setState({
      activeDate: '2026-11-20',
      activeMealSlot: 'log',
      activeSheet: null,
      aiDraft: null,
      syncAuthLocked: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('displays countable serving options (pack vs g) on barcode hit and scales via scaleFoodByOption', async () => {
    await db.foodsCache.put({
      id: 'off:480001',
      barcode: '480001',
      source: 'off',
      name: 'SkyFlakes Crackers',
      basis: 'per100g',
      servingSize: 100,
      servingUnit: 'g',
      servingWeightGrams: 25,
      servingOptions: [
        { id: 'pack', label: 'pack (25g)', unit: 'pack', grams: 25, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
      nutrientsPerBasis: { calories: 480, protein: 8, carbs: 72, fat: 16, fiber: 4 },
      micronutrientsPerBasis: { sodiumMg: 600 },
      updatedAt: 1,
    });

    const onClose = vi.fn();
    render(<BarcodeScannerDrawer open date="2026-11-20" onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/^barcode$/i), { target: { value: '480001' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /pack \(25g\)/i })).toBeInTheDocument()
    );
    expect(screen.getByText(/120 kcal/i)).toBeInTheDocument(); // 1 pack = 25g = 120 kcal

    // Switch to grams pill (100g = 480 kcal)
    fireEvent.click(screen.getByRole('button', { name: /^g$/i }));
    expect(screen.getByLabelText(/portion amount/i)).toHaveValue(100);
    expect(screen.getByText(/480 kcal/i)).toBeInTheDocument();

    // Switch back to pack (25g) and set 2 packs = 240 kcal
    fireEvent.click(screen.getByRole('button', { name: /pack \(25g\)/i }));
    expect(screen.getByLabelText(/portion amount/i)).toHaveValue(1);
    fireEvent.change(screen.getByLabelText(/portion amount/i), { target: { value: '2' } });
    expect(screen.getByText(/240 kcal/i)).toBeInTheDocument();

    // Log 2 packs
    fireEvent.click(screen.getByRole('button', { name: /log food/i }));
    await waitFor(async () => expect(await db.foodLogs.count()).toBe(1));
    const [logged] = await db.foodLogs.toArray();
    expect(logged.amount).toBe(2);
    expect(logged.unit).toBe('pack');
    expect(logged.nutritionSnapshot.calories).toBe(240);
    expect(logged.nutritionSnapshot.protein).toBe(4);
    expect(logged.nutritionSnapshot.micros.sodiumMg).toBe(300);
  });

  it('shows Edit Product button on custom_barcode hit in BarcodeScannerDrawer and refreshes hit view on save', async () => {
    await db.foodsCache.put({
      id: 'custom_barcode:480099',
      barcode: '480099',
      source: 'custom_barcode',
      name: 'Local Protein Bar',
      brand: 'FitPH',
      basis: 'perServing',
      servingSize: 1,
      servingUnit: 'bar',
      nutrientsPerBasis: { calories: 200, protein: 20, carbs: 18, fat: 6, fiber: 4 },
      micronutrientsPerBasis: { sodiumMg: 120 },
      updatedAt: 1,
    });

    render(<BarcodeScannerDrawer open date="2026-11-20" onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^barcode$/i), { target: { value: '480099' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));

    const editBtn = await screen.findByRole('button', { name: /edit product/i });
    expect(editBtn).toBeInTheDocument();
    fireEvent.click(editBtn);

    // CustomFoodModal opens with initialFood populated
    const nameInput = await screen.findByLabelText(/food name/i);
    expect(nameInput).toHaveValue('Local Protein Bar');

    fireEvent.change(nameInput, { target: { value: 'Local Protein Bar Deluxe' } });
    fireEvent.change(screen.getByLabelText(/serving weight/i), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/^calories$/i), { target: { value: '220' } });

    fireEvent.click(screen.getByRole('button', { name: /save food/i }));

    // Hit card refreshes with updated product details and countable serving option pills
    await waitFor(() =>
      expect(screen.getByText('Local Protein Bar Deluxe')).toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: /bar \(50g\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^g$/i })).toBeInTheDocument();
    expect(screen.getByText(/220 kcal/i)).toBeInTheDocument();
  });

  it('creates standalone custom_food (no barcode required) with servingWeightGrams and extended nutrients', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(<CustomFoodModal open onClose={onClose} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText(/food name/i), {
      target: { value: 'Homemade Energy Bite' },
    });
    fireEvent.change(screen.getByLabelText(/^brand$/i), {
      target: { value: 'Home Kitchen' },
    });
    fireEvent.change(screen.getByLabelText(/serving size/i), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText(/serving unit/i), {
      target: { value: 'piece' },
    });
    fireEvent.change(screen.getByLabelText(/serving weight/i), {
      target: { value: '35' },
    });
    fireEvent.change(screen.getByLabelText(/^calories$/i), {
      target: { value: '140' },
    });
    fireEvent.change(screen.getByLabelText(/^protein$/i), {
      target: { value: '8' },
    });
    fireEvent.change(screen.getByLabelText(/^carbs$/i), {
      target: { value: '15' },
    });
    fireEvent.change(screen.getByLabelText(/^fat$/i), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByLabelText(/^fiber$/i), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText(/^sodium$/i), {
      target: { value: '60' },
    });
    fireEvent.change(screen.getByLabelText(/^potassium$/i), {
      target: { value: '110' },
    });

    // Open collapsible Extended Nutrients section
    fireEvent.click(screen.getByRole('button', { name: /extended nutrients/i }));
    fireEvent.change(screen.getByLabelText(/^sugar$/i), {
      target: { value: '6' },
    });
    fireEvent.change(screen.getByLabelText(/added sugar/i), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText(/saturated fat/i), {
      target: { value: '1.5' },
    });
    fireEvent.change(screen.getByLabelText(/cholesterol/i), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText(/caffeine/i), {
      target: { value: '25' },
    });
    fireEvent.change(screen.getByLabelText(/alcohol/i), {
      target: { value: '0' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save food/i }));

    await waitFor(async () => expect(await db.foodsCache.count()).toBe(1));
    const [saved] = await db.foodsCache.toArray();

    expect(saved.source).toBe('custom_food');
    expect(saved.id).toMatch(/^custom_food:/);
    expect(saved.barcode).toBeUndefined();
    expect(saved.name).toBe('Homemade Energy Bite');
    expect(saved.brand).toBe('Home Kitchen');
    expect(saved.basis).toBe('perServing');
    expect(saved.servingSize).toBe(1);
    expect(saved.servingUnit).toBe('piece');
    expect(saved.servingWeightGrams).toBe(35);
    expect(saved.servingOptions).toEqual([
      { id: 'piece', label: 'piece (35g)', unit: 'piece', grams: 35, defaultAmount: 1 },
      { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
    ]);
    expect(saved.nutrientsPerBasis).toEqual({
      calories: 140,
      protein: 8,
      carbs: 15,
      fat: 5,
      fiber: 3,
    });
    expect(saved.micronutrientsPerBasis).toEqual({
      sodiumMg: 60,
      potassiumMg: 110,
      sugarG: 6,
      addedSugarG: 3,
      saturatedFatG: 1.5,
      cholesterolMg: 10,
      caffeineMg: 25,
      alcoholG: 0,
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: saved.id }));
    expect(onClose).toHaveBeenCalled();
  });

  it('preserves initialFood.id when editing custom_food and supports logOnSave with defaultBarcode', async () => {
    const existing = {
      id: 'custom_food:granola-1',
      source: 'custom_food' as const,
      name: 'Crunchy Granola',
      basis: 'per100g' as const,
      servingSize: 100,
      servingUnit: 'g',
      nutrientsPerBasis: { calories: 450, protein: 10, carbs: 60, fat: 18, fiber: 7 },
      micronutrientsPerBasis: { sodiumMg: 120, sugarG: 14 },
      updatedAt: 1000,
    };
    await db.foodsCache.put(existing);

    const { unmount } = render(
      <CustomFoodModal open initialFood={existing} onClose={vi.fn()} />
    );

    // Extended section auto-opens because initialFood has sugarG
    expect(screen.getByLabelText(/^sugar$/i)).toHaveValue(14);

    fireEvent.change(screen.getByLabelText(/food name/i), {
      target: { value: 'Crunchy Maple Granola' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save food/i }));

    await waitFor(async () => {
      const updated = await db.foodsCache.get('custom_food:granola-1');
      expect(updated?.name).toBe('Crunchy Maple Granola');
    });
    unmount();

    // Also test defaultBarcode + logOnSave
    render(
      <CustomFoodModal
        open
        defaultBarcode="480777666"
        logOnSave
        date="2026-11-20"
        onClose={vi.fn()}
      />
    );
    fireEvent.change(screen.getByLabelText(/food name/i), {
      target: { value: 'Canned Tuna Flakes' },
    });
    fireEvent.change(screen.getByLabelText(/serving unit/i), {
      target: { value: 'can' },
    });
    fireEvent.change(screen.getByLabelText(/serving weight/i), {
      target: { value: '150' },
    });
    fireEvent.change(screen.getByLabelText(/^calories$/i), {
      target: { value: '180' },
    });
    fireEvent.change(screen.getByLabelText(/^protein$/i), {
      target: { value: '32' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save & log/i }));

    await waitFor(async () => {
      expect(await db.foodsCache.get('custom_barcode:480777666')).toBeDefined();
    });
    expect(await db.foodLogs.count()).toBe(1);
    const [log] = await db.foodLogs.toArray();
    expect(log.foodId).toBe('custom_barcode:480777666');
    expect(log.amount).toBe(1);
    expect(log.unit).toBe('can');
    expect(log.nutritionSnapshot.calories).toBe(180);
  });

  it('handles 401 from /api/ai/label-ocr in CustomFoodModal by locking sync auth and rendering inline SyncUnlockCard', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'Unauthorized', authRequired: true }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({
        width: 200,
        height: 200,
        close: vi.fn(),
      })
    );
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: vi.fn() }),
          toDataURL: () => 'data:image/jpeg;base64,mockocrimage',
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    });

    render(<CustomFoodModal open onClose={vi.fn()} />);

    // Type a food name first to verify form state is preserved on 401
    fireEvent.change(screen.getByLabelText(/food name/i), {
      target: { value: 'Draft Custom Food' },
    });

    const file = new File(['label'], 'label.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('ocr-file-input'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(useLoggerStore.getState().syncAuthLocked).toBe(true);
    });
    expect(screen.getByTestId('sync-unlock-card')).toBeInTheDocument();
    expect(screen.getByLabelText(/food name/i)).toHaveValue('Draft Custom Food');
  });

  it('creates per100g food with countable unit (pack 25g) without undercounting 1 pack and blocks missing weight', async () => {
    render(<CustomFoodModal open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/food name/i), {
      target: { value: 'Crackers Pack' },
    });
    fireEvent.click(screen.getByRole('button', { name: /per 100g/i }));

    // Unambiguous per-100g labeling and metric Serving Size lock
    expect(screen.getByText(/nutrition values \(per 100g\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/serving size/i)).toHaveAttribute('readonly');
    expect(screen.getByLabelText(/serving size/i)).toHaveValue(100);

    fireEvent.change(screen.getByLabelText(/serving unit/i), { target: { value: 'pack' } });
    expect(screen.getByLabelText(/serving size/i)).not.toHaveAttribute('readonly');
    fireEvent.change(screen.getByLabelText(/serving size/i), { target: { value: '1' } });

    // Missing countable serving weight in per100g mode must be blocked cleanly
    fireEvent.change(screen.getByLabelText(/^calories$/i), { target: { value: '480' } });
    fireEvent.click(screen.getByRole('button', { name: /save food/i }));
    expect(await db.foodsCache.count()).toBe(0);
    expect(screen.getByText(/weight.*countable/i)).toBeInTheDocument();

    // Provide 25g per pack and save per-100g nutrition
    fireEvent.change(screen.getByLabelText(/serving weight/i), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText(/^protein$/i), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText(/^carbs$/i), { target: { value: '72' } });
    fireEvent.change(screen.getByLabelText(/^fat$/i), { target: { value: '16' } });
    fireEvent.change(screen.getByLabelText(/^fiber$/i), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText(/^sodium$/i), { target: { value: '600' } });

    fireEvent.click(screen.getByRole('button', { name: /save food/i }));

    await waitFor(async () => expect(await db.foodsCache.count()).toBe(1));
    const [saved] = await db.foodsCache.toArray();
    expect(saved.basis).toBe('per100g');
    expect(saved.servingSize).toBe(100);
    expect(saved.servingUnit).toBe('g');
    expect(saved.servingWeightGrams).toBe(25);
    expect(saved.nutrientsPerBasis.calories).toBe(480);
    expect(saved.micronutrientsPerBasis.sodiumMg).toBe(600);
    expect(saved.servingOptions).toEqual([
      { id: 'pack', label: 'pack (25g)', unit: 'pack', grams: 25, defaultAmount: 1 },
      { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
    ]);

    const packOpt = saved.servingOptions![0];
    const scaledPack = scaleFoodByOption(saved, 1, packOpt);
    expect(scaledPack.macros.calories).toBe(120);
    expect(scaledPack.macros.protein).toBe(2);
    expect(scaledPack.micros.sodiumMg).toBe(150);
  });

  it('round-trips per100g food with countable servingOptions and per100g custom servingSize in edit mode without macro drift', async () => {
    const existingPackFood = {
      id: 'custom_food:skyflakes-1',
      source: 'custom_food' as const,
      name: 'SkyFlakes Crackers',
      basis: 'per100g' as const,
      servingSize: 100,
      servingUnit: 'g',
      servingWeightGrams: 25,
      servingOptions: [
        { id: 'pack', label: 'pack (25g)', unit: 'pack', grams: 25, defaultAmount: 1 },
        { id: 'g', label: 'g', unit: 'g', grams: 1, defaultAmount: 100 },
      ],
      nutrientsPerBasis: { calories: 480, protein: 8, carbs: 72, fat: 16, fiber: 4 },
      micronutrientsPerBasis: { sodiumMg: 600 },
      updatedAt: 1000,
    };
    const existing50gFood = {
      id: 'custom_food:oats-50',
      source: 'custom_food' as const,
      name: 'Rolled Oats',
      basis: 'per100g' as const,
      servingSize: 50,
      servingUnit: 'g',
      nutrientsPerBasis: { calories: 380, protein: 14, carbs: 66, fat: 7, fiber: 10 },
      micronutrientsPerBasis: {},
      updatedAt: 1000,
    };
    await db.foodsCache.bulkPut([existingPackFood, existing50gFood]);

    const { unmount } = render(
      <CustomFoodModal open initialFood={existingPackFood} onClose={vi.fn()} />
    );

    expect(screen.getByText(/nutrition values \(per 100g\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^calories$/i)).toHaveValue(480);
    expect(screen.getByLabelText(/serving unit/i)).toHaveValue('pack');
    expect(screen.getByLabelText(/serving weight/i)).toHaveValue(25);

    fireEvent.click(screen.getByRole('button', { name: /save food/i }));

    await waitFor(async () => {
      const updated = await db.foodsCache.get('custom_food:skyflakes-1');
      expect(updated?.updatedAt).toBeGreaterThan(1000);
      expect(updated?.nutrientsPerBasis).toEqual({
        calories: 480,
        protein: 8,
        carbs: 72,
        fat: 16,
        fiber: 4,
      });
      expect(updated?.micronutrientsPerBasis.sodiumMg).toBe(600);
      expect(updated?.servingOptions?.[0]).toMatchObject({ unit: 'pack', grams: 25 });
    });
    unmount();

    render(<CustomFoodModal open initialFood={existing50gFood} onClose={vi.fn()} />);
    expect(screen.getByLabelText(/^calories$/i)).toHaveValue(380);
    fireEvent.click(screen.getByRole('button', { name: /save food/i }));

    await waitFor(async () => {
      const updated50 = await db.foodsCache.get('custom_food:oats-50');
      expect(updated50?.updatedAt).toBeGreaterThan(1000);
      expect(updated50?.nutrientsPerBasis.calories).toBe(380);
    });
  });

  it('canonicalizes id to custom_barcode:<barcode> and removes superseded custom_food:<id> when adding a barcode', async () => {
    const existing = {
      id: 'custom_food:legacy-uuid-123',
      source: 'custom_food' as const,
      name: 'Protein Pudding',
      basis: 'perServing' as const,
      servingSize: 1,
      servingUnit: 'cup',
      servingWeightGrams: 150,
      nutrientsPerBasis: { calories: 160, protein: 20, carbs: 10, fat: 4, fiber: 1 },
      micronutrientsPerBasis: {},
      updatedAt: 1000,
    };
    await db.foodsCache.put(existing);

    render(<CustomFoodModal open initialFood={existing} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/^barcode$/i), {
      target: { value: '480555999' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save food/i }));

    await waitFor(async () => {
      expect(await db.foodsCache.get('custom_barcode:480555999')).toBeDefined();
    });

    expect(await db.foodsCache.get('custom_food:legacy-uuid-123')).toBeUndefined();
    const canonical = await db.foodsCache.get('custom_barcode:480555999');
    expect(canonical?.source).toBe('custom_barcode');
    expect(canonical?.barcode).toBe('480555999');
  });

  it('normalizes metric Label OCR response (servingSize: 30, servingUnit: g) to per-100g and preserves 30g serving option', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: 'Whey Isolate Blend',
          brand: 'PureFit',
          servingSize: 30,
          servingUnit: 'g',
          calories: 150,
          protein: 12,
          carbs: 18,
          fat: 3,
          fiber: 2,
          sugarG: 4,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({
        width: 200,
        height: 200,
        close: vi.fn(),
      })
    );
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: vi.fn() }),
          toDataURL: () => 'data:image/jpeg;base64,mockocrimage',
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    });

    render(<CustomFoodModal open onClose={vi.fn()} />);

    const file = new File(['label'], 'label.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('ocr-file-input'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByLabelText(/food name/i)).toHaveValue('Whey Isolate Blend');
    });

    expect(screen.getByLabelText(/serving size/i)).toHaveValue(100);
    expect(screen.getByLabelText(/serving size/i)).toHaveAttribute('readonly');
    expect(screen.getByLabelText(/serving unit/i)).toHaveValue('g');
    expect(screen.getByLabelText(/serving weight/i)).toHaveValue(30);
    expect(screen.getByLabelText(/^calories$/i)).toHaveValue(500);
    expect(screen.getByLabelText(/^protein$/i)).toHaveValue(40);
    expect(screen.getByLabelText(/^carbs$/i)).toHaveValue(60);
    expect(screen.getByLabelText(/^fat$/i)).toHaveValue(10);

    fireEvent.click(screen.getByRole('button', { name: /save food/i }));

    await waitFor(async () => expect(await db.foodsCache.count()).toBe(1));
    const [saved] = await db.foodsCache.toArray();
    expect(saved.basis).toBe('per100g');
    expect(saved.servingSize).toBe(100);
    expect(saved.servingUnit).toBe('g');
    expect(saved.servingWeightGrams).toBe(30);
    expect(saved.nutrientsPerBasis).toEqual({
      calories: 500,
      protein: 40,
      carbs: 60,
      fat: 10,
      fiber: 6.67,
    });
    expect(saved.micronutrientsPerBasis.sugarG).toBe(13.33);

    const options = getServingOptionsForFood(saved);
    const gramOpt = options.find((o) => o.unit === 'g')!;
    const scaled30g = scaleFoodByOption(saved, 30, gramOpt);
    expect(scaled30g.macros.calories).toBe(150);
    expect(scaled30g.macros.protein).toBe(12);
    expect(scaled30g.macros.carbs).toBe(18);
    expect(scaled30g.macros.fat).toBe(3);
  });
});
