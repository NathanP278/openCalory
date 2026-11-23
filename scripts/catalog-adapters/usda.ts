import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Micronutrients, MacroNutrients } from '@/types/nutrition';
import type { UsdaFoodPayload, UsdaNutrientEntry } from '@/lib/foods/usda-adapter';
import type { CatalogFoodInput } from '@/lib/foods/catalog-schema';
import { cleanFoodDisplayName, generateFoodAliases } from '@/lib/foods/name-normalizer';
import { extractUsdaPortions, enrichServingOptions } from '@/lib/foods/portion-enrichment';
import { normalizeBarcode } from '@/lib/foods/dedup';
import {
  type AdapterLoadOptions,
  type CatalogAdapter,
  computeSearchRank,
  downloadToCache,
  extractZipFile,
  passesMacroQualityGate,
  round2,
} from './types';

export type UsdaDatasetKind = 'foundation' | 'sr_legacy' | 'fndds' | 'branded';

const FOUNDATION_ZIP_URL =
  'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2024-10-31.zip';
const SR_LEGACY_ZIP_URL =
  'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip';
const FNDDS_ZIP_URL =
  'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip';

const FIXED_TIMESTAMP = 1700000000000;

function extractNutrient(entry: UsdaNutrientEntry): {
  id?: number;
  number?: string;
  unit: string;
  value: number;
} {
  const number =
    typeof entry.nutrient?.number === 'string' && entry.nutrient.number.trim()
      ? entry.nutrient.number.trim()
      : typeof entry.nutrientNumber === 'string' && entry.nutrientNumber.trim()
        ? entry.nutrientNumber.trim()
        : undefined;

  const id =
    typeof entry.nutrient?.id === 'number'
      ? entry.nutrient.id
      : typeof entry.nutrientId === 'number'
        ? entry.nutrientId
        : undefined;

  const unit = entry.nutrient?.unitName || entry.unitName || '';
  const rawValue =
    typeof entry.amount === 'number'
      ? entry.amount
      : typeof entry.value === 'number'
        ? entry.value
        : 0;

  const value = Number.isFinite(rawValue) && rawValue > 0 ? rawValue : 0;
  return { id, number, unit, value };
}

function datasetToAccuracyTier(dataset: UsdaDatasetKind): 1 | 2 | 3 {
  switch (dataset) {
    case 'foundation':
    case 'sr_legacy':
      return 1;
    case 'fndds':
      return 2;
    case 'branded':
      return 3;
  }
}

function datasetToSourceProvider(dataset: UsdaDatasetKind): string {
  switch (dataset) {
    case 'foundation':
      return 'usda_foundation';
    case 'sr_legacy':
      return 'usda_sr_legacy';
    case 'fndds':
      return 'usda_fndds';
    case 'branded':
      return 'usda_branded';
  }
}

function extractCategory(raw: UsdaFoodPayload): string | undefined {
  const fc = raw.foodCategory as { description?: string } | string | undefined;
  if (typeof fc === 'string' && fc.trim()) return fc.trim();
  if (fc && typeof fc === 'object' && typeof fc.description === 'string' && fc.description.trim()) {
    return fc.description.trim();
  }
  const wweia = raw.wweiaFoodCategory as { wweiaFoodCategoryDescription?: string } | undefined;
  if (wweia?.wweiaFoodCategoryDescription?.trim()) {
    return wweia.wweiaFoodCategoryDescription.trim();
  }
  if (typeof raw.brandedFoodCategory === 'string' && raw.brandedFoodCategory.trim()) {
    return raw.brandedFoodCategory.trim();
  }
  return undefined;
}

/**
 * Pure parser for a single USDA FoodData Central JSON food object (Foundation, SR Legacy, FNDDS, Branded).
 */
