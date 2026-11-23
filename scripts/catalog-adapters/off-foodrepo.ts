import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { FoodServingOption, MacroNutrients, Micronutrients } from '@/types/nutrition';
import type { CatalogFoodInput } from '@/lib/foods/catalog-schema';
import { cleanFoodDisplayName, generateFoodAliases } from '@/lib/foods/name-normalizer';
import { enrichServingOptions } from '@/lib/foods/portion-enrichment';
import { normalizeBarcode } from '@/lib/foods/dedup';
import { parseHouseholdServingText } from '@/lib/nutrition/scaling';
import {
  type AdapterLoadOptions,
  type CatalogAdapter,
  computeSearchRank,
  passesMacroQualityGate,
  round2,
} from './types';

const FIXED_TIMESTAMP = 1700000000000;

/**
 * Explicit non-US regional quotas for Core tier so SEA, East Asia, Europe, Oceania,
 * Canada, India, and LatAm packaged foods are well-represented without US domination.
 */
export const CORE_OFF_REGION_QUOTAS: Record<string, number> = {
  // SEA
  PH: 1500,
  SG: 800,
  MY: 800,
  ID: 800,
  TH: 800,
  VN: 600,
  // East Asia
  JP: 1500,
  KR: 1000,
  TW: 600,
  HK: 500,
  // Europe
  GB: 1500,
  FR: 1500,
  DE: 1500,
  ES: 1000,
  IT: 1000,
  NL: 800,
  // Oceania
  AU: 1200,
  NZ: 600,
  // Canada, India, LatAm
  CA: 1200,
  IN: 1000,
  MX: 800,
  BR: 800,
  // US & fallback
  US: 2000,
  GLOBAL: 500,
};

const COUNTRY_TAG_TO_ISO: Record<string, string> = {
  'en:philippines': 'PH',
  'en:singapore': 'SG',
  'en:malaysia': 'MY',
  'en:indonesia': 'ID',
  'en:thailand': 'TH',
  'en:vietnam': 'VN',
  'en:japan': 'JP',
  'en:south-korea': 'KR',
  'en:taiwan': 'TW',
  'en:hong-kong': 'HK',
  'en:united-kingdom': 'GB',
  'en:france': 'FR',
  'en:germany': 'DE',
  'en:spain': 'ES',
  'en:italy': 'IT',
  'en:netherlands': 'NL',
  'en:australia': 'AU',
  'en:new-zealand': 'NZ',
  'en:canada': 'CA',
  'en:india': 'IN',
  'en:mexico': 'MX',
  'en:brazil': 'BR',
  'en:united-states': 'US',
  'en:switzerland': 'CH',
};

