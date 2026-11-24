import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { downloadStreamToCache } from '../../../../scripts/catalog-adapters/types';
import {
  USDA_BRANDED_MAX_ITEMS,
  parseUsdaBrandedCsvDir,
} from '../../../../scripts/catalog-adapters/usda';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeMinimalBrandedCsvs(
  dir: string,
  files: {
    brandedFood: string;
    food: string;
    foodNutrient: string;
  }
): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'branded_food.csv'), files.brandedFood, 'utf8');
  fs.writeFileSync(path.join(dir, 'food.csv'), files.food, 'utf8');
  fs.writeFileSync(path.join(dir, 'food_nutrient.csv'), files.foodNutrient, 'utf8');
}

describe('USDA Branded CSV slice adapter & downloadStreamToCache', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exports USDA_BRANDED_MAX_ITEMS as 25_000', () => {
    expect(USDA_BRANDED_MAX_ITEMS).toBe(25_000);
  });

  test('parses valid branded item with source, provider, tier 3, normalized barcode, servingWeightGrams, and household servingOptions', async () => {
    const dir = makeTempDir('usda-branded-valid-');
    tempDirs.push(dir);
    // Put files inside a dated subdirectory (1 level deep) just like USDA ZIP extraction
    const subDir = path.join(dir, 'FoodData_Central_branded_food_csv_2024-10-31');

    writeMinimalBrandedCsvs(subDir, {
      brandedFood: [
        'fdc_id,brand_owner,brand_name,gtin_upc,serving_size,serving_size_unit,household_serving_fulltext,branded_food_category',
        '100001,"Chobani, LLC","Chobani","894-700-010045",150,g,"1 container","Yogurt"',
      ].join('\n'),
      food: [
        'fdc_id,data_type,description,food_category_id,publication_date',
        '100001,branded_food,"CHOBANI, NON-FAT GREEK YOGURT, PLAIN",,2024-10-31',
      ].join('\n'),
      foodNutrient: [
        'id,fdc_id,nutrient_id,amount',
        '1,100001,1008,59',
        '2,100001,1003,10.0',
        '3,100001,1005,3.6',
        '4,100001,1004,0.4',
        '5,100001,1079,0',
        '6,100001,1093,36',
        '7,100001,2000,3.2',
        '8,100001,1258,0.1',
      ].join('\n'),
    });

    const records = await parseUsdaBrandedCsvDir(dir, 10);
    expect(records).toHaveLength(1);

    const item = records[0];
    expect(item.id).toBe('usda:100001');
    expect(item.source).toBe('usda');
    expect(item.sourceProvider).toBe('usda_branded');
    expect(item.accuracyTier).toBe(3);
    expect(item.barcode).toBe('0894700010045');
    expect(item.brand).toBe('Chobani');
    expect(item.servingWeightGrams).toBe(150);
    expect(item.basis).toBe('per100g');
    expect(item.nutrientsPerBasis).toEqual({
      calories: 59,
      protein: 10,
      carbs: 3.6,
      fat: 0.4,
      fiber: 0,
    });
    expect(item.micronutrientsPerBasis).toEqual({
      sodiumMg: 36,
      sugarG: 3.2,
      saturatedFatG: 0.1,
    });
    expect(item.servingOptions?.some((opt) => opt.unit === 'container' && opt.grams === 150)).toBe(
      true
    );
  });

  test('rejects rows with all-zero macros or kJ-stuffed calories > 950', async () => {
    const dir = makeTempDir('usda-branded-gate-');
    tempDirs.push(dir);

    writeMinimalBrandedCsvs(dir, {
      brandedFood: [
        'fdc_id,brand_owner,brand_name,gtin_upc,serving_size,serving_size_unit,household_serving_fulltext,branded_food_category',
        '200001,"ZeroCo","ZeroCo","012345678905",30,g,"1 bar","Snacks"',
        '200002,"KjCo","KjCo","012345678912",50,g,"1 cup","Snacks"',
        '200003,"GoodCo","GoodCo","012345678929",40,g,"2 slices","Bread"',
      ].join('\n'),
      food: [
        'fdc_id,data_type,description',
        '200001,branded_food,"EMPTY MACRO BAR"',
        '200002,branded_food,"KJ STUFFED CRACKER"',
        '200003,branded_food,"WHOLE WHEAT BREAD"',
      ].join('\n'),
      foodNutrient: [
        'id,fdc_id,nutrient_id,amount',
        // 200001: all-zero
        '1,200001,1008,0',
        '2,200001,1003,0',
        '3,200001,1005,0',
        '4,200001,1004,0',
        // 200002: kJ-stuffed (> 950 kcal)
        '5,200002,1008,1850',
        '6,200002,1003,8',
        '7,200002,1005,65',
        '8,200002,1004,15',
        // 200003: valid
        '9,200003,1008,250',
        '10,200003,1003,9',
        '11,200003,1005,45',
        '12,200003,1004,3.5',
      ].join('\n'),
    });

    const records = await parseUsdaBrandedCsvDir(dir, 10);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('usda:200003');
    // 2 slices = 40g -> 1 slice = 20g
    expect(records[0].servingOptions?.some((opt) => opt.unit === 'slice' && opt.grams === 20)).toBe(
      true
    );
  });

  test('strictly enforces maxItems cap', async () => {
    const dir = makeTempDir('usda-branded-cap-');
    tempDirs.push(dir);

    writeMinimalBrandedCsvs(dir, {
      brandedFood: [
        'fdc_id,brand_owner,brand_name,gtin_upc,serving_size,serving_size_unit,household_serving_fulltext,branded_food_category',
        '300001,"BrandA","BrandA","001111111111",30,g,"1 bar","Snacks"',
        '300002,"BrandB","BrandB","002222222222",30,g,"1 bar","Snacks"',
        '300003,"BrandC","BrandC","003333333333",30,g,"1 bar","Snacks"',
        '300004,"BrandD","BrandD","004444444444",30,g,"1 bar","Snacks"',
      ].join('\n'),
      food: [
        'fdc_id,data_type,description',
        '300001,branded_food,"PROTEIN BAR ALPHA"',
        '300002,branded_food,"PROTEIN BAR BETA"',
        '300003,branded_food,"PROTEIN BAR GAMMA"',
        '300004,branded_food,"PROTEIN BAR DELTA"',
      ].join('\n'),
      foodNutrient: [
        'id,fdc_id,nutrient_id,amount',
        '1,300001,1008,380',
        '2,300001,1003,20',
        '3,300002,1008,390',
        '4,300002,1003,21',
        '5,300003,1008,400',
        '6,300003,1003,22',
        '7,300004,1008,410',
        '8,300004,1003,23',
      ].join('\n'),
    });

    const records = await parseUsdaBrandedCsvDir(dir, 2);
    expect(records).toHaveLength(2);
  });

  test('skips duplicate normalized brand+name rows during streaming', async () => {
    const dir = makeTempDir('usda-branded-dedup-');
    tempDirs.push(dir);

    writeMinimalBrandedCsvs(dir, {
      brandedFood: [
        'fdc_id,brand_owner,brand_name,gtin_upc,serving_size,serving_size_unit,household_serving_fulltext,branded_food_category',
        '400001,"Quest Nutrition","Quest","088884900001",60,g,"1 bar","Nutrition Bars"',
        '400002,"Quest Nutrition","QUEST","088884900002",60,g,"1 bar","Nutrition Bars"',
        '400003,"Quest Nutrition","Quest","088884900003",60,g,"1 bar","Nutrition Bars"',
      ].join('\n'),
      food: [
        'fdc_id,data_type,description',
        '400001,branded_food,"CHOCOLATE CHIP COOKIE DOUGH PROTEIN BAR"',
        '400002,branded_food,"Chocolate Chip Cookie Dough, Protein Bar!"',
        '400003,branded_food,"COOKIES AND CREAM PROTEIN BAR"',
      ].join('\n'),
      foodNutrient: [
        'id,fdc_id,nutrient_id,amount',
        '1,400001,1008,333',
        '2,400001,1003,35',
        '3,400002,1008,333',
        '4,400002,1003,35',
        '5,400003,1008,317',
        '6,400003,1003,35',
      ].join('\n'),
    });

    const records = await parseUsdaBrandedCsvDir(dir, 10);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.id)).toEqual(['usda:400001', 'usda:400003']);
  });

  test('downloadStreamToCache returns cached file, respects offlineOnly, and streams atomically', async () => {
    const dir = makeTempDir('download-stream-');
    tempDirs.push(dir);

    const existingPath = path.join(dir, 'existing.bin');
    fs.writeFileSync(existingPath, 'cached-bytes', 'utf8');
    expect(await downloadStreamToCache('https://example.test/existing', existingPath)).toBe(
      existingPath
    );

    const missingPath = path.join(dir, 'missing.bin');
    expect(
      await downloadStreamToCache('https://example.test/missing', missingPath, {
        offlineOnly: true,
      })
    ).toBeNull();

    const streamedPath = path.join(dir, 'nested', 'streamed.bin');
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello '));
        controller.enqueue(new TextEncoder().encode('streamed world'));
        controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(bodyStream, { status: 200 })
    );

    const result = await downloadStreamToCache('https://example.test/file.bin', streamedPath);
    expect(result).toBe(streamedPath);
    expect(fs.readFileSync(streamedPath, 'utf8')).toBe('hello streamed world');
    expect(fs.existsSync(`${streamedPath}.tmp`)).toBe(false);
  });
});