export function parseUsdaFoodRecord(
  raw: UsdaFoodPayload,
  dataset: UsdaDatasetKind
): CatalogFoodInput | null {
  const fdcId = raw.fdcId ?? raw.id;
  if (typeof fdcId !== 'number' || !Number.isFinite(fdcId) || fdcId <= 0) {
    return null;
  }

  const rawName = (raw.description || raw.name || '').trim();
  if (!rawName) return null;

  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  let fiber = 0;
  const micros: Micronutrients = {};

  const nutrientsList = Array.isArray(raw.foodNutrients) ? raw.foodNutrients : [];
  for (const entry of nutrientsList) {
    const { id: nutId, number: nutNum, unit, value } = extractNutrient(entry);
    if (!nutId && !nutNum) continue;

    // Never read kJ energy as kcal
    if (nutId === 1062 || nutNum === '268' || unit.toLowerCase() === 'kj') {
      continue;
    }

    if (nutId === 1008 || nutNum === '208' || nutId === 2047 || nutId === 2048) {
      if (calories === 0 || nutId === 1008 || nutNum === '208') {
        calories = value;
      }
    } else if (nutId === 1003 || nutNum === '203') {
      protein = value;
    } else if (nutId === 1004 || nutNum === '204') {
      fat = value;
    } else if (nutId === 1005 || nutNum === '205') {
      carbs = value;
    } else if (nutId === 1079 || nutNum === '291') {
      fiber = value;
    } else if (nutId === 1093 || nutNum === '307') {
      micros.sodiumMg = round2(value);
    } else if (nutId === 1092 || nutNum === '306') {
      micros.potassiumMg = round2(value);
    } else if (nutId === 1087 || nutNum === '301') {
      micros.calciumMg = round2(value);
    } else if (nutId === 1089 || nutNum === '303') {
      micros.ironMg = round2(value);
    } else if (nutId === 1090 || nutNum === '304') {
      micros.magnesiumMg = round2(value);
    } else if (nutId === 1095 || nutNum === '309') {
      micros.zincMg = round2(value);
    } else if (nutId === 1106 || nutNum === '320') {
      micros.vitaminAMcg = round2(value);
    } else if (nutId === 1162 || nutNum === '401') {
      micros.vitaminCMg = round2(value);
    } else if (nutId === 1114 || nutNum === '328') {
      micros.vitaminDMcg = round2(value);
    } else if (nutId === 1175 || nutNum === '415') {
      micros.vitaminB6Mg = round2(value);
    } else if (nutId === 1178 || nutNum === '418') {
      micros.vitaminB12Mcg = round2(value);
    } else if (nutId === 1177 || nutNum === '417') {
      micros.folateMcg = round2(value);
    } else if (nutId === 2000 || nutId === 1063 || nutNum === '269' || nutNum === '269.3') {
      if (micros.sugarG === undefined || value > 0) {
        micros.sugarG = round2(value);
      }
    } else if (nutId === 1235 || nutNum === '539') {
      micros.addedSugarG = round2(value);
    } else if (nutId === 1258 || nutNum === '606') {
      micros.saturatedFatG = round2(value);
    } else if (nutId === 1253 || nutNum === '601') {
      micros.cholesterolMg = round2(value);
    } else if (nutId === 1057 || nutNum === '262') {
      micros.caffeineMg = round2(value);
    } else if (nutId === 1018 || nutNum === '221') {
      micros.alcoholG = round2(value);
    }
  }

  const nutrientsPerBasis: MacroNutrients = {
    calories: round2(calories),
    protein: round2(protein),
    carbs: round2(carbs),
    fat: round2(fat),
    fiber: round2(fiber),
  };

  const accuracyTier = datasetToAccuracyTier(dataset);
  if (!passesMacroQualityGate(nutrientsPerBasis, accuracyTier)) {
    return null;
  }

  const brandRaw = (raw.brandName || raw.brandOwner || '').trim();
  const brand = brandRaw || undefined;
  const cleanName = cleanFoodDisplayName(rawName, brand);
  if (!cleanName) return null;

  const category = extractCategory(raw);
  const aliases = generateFoodAliases(rawName, cleanName);

  const unitLower = (raw.servingSizeUnit || '').trim().toLowerCase();
  const basis = unitLower === 'ml' ? 'per100ml' : 'per100g';
  const extractedPortions = extractUsdaPortions(raw);
  const servingWeightGrams =
    extractedPortions.length > 0
      ? extractedPortions[0].grams
      : typeof raw.servingSize === 'number' && Number.isFinite(raw.servingSize) && raw.servingSize > 0
        ? round2(raw.servingSize)
        : undefined;

  const servingOptions = enrichServingOptions({
    name: cleanName,
    category,
    basis,
    existingOptions: extractedPortions,
    servingWeightGrams,
  });

  const barcode = normalizeBarcode(typeof raw.gtinUpc === 'string' ? raw.gtinUpc : undefined);
  const canonicalId = `usda:${fdcId}`;
  const legacyIds = [`staple:${fdcId}`, `usda:${fdcId}`];

  const record: CatalogFoodInput = {
    id: canonicalId,
    barcode,
    source: 'usda',
    sourceProvider: datasetToSourceProvider(dataset),
    accuracyTier,
    region: 'US',
    ...(category ? { category } : {}),
    name: cleanName,
    ...(brand ? { brand } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    basis,
    servingSize: 100,
    servingUnit: basis === 'per100ml' ? 'ml' : 'g',
    ...(servingWeightGrams ? { servingWeightGrams } : {}),
    servingOptions,
    nutrientsPerBasis,
    micronutrientsPerBasis: micros,
    updatedAt: FIXED_TIMESTAMP,
    legacyIds,
  };

  record.searchRank = computeSearchRank(record);
  return record;
}

function findJsonFileInDir(dir: string, pattern: RegExp): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.endsWith('.json') && pattern.test(entry)) {
      return path.join(dir, entry);
    }
  }
  return null;
}