function toNum(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const n = Number(val.trim());
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function detectOffRegion(countriesTags: unknown): string {
  if (Array.isArray(countriesTags)) {
    for (const tag of countriesTags) {
      if (typeof tag !== 'string') continue;
      const mapped = COUNTRY_TAG_TO_ISO[tag.toLowerCase()];
      if (mapped) return mapped;
    }
  }
  return 'GLOBAL';
}

function parseOffServing(servingSizeText: unknown): {
  servingWeightGrams?: number;
  servingOptions?: FoodServingOption[];
} {
  if (typeof servingSizeText !== 'string' || !servingSizeText.trim()) return {};
  const text = servingSizeText.trim();
  const weightMatch = text.match(/(\d+(?:\.\d+)?)\s*(g|ml)\b/i);
  const grams = weightMatch ? round2(Number(weightMatch[1])) : undefined;
  const parsed = parseHouseholdServingText(text);
  if (parsed && grams && grams > 0 && parsed.unit !== 'g' && parsed.unit !== 'ml') {
    const perUnit = round2(grams / parsed.count);
    return {
      servingWeightGrams: perUnit,
      servingOptions: [
        {
          id: parsed.unit,
          label: `${parsed.unit} (${perUnit}g)`,
          unit: parsed.unit,
          grams: perUnit,
          defaultAmount: 1,
        },
      ],
    };
  }
  return grams && grams > 0 ? { servingWeightGrams: grams } : {};
}

/**
 * Pure parser for Open Food Facts JSONL lines enforcing `passesMacroQualityGate(..., 4)`
 * and explicit non-US regional quotas in `core` mode.
 */
export function parseOffJsonlLines(
  lines: Iterable<string>,
  options?: { tier?: 'core' | 'expanded'; regionQuotas?: Record<string, number> }
): CatalogFoodInput[] {
  const tier = options?.tier ?? 'core';
  const quotas = options?.regionQuotas ?? CORE_OFF_REGION_QUOTAS;
  const regionCounts = new Map<string, number>();
  const results: CatalogFoodInput[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const rawName = String(obj.product_name || obj.product_name_en || '').trim();
    if (!rawName) continue;

    const region = detectOffRegion(obj.countries_tags);
    if (tier === 'core') {
      const cap = quotas[region] ?? quotas.GLOBAL ?? 500;
      const current = regionCounts.get(region) ?? 0;
      if (current >= cap) continue;
    }

    const nut = (obj.nutriments as Record<string, unknown>) || {};
    const calories = round2(toNum(nut['energy-kcal_100g'] ?? nut['energy-kcal']));
    const protein = round2(toNum(nut.proteins_100g));
    const carbs = round2(toNum(nut.carbohydrates_100g));
    const fat = round2(toNum(nut.fat_100g));
    const fiber = round2(toNum(nut.fiber_100g));

    const nutrientsPerBasis: MacroNutrients = { calories, protein, carbs, fat, fiber };
    if (!passesMacroQualityGate(nutrientsPerBasis, 4)) continue;

    const barcode = normalizeBarcode(typeof obj.code === 'string' ? obj.code : String(obj.code ?? ''));
    const brandRaw = typeof obj.brands === 'string' ? obj.brands.split(',')[0].trim() : '';
    const brand = brandRaw || undefined;
    const cleanName = cleanFoodDisplayName(rawName, brand);
    if (!cleanName) continue;

    const categories = Array.isArray(obj.categories_tags) ? obj.categories_tags : [];
    const firstCat = typeof categories[0] === 'string' ? categories[0].replace(/^[a-z]{2}:/, '').replace(/-/g, ' ') : undefined;

    const aliases = generateFoodAliases(rawName, cleanName);
    const { servingWeightGrams, servingOptions: parsedServing } = parseOffServing(obj.serving_size);
    const servingOptions = enrichServingOptions({
      name: cleanName,
      category: firstCat,
      basis: 'per100g',
      existingOptions: parsedServing,
      servingWeightGrams,
    });

    const micros: Micronutrients = {};
    const sodiumG = toNum(nut.sodium_100g);
    if (sodiumG > 0) micros.sodiumMg = round2(sodiumG * 1000);
    const sugars = toNum(nut.sugars_100g);
    if (sugars > 0) micros.sugarG = round2(sugars);
    const satFat = toNum(nut['saturated-fat_100g']);
    if (satFat > 0) micros.saturatedFatG = round2(satFat);

    const idSuffix = barcode || `${region.toLowerCase()}-${results.length + 1}`;
    const record: CatalogFoodInput = {
      id: `off:${idSuffix}`,
      barcode,
      source: 'off',
      sourceProvider: 'openfoodfacts',
      accuracyTier: 4,
      region,
      ...(firstCat ? { category: firstCat } : {}),
      name: cleanName,
      ...(brand ? { brand } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      basis: 'per100g',
      servingSize: 100,
      servingUnit: 'g',
      ...(servingWeightGrams ? { servingWeightGrams } : {}),
      servingOptions,
      nutrientsPerBasis,
      micronutrientsPerBasis: micros,
      updatedAt: FIXED_TIMESTAMP,
    };

    record.searchRank = computeSearchRank(record);
    results.push(record);
    regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
  }

  return results;
}

/**
 * Pure parser for FoodRepo (CC BY 4.0) JSON payloads.
 */
export function parseFoodRepoJson(jsonText: string): CatalogFoodInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).data)
      ? ((parsed as Record<string, unknown>).data as unknown[])
      : [];

  const results: CatalogFoodInput[] = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;

    const translations = rec.display_name_translations as Record<string, string> | undefined;
    const rawName = (
      translations?.en ||
      translations?.de ||
      translations?.fr ||
      translations?.it ||
      (typeof rec.name === 'string' ? rec.name : '')
    ).trim();
    if (!rawName) continue;

    const nutrients = (rec.nutrients as Record<string, { per_hundred?: number }>) || {};
    const calories = round2(
      toNum(nutrients.energy_calories_kcal?.per_hundred ?? nutrients.energy_kcal?.per_hundred)
    );
    const protein = round2(toNum(nutrients.protein?.per_hundred));
    const carbs = round2(toNum(nutrients.carbohydrates?.per_hundred));
    const fat = round2(toNum(nutrients.fat?.per_hundred));
    const fiber = round2(toNum(nutrients.fiber?.per_hundred));

    const nutrientsPerBasis: MacroNutrients = { calories, protein, carbs, fat, fiber };
    if (!passesMacroQualityGate(nutrientsPerBasis, 3)) continue;

    const barcode = normalizeBarcode(typeof rec.barcode === 'string' ? rec.barcode : undefined);
    const region =
      typeof rec.country === 'string' && rec.country.trim()
        ? rec.country.trim().toUpperCase()
        : 'CH';
    const cleanName = cleanFoodDisplayName(rawName);
    const aliases = generateFoodAliases(rawName, cleanName);

    const portionQty = toNum(rec.portion_quantity);
    const servingWeightGrams = portionQty > 0 ? round2(portionQty) : undefined;
    const servingOptions = enrichServingOptions({
      name: cleanName,
      basis: 'per100g',
      servingWeightGrams,
    });

    const record: CatalogFoodInput = {
      id: `foodrepo:${rec.id ?? barcode ?? i + 1}`,
      barcode,
      source: 'catalog',
      sourceProvider: 'foodrepo',
      accuracyTier: 3,
      region,
      name: cleanName,
      ...(aliases.length > 0 ? { aliases } : {}),
      basis: 'per100g',
      servingSize: 100,
      servingUnit: 'g',
      ...(servingWeightGrams ? { servingWeightGrams } : {}),
      servingOptions,
      nutrientsPerBasis,
      micronutrientsPerBasis: {},
      updatedAt: FIXED_TIMESTAMP,
    };

    record.searchRank = computeSearchRank(record);
    results.push(record);
  }

  return results;
}