async function loadUsdaZipDataset(
  url: string,
  zipName: string,
  jsonPattern: RegExp,
  rootKey: string,
  dataset: UsdaDatasetKind,
  usdaCacheDir: string,
  legacyCacheDir: string,
  options: AdapterLoadOptions
): Promise<CatalogFoodInput[]> {
  // Check existing extracted JSON in either cache dir
  let jsonPath =
    findJsonFileInDir(usdaCacheDir, jsonPattern) ||
    findJsonFileInDir(legacyCacheDir, jsonPattern);

  if (!jsonPath) {
    const zipPath = path.join(usdaCacheDir, zipName);
    const downloaded = await downloadToCache(url, zipPath, {
      offlineOnly: options.offlineOnly,
      timeoutMs: options.timeoutMs ?? 30_000,
    });
    if (!downloaded) return [];
    if (!extractZipFile(downloaded, usdaCacheDir)) return [];
    jsonPath = findJsonFileInDir(usdaCacheDir, jsonPattern);
  }

  if (!jsonPath || !fs.existsSync(jsonPath)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;
    const list = Array.isArray(parsed[rootKey]) ? (parsed[rootKey] as UsdaFoodPayload[]) : [];
    const results: CatalogFoodInput[] = [];
    for (const raw of list) {
      const rec = parseUsdaFoodRecord(raw, dataset);
      if (rec) results.push(rec);
    }
    console.log(`[usda] Parsed ${results.length} records from ${dataset} (${path.basename(jsonPath)})`);
    return results;
  } catch (err) {
    console.warn(
      `[usda] Failed parsing ${jsonPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

export const usdaAdapter: CatalogAdapter = {
  id: 'usda',
  name: 'USDA FoodData Central (Foundation, SR Legacy, FNDDS)',
  license: 'CC0-1.0 / Public Domain',
  async load(options: AdapterLoadOptions): Promise<CatalogFoodInput[]> {
    const usdaCacheDir = path.join(options.cacheDir, 'usda');
    const legacyCacheDir = path.join(os.tmpdir(), 'opencalory-usda');

    const foundation = await loadUsdaZipDataset(
      FOUNDATION_ZIP_URL,
      'foundation.zip',
      /foundation.*\.json$/i,
      'FoundationFoods',
      'foundation',
      usdaCacheDir,
      legacyCacheDir,
      options
    );

    const srLegacy = await loadUsdaZipDataset(
      SR_LEGACY_ZIP_URL,
      'sr_legacy.zip',
      /sr_legacy.*\.json$/i,
      'SRLegacyFoods',
      'sr_legacy',
      usdaCacheDir,
      legacyCacheDir,
      options
    );

    const fndds = await loadUsdaZipDataset(
      FNDDS_ZIP_URL,
      'fndds.zip',
      /survey.*\.json$/i,
      'SurveyFoods',
      'fndds',
      usdaCacheDir,
      legacyCacheDir,
      options
    );

    return [...foundation, ...srLegacy, ...fndds];
  },
};