async function streamOffJsonlFile(
  filePath: string,
  tier: 'core' | 'expanded'
): Promise<CatalogFoodInput[]> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const quotas = CORE_OFF_REGION_QUOTAS;
  const regionCounts = new Map<string, number>();
  const results: CatalogFoodInput[] = [];
  const maxCoreTotal = Object.values(quotas).reduce((a, b) => a + b, 0);

  for await (const line of rl) {
    if (tier === 'core' && results.length >= maxCoreTotal) {
      rl.close();
      break;
    }
    const parsed = parseOffJsonlLines([line], {
      tier,
      regionQuotas: Object.fromEntries(
        Object.entries(quotas).map(([k, v]) => [k, Math.max(0, v - (regionCounts.get(k) ?? 0))])
      ),
    });
    for (const item of parsed) {
      results.push(item);
      const r = item.region || 'GLOBAL';
      regionCounts.set(r, (regionCounts.get(r) ?? 0) + 1);
    }
  }

  return results;
}

export const offFoodRepoAdapter: CatalogAdapter = {
  id: 'off-foodrepo',
  name: 'Open Food Facts (ODbL) & FoodRepo (CC BY 4.0)',
  license: 'ODbL-1.0 / CC BY 4.0',
  async load(options: AdapterLoadOptions): Promise<CatalogFoodInput[]> {
    const results: CatalogFoodInput[] = [];
    const offDir = path.join(options.cacheDir, 'off');
    const foodRepoDir = path.join(options.cacheDir, 'foodrepo');

    if (fs.existsSync(offDir)) {
      for (const file of fs.readdirSync(offDir)) {
        if (file.toLowerCase().endsWith('.jsonl') || file.toLowerCase().endsWith('.ndjson')) {
          const items = await streamOffJsonlFile(path.join(offDir, file), options.tier);
          console.log(`[off] Loaded ${items.length} products from ${file}`);
          results.push(...items);
        }
      }
    } else {
      console.log(`[off] No cached JSONL in ${offDir} — skipping.`);
    }

    if (fs.existsSync(foodRepoDir)) {
      for (const file of fs.readdirSync(foodRepoDir)) {
        if (file.toLowerCase().endsWith('.json')) {
          const items = parseFoodRepoJson(fs.readFileSync(path.join(foodRepoDir, file), 'utf8'));
          console.log(`[foodrepo] Loaded ${items.length} products from ${file}`);
          results.push(...items);
        }
      }
    } else {
      console.log(`[foodrepo] No cached JSON in ${foodRepoDir} — skipping.`);
    }

    return results;
  },
};
