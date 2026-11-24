import type { FoodItem, FoodServingOption, Micronutrients, NutritionBasis } from '@/types/nutrition';
import { deduplicateSearchResults, normalizeBarcode } from '@/lib/foods/dedup';
import { parseOffProduct, type OffProduct } from '@/lib/foods/off-adapter';
import { enrichServingOptions } from '@/lib/foods/portion-enrichment';
import { mapUsdaFoodToFoodItem, type UsdaFoodPayload } from '@/lib/foods/usda-adapter';
import { parseHouseholdServingText } from '@/lib/nutrition/scaling';

export type LiveProviderId = 'off' | 'usda' | 'fatsecret' | 'edamam' | 'nutritionix';

export interface LiveSearchResult {
  items: FoodItem[];
  partialError?: string;
  providersUsed: string[];
}

const LIVE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const LIVE_CACHE_MAX_ENTRIES = 500;
const PROVIDER_TIMEOUT_MS = 6_000;
const OFF_USER_AGENT = 'openCalory/1.0 (https://opencalory.local)';

const OFF_SEARCH_FIELDS = [
  'code',
  'product_name',
  'product_name_en',
  'generic_name',
  'brands',
  'brand_owner',
  'countries_tags',
  'nutriments',
  'product_quantity_unit',
  'serving_quantity_unit',
  'serving_quantity',
  'serving_size',
].join(',');

const OFF_PRODUCT_FIELDS = [
  'code',
  'product_name',
  'product_name_en',
  'generic_name',
  'brands',
  'brand_owner',
  'countries_tags',
  'nutriments',
  'product_quantity_unit',
  'serving_quantity_unit',
  'serving_quantity',
  'serving_size',
].join(',');

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface FatSecretTokenCache {
  token: string;
  credKey: string;
  expiresAt: number;
}

const searchCache = new Map<string, CacheEntry<LiveSearchResult>>();
const barcodeCache = new Map<string, CacheEntry<FoodItem | null>>();
let fatSecretTokenCache: FatSecretTokenCache | null = null;

const round2 = (val: number): number => Math.round((val + Number.EPSILON) * 100) / 100;

function getBoundedCache<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

function setBoundedCache<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= LIVE_CACHE_MAX_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, { value, expiresAt: Date.now() + LIVE_CACHE_TTL_MS });
}

function isNonEmptyEnv(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Returns the list of configured live providers.
 * Always includes `'off'` and `'usda'`.
 * Conditionally includes `'fatsecret'`, `'edamam'`, and `'nutritionix'` ONLY when
 * all of their required opt-in environment variables are non-empty.
 */
export function getConfiguredLiveProviders(): string[] {
  const providers: LiveProviderId[] = ['off', 'usda'];

  if (
    isNonEmptyEnv(process.env.FATSECRET_CLIENT_ID) &&
    isNonEmptyEnv(process.env.FATSECRET_CLIENT_SECRET)
  ) {
    providers.push('fatsecret');
  }

  if (
    isNonEmptyEnv(process.env.EDAMAM_APP_ID) &&
    isNonEmptyEnv(process.env.EDAMAM_APP_KEY)
  ) {
    providers.push('edamam');
  }

  if (
    isNonEmptyEnv(process.env.NUTRITIONIX_APP_ID) &&
    isNonEmptyEnv(process.env.NUTRITIONIX_APP_KEY)
  ) {
    providers.push('nutritionix');
  }

  return providers;
}

/**
 * Clears all in-memory live provider response caches and cached OAuth tokens.
 */
export function clearLiveProviderCache(): void {
  searchCache.clear();
  barcodeCache.clear();
  fatSecretTokenCache = null;
}

function enrichItem(item: FoodItem): FoodItem {
  const servingOptions = enrichServingOptions({
    name: item.name,
    category: item.category,
    basis: item.basis,
    existingOptions: item.servingOptions,
    servingWeightGrams: item.servingWeightGrams,
  });
  return {
    ...item,
    servingOptions,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  externalSignal?: AbortSignal,
  timeoutMs = PROVIDER_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal?.reason);

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timer = setTimeout(() => controller.abort(new Error('Provider request timed out')), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

function parseNum(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseOptionalNum(val: unknown): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

// ============================================================================
// 1. Live Open Food Facts (world + optional regional host)
// ============================================================================

async function fetchOffHostSearch(
  host: string,
  query: string,
  regionTag: string | undefined,
  signal?: AbortSignal
): Promise<FoodItem[]> {
  const targetUrl = new URL(`https://${host}/cgi/search.pl`);
  targetUrl.searchParams.set('search_terms', query);
  targetUrl.searchParams.set('search_simple', '1');
  targetUrl.searchParams.set('action', 'process');
  targetUrl.searchParams.set('json', '1');
  targetUrl.searchParams.set('page_size', '15');
  targetUrl.searchParams.set('fields', OFF_SEARCH_FIELDS);

  const res = await fetchWithTimeout(
    targetUrl.toString(),
    {
      method: 'GET',
      headers: {
        'User-Agent': OFF_USER_AGENT,
        Accept: 'application/json',
      },
    },
    signal
  );

  if (!res.ok) {
    throw new Error(`OFF (${host}) returned ${res.status}`);
  }

  const data = (await res.json()) as { products?: unknown[] };
  const rawProducts = Array.isArray(data?.products) ? data.products : [];
  const items: FoodItem[] = [];
  const seenIds = new Set<string>();

  for (const raw of rawProducts) {
    if (!raw || typeof raw !== 'object') continue;
    const prod = raw as OffProduct & { code?: string };
    const code = typeof prod.code === 'string' ? prod.code.trim() : '';
    if (!code) continue;

    const parsed = parseOffProduct(code, { status: 1, product: prod });
    if (!parsed || parsed.name === 'Unknown Food') continue;

    const { calories, protein, carbs, fat } = parsed.nutrientsPerBasis;
    if (calories === 0 && protein === 0 && carbs === 0 && fat === 0) continue;

    if (regionTag && !parsed.region) {
      parsed.region = regionTag;
    }
    parsed.accuracyTier = 4;

    if (!seenIds.has(parsed.id)) {
      seenIds.add(parsed.id);
      items.push(enrichItem(parsed));
    }
  }

  return items;
}

async function searchOffLive(
  query: string,
  region?: string,
  signal?: AbortSignal
): Promise<FoodItem[]> {
  const cleanRegion = (region ?? '').trim().toLowerCase();
  const hasRegionalHost = /^[a-z]{2}$/.test(cleanRegion) && cleanRegion !== 'us';

  if (!hasRegionalHost) {
    return fetchOffHostSearch('world.openfoodfacts.org', query, undefined, signal);
  }

  const regionUpper = cleanRegion.toUpperCase();
  const settled = await Promise.allSettled([
    fetchOffHostSearch(`${cleanRegion}.openfoodfacts.org`, query, regionUpper, signal),
    fetchOffHostSearch('world.openfoodfacts.org', query, undefined, signal),
  ]);

  const combined: FoodItem[] = [];
  let succeeded = 0;
  let lastError: unknown;

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      succeeded++;
      combined.push(...result.value);
    } else {
      lastError = result.reason;
    }
  }

  if (succeeded === 0 && lastError) {
    throw lastError;
  }

  return combined;
}

// ============================================================================
// 2. Live USDA FoodData Central
// ============================================================================

async function searchUsdaLive(query: string, signal?: AbortSignal): Promise<FoodItem[]> {
  const apiKey = process.env.USDA_API_KEY?.trim() || 'DEMO_KEY';
  const targetUrl = new URL('https://api.nal.usda.gov/fdc/v1/foods/search');
  targetUrl.searchParams.set('query', query);
  targetUrl.searchParams.set('pageSize', '15');
  targetUrl.searchParams.set('dataType', 'Foundation,SR Legacy,Survey (FNDDS),Branded');
  targetUrl.searchParams.set('api_key', apiKey);

  const res = await fetchWithTimeout(
    targetUrl.toString(),
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
    },
    signal
  );

  if (!res.ok) {
    throw new Error(`USDA returned ${res.status}`);
  }

  const data = (await res.json()) as { foods?: UsdaFoodPayload[] };
  const rawFoods = Array.isArray(data?.foods) ? data.foods : [];

  return rawFoods.map((raw) => {
    const item = mapUsdaFoodToFoodItem(raw, 'usda');
    item.accuracyTier = raw.dataType === 'Branded' ? 2 : 1;
    return enrichItem(item);
  });
}

// ============================================================================
// 3. Opt-In FatSecret Platform API (OAuth2 client_credentials)
// ============================================================================

async function getFatSecretAccessToken(signal?: AbortSignal): Promise<string> {
  const clientId = process.env.FATSECRET_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.FATSECRET_CLIENT_SECRET?.trim() ?? '';
  const credKey = `${clientId}:${clientSecret}`;

  if (
    fatSecretTokenCache &&
    fatSecretTokenCache.credKey === credKey &&
    Date.now() < fatSecretTokenCache.expiresAt
  ) {
    return fatSecretTokenCache.token;
  }

  const basicAuth = Buffer.from(credKey, 'utf8').toString('base64');
  const res = await fetchWithTimeout(
    'https://oauth.fatsecret.com/connect/token',
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials&scope=basic',
    },
    signal
  );

  if (!res.ok) {
    throw new Error(`FatSecret OAuth returned ${res.status}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data?.access_token) {
    throw new Error('FatSecret OAuth response missing access_token');
  }

  const expiresInSec = typeof data.expires_in === 'number' && data.expires_in > 120
    ? data.expires_in - 60
    : 3000;

  fatSecretTokenCache = {
    token: data.access_token,
    credKey,
    expiresAt: Date.now() + expiresInSec * 1000,
  };

  return data.access_token;
}

interface FatSecretFoodRaw {
  food_id?: string | number;
  food_name?: string;
  brand_name?: string;
  food_description?: string;
  servings?: {
    serving?: FatSecretServingRaw | FatSecretServingRaw[];
  };
}

interface FatSecretServingRaw {
  serving_description?: string;
  metric_serving_amount?: string | number;
  metric_serving_unit?: string;
  calories?: string | number;
  protein?: string | number;
  carbohydrate?: string | number;
  fat?: string | number;
  fiber?: string | number;
  sodium?: string | number;
  sugar?: string | number;
  saturated_fat?: string | number;
  cholesterol?: string | number;
}

function mapFatSecretFood(raw: FatSecretFoodRaw, barcode?: string): FoodItem | null {
  const foodId = raw.food_id != null ? String(raw.food_id).trim() : '';
  const name = typeof raw.food_name === 'string' ? raw.food_name.trim() : '';
  if (!foodId || !name) return null;

  const brand =
    typeof raw.brand_name === 'string' && raw.brand_name.trim() ? raw.brand_name.trim() : undefined;

  // Prefer structured servings if present (food/v4 or barcode responses)
  const rawServings = raw.servings?.serving;
  const servingsList: FatSecretServingRaw[] = Array.isArray(rawServings)
    ? rawServings
    : rawServings
      ? [rawServings]
      : [];

  if (servingsList.length > 0) {
    const primary =
      servingsList.find(
        (s) =>
          (s.metric_serving_unit === 'g' || s.metric_serving_unit === 'ml') &&
          parseNum(s.metric_serving_amount) === 100
      ) ?? servingsList[0];

    const metricAmount = parseNum(primary.metric_serving_amount);
    const metricUnit = (primary.metric_serving_unit ?? '').toLowerCase();
    const isMetric100 = (metricUnit === 'g' || metricUnit === 'ml') && metricAmount > 0;
    const scale = isMetric100 ? 100 / metricAmount : 1;
    const basis: NutritionBasis = isMetric100
      ? metricUnit === 'ml'
        ? 'per100ml'
        : 'per100g'
      : 'perServing';

    const micros: Micronutrients = {};
    const sodium = parseOptionalNum(primary.sodium);
    if (sodium !== undefined) micros.sodiumMg = round2(sodium * scale);
    const sugar = parseOptionalNum(primary.sugar);
    if (sugar !== undefined) micros.sugarG = round2(sugar * scale);
    const satFat = parseOptionalNum(primary.saturated_fat);
    if (satFat !== undefined) micros.saturatedFatG = round2(satFat * scale);
    const chol = parseOptionalNum(primary.cholesterol);
    if (chol !== undefined) micros.cholesterolMg = round2(chol * scale);

    const servingOptions: FoodServingOption[] = [];
    for (const s of servingsList) {
      const amt = parseNum(s.metric_serving_amount);
      if (amt <= 0) continue;
      const parsed = s.serving_description
        ? parseHouseholdServingText(s.serving_description)
        : null;
      if (parsed && parsed.unit !== 'g' && parsed.unit !== 'ml') {
        const gramsPerUnit = round2(amt / parsed.count);
        if (gramsPerUnit > 0) {
          servingOptions.push({
            id: parsed.unit,
            label: `${parsed.unit} (${gramsPerUnit}${metricUnit === 'ml' ? 'ml' : 'g'})`,
            unit: parsed.unit,
            grams: gramsPerUnit,
            defaultAmount: 1,
          });
        }
      }
    }

    return enrichItem({
      id: `fatsecret:${foodId}`,
      ...(barcode ? { barcode } : {}),
      source: 'fatsecret',
      accuracyTier: 3,
      name,
      brand,
      basis,
      servingSize: basis === 'perServing' ? 1 : 100,
      servingUnit: basis === 'per100ml' ? 'ml' : basis === 'per100g' ? 'g' : 'serving',
      ...(metricAmount > 0 ? { servingWeightGrams: round2(metricAmount) } : {}),
      ...(servingOptions.length > 0 ? { servingOptions } : {}),
      nutrientsPerBasis: {
        calories: round2(Math.max(0, parseNum(primary.calories) * scale)),
        protein: round2(Math.max(0, parseNum(primary.protein) * scale)),
        carbs: round2(Math.max(0, parseNum(primary.carbohydrate) * scale)),
        fat: round2(Math.max(0, parseNum(primary.fat) * scale)),
        fiber: round2(Math.max(0, parseNum(primary.fiber) * scale)),
      },
      micronutrientsPerBasis: micros,
      updatedAt: Date.now(),
    });
  }

  // Fallback: parse `food_description` e.g.
  // "Per 100g - Calories: 210kcal | Fat: 12.00g | Carbs: 4.50g | Protein: 21.00g"
  const desc = typeof raw.food_description === 'string' ? raw.food_description : '';
  const calMatch = desc.match(/Calories:\s*([\d.]+)\s*kcal/i);
  const fatMatch = desc.match(/Fat:\s*([\d.]+)\s*g/i);
  const carbsMatch = desc.match(/Carbs:\s*([\d.]+)\s*g/i);
  const proteinMatch = desc.match(/Protein:\s*([\d.]+)\s*g/i);
  const perMatch = desc.match(/^Per\s+([^-]+?)\s*-/i);

  const calories = calMatch ? parseNum(calMatch[1]) : 0;
  const fat = fatMatch ? parseNum(fatMatch[1]) : 0;
  const carbs = carbsMatch ? parseNum(carbsMatch[1]) : 0;
  const protein = proteinMatch ? parseNum(proteinMatch[1]) : 0;

  let basis: NutritionBasis = 'perServing';
  let servingSize = 1;
  let servingUnit = 'serving';
  let servingWeightGrams: number | undefined;

  if (perMatch) {
    const perText = perMatch[1].trim();
    const metricMatch = perText.match(/^([\d.]+)\s*(g|ml)$/i);
    if (metricMatch) {
      const amount = parseNum(metricMatch[1]);
      const unit = metricMatch[2].toLowerCase();
      if (amount > 0) {
        const scale = 100 / amount;
        basis = unit === 'ml' ? 'per100ml' : 'per100g';
        servingSize = 100;
        servingUnit = unit;
        servingWeightGrams = amount !== 100 ? round2(amount) : undefined;
        return enrichItem({
          id: `fatsecret:${foodId}`,
          ...(barcode ? { barcode } : {}),
          source: 'fatsecret',
          accuracyTier: 3,
          name,
          brand,
          basis,
          servingSize,
          servingUnit,
          ...(servingWeightGrams ? { servingWeightGrams } : {}),
          nutrientsPerBasis: {
            calories: round2(calories * scale),
            protein: round2(protein * scale),
            carbs: round2(carbs * scale),
            fat: round2(fat * scale),
            fiber: 0,
          },
          micronutrientsPerBasis: {},
          updatedAt: Date.now(),
        });
      }
    } else {
      servingUnit = perText;
    }
  }

  return enrichItem({
    id: `fatsecret:${foodId}`,
    ...(barcode ? { barcode } : {}),
    source: 'fatsecret',
    accuracyTier: 3,
    name,
    brand,
    basis,
    servingSize,
    servingUnit,
    nutrientsPerBasis: {
      calories: round2(calories),
      protein: round2(protein),
      carbs: round2(carbs),
      fat: round2(fat),
      fiber: 0,
    },
    micronutrientsPerBasis: {},
    updatedAt: Date.now(),
  });
}

async function searchFatSecretLive(query: string, signal?: AbortSignal): Promise<FoodItem[]> {
  const token = await getFatSecretAccessToken(signal);
  const targetUrl = new URL('https://platform.fatsecret.com/rest/foods/search/v1');
  targetUrl.searchParams.set('search_expression', query);
  targetUrl.searchParams.set('format', 'json');
  targetUrl.searchParams.set('max_results', '15');

  const res = await fetchWithTimeout(
    targetUrl.toString(),
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    },
    signal
  );

  if (!res.ok) {
    throw new Error(`FatSecret search returned ${res.status}`);
  }

  const data = (await res.json()) as {
    foods?: { food?: FatSecretFoodRaw | FatSecretFoodRaw[] };
  };
  const rawFood = data?.foods?.food;
  const list = Array.isArray(rawFood) ? rawFood : rawFood ? [rawFood] : [];

  const items: FoodItem[] = [];
  for (const entry of list) {
    const mapped = mapFatSecretFood(entry);
    if (mapped) items.push(mapped);
  }
  return items;
}

// ============================================================================
// 4. Opt-In Edamam Food Database API (/api/food-database/v2/parser)
// ============================================================================

interface EdamamHint {
  food?: {
    foodId?: string;
    label?: string;
    brand?: string;
    category?: string;
    nutrients?: {
      ENERC_KCAL?: number;
      PROCNT?: number;
      FAT?: number;
      CHOCDF?: number;
      FIBTG?: number;
    };
  };
  measures?: Array<{
    label?: string;
    weight?: number;
  }>;
}

async function searchEdamamLive(query: string, signal?: AbortSignal): Promise<FoodItem[]> {
  const appId = process.env.EDAMAM_APP_ID?.trim() ?? '';
  const appKey = process.env.EDAMAM_APP_KEY?.trim() ?? '';

  const targetUrl = new URL('https://api.edamam.com/api/food-database/v2/parser');
  targetUrl.searchParams.set('app_id', appId);
  targetUrl.searchParams.set('app_key', appKey);
  targetUrl.searchParams.set('ingr', query);

  const res = await fetchWithTimeout(
    targetUrl.toString(),
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
    },
    signal
  );

  if (!res.ok) {
    throw new Error(`Edamam returned ${res.status}`);
  }

  const data = (await res.json()) as { hints?: EdamamHint[] };
  const hints = Array.isArray(data?.hints) ? data.hints : [];
  const items: FoodItem[] = [];
  const seenIds = new Set<string>();

  for (const hint of hints.slice(0, 15)) {
    const food = hint?.food;
    const foodId = typeof food?.foodId === 'string' ? food.foodId.trim() : '';
    const name = typeof food?.label === 'string' ? food.label.trim() : '';
    if (!foodId || !name) continue;

    const id = `edamam:${foodId}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const nutrients = food?.nutrients ?? {};
    const servingOptions: FoodServingOption[] = [];
    if (Array.isArray(hint.measures)) {
      for (const m of hint.measures) {
        const weight = parseNum(m?.weight);
        if (weight <= 0 || !m?.label) continue;
        const parsed = parseHouseholdServingText(`1 ${m.label}`);
        if (parsed && parsed.unit !== 'g' && parsed.unit !== 'ml') {
          const grams = round2(weight / parsed.count);
          if (grams > 0) {
            servingOptions.push({
              id: parsed.unit,
              label: `${parsed.unit} (${grams}g)`,
              unit: parsed.unit,
              grams,
              defaultAmount: 1,
            });
          }
        }
      }
    }

    items.push(
      enrichItem({
        id,
        source: 'edamam',
        accuracyTier: 3,
        name,
        brand: typeof food?.brand === 'string' && food.brand.trim() ? food.brand.trim() : undefined,
        category:
          typeof food?.category === 'string' && food.category.trim()
            ? food.category.trim()
            : undefined,
        basis: 'per100g',
        servingSize: 100,
        servingUnit: 'g',
        ...(servingOptions.length > 0
          ? { servingOptions, servingWeightGrams: servingOptions[0].grams }
          : {}),
        nutrientsPerBasis: {
          calories: round2(Math.max(0, parseNum(nutrients.ENERC_KCAL))),
          protein: round2(Math.max(0, parseNum(nutrients.PROCNT))),
          carbs: round2(Math.max(0, parseNum(nutrients.CHOCDF))),
          fat: round2(Math.max(0, parseNum(nutrients.FAT))),
          fiber: round2(Math.max(0, parseNum(nutrients.FIBTG))),
        },
        micronutrientsPerBasis: {},
        updatedAt: Date.now(),
      })
    );
  }

  return items;
}

// ============================================================================
// 5. Opt-In Nutritionix API (/v2/search/instant & /v2/search/item)
// ============================================================================

interface NutritionixFoodRaw {
  nix_item_id?: string;
  food_name?: string;
  brand_name?: string;
  serving_qty?: number;
  serving_unit?: string;
  serving_weight_grams?: number | null;
  nf_calories?: number;
  nf_protein?: number;
  nf_total_carbohydrate?: number;
  nf_total_fat?: number;
  nf_dietary_fiber?: number;
  nf_sodium?: number;
  nf_sugars?: number;
  nf_saturated_fat?: number;
  nf_cholesterol?: number;
  upc?: string;
}

function mapNutritionixFood(raw: NutritionixFoodRaw, barcodeOverride?: string): FoodItem | null {
  const name = typeof raw.food_name === 'string' ? raw.food_name.trim() : '';
  if (!name) return null;

  const rawId =
    typeof raw.nix_item_id === 'string' && raw.nix_item_id.trim()
      ? raw.nix_item_id.trim()
      : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!rawId) return null;

  const calories = parseNum(raw.nf_calories);
  const protein = parseNum(raw.nf_protein);
  const carbs = parseNum(raw.nf_total_carbohydrate);
  const fat = parseNum(raw.nf_total_fat);
  const fiber = parseNum(raw.nf_dietary_fiber);

  const weightGrams = parseOptionalNum(raw.serving_weight_grams);
  const hasWeight = weightGrams !== undefined && weightGrams > 0;
  const scale = hasWeight ? 100 / weightGrams : 1;
  const basis: NutritionBasis = hasWeight ? 'per100g' : 'perServing';

  const micros: Micronutrients = {};
  const sodium = parseOptionalNum(raw.nf_sodium);
  if (sodium !== undefined) micros.sodiumMg = round2(sodium * scale);
  const sugar = parseOptionalNum(raw.nf_sugars);
  if (sugar !== undefined) micros.sugarG = round2(sugar * scale);
  const satFat = parseOptionalNum(raw.nf_saturated_fat);
  if (satFat !== undefined) micros.saturatedFatG = round2(satFat * scale);
  const chol = parseOptionalNum(raw.nf_cholesterol);
  if (chol !== undefined) micros.cholesterolMg = round2(chol * scale);

  const servingOptions: FoodServingOption[] = [];
  if (hasWeight) {
    const qty = parseNum(raw.serving_qty) || 1;
    const rawUnit = typeof raw.serving_unit === 'string' ? raw.serving_unit.trim() : '';
    const parsed = rawUnit ? parseHouseholdServingText(`${qty} ${rawUnit}`) : null;
    const unit = parsed?.unit && parsed.unit !== 'g' && parsed.unit !== 'ml' ? parsed.unit : 'serving';
    const perUnitGrams = round2(weightGrams / (parsed?.count ?? qty));
    if (perUnitGrams > 0) {
      servingOptions.push({
        id: unit,
        label: `${unit} (${perUnitGrams}g)`,
        unit,
        grams: perUnitGrams,
        defaultAmount: 1,
      });
    }
  }

  const barcode = normalizeBarcode(barcodeOverride ?? raw.upc);

  return enrichItem({
    id: `nutritionix:${rawId}`,
    ...(barcode ? { barcode } : {}),
    source: 'nutritionix',
    accuracyTier: 3,
    name,
    brand:
      typeof raw.brand_name === 'string' && raw.brand_name.trim()
        ? raw.brand_name.trim()
        : undefined,
    basis,
    servingSize: hasWeight ? 100 : parseNum(raw.serving_qty) || 1,
    servingUnit: hasWeight ? 'g' : (raw.serving_unit?.trim() || 'serving'),
    ...(hasWeight ? { servingWeightGrams: round2(weightGrams) } : {}),
    ...(servingOptions.length > 0 ? { servingOptions } : {}),
    nutrientsPerBasis: {
      calories: round2(Math.max(0, calories * scale)),
      protein: round2(Math.max(0, protein * scale)),
      carbs: round2(Math.max(0, carbs * scale)),
      fat: round2(Math.max(0, fat * scale)),
      fiber: round2(Math.max(0, fiber * scale)),
    },
    micronutrientsPerBasis: micros,
    updatedAt: Date.now(),
  });
}

async function searchNutritionixLive(query: string, signal?: AbortSignal): Promise<FoodItem[]> {
  const appId = process.env.NUTRITIONIX_APP_ID?.trim() ?? '';
  const appKey = process.env.NUTRITIONIX_APP_KEY?.trim() ?? '';

  const targetUrl = new URL('https://trackapi.nutritionix.com/v2/search/instant');
  targetUrl.searchParams.set('query', query);
  targetUrl.searchParams.set('detailed', 'true');

  const res = await fetchWithTimeout(
    targetUrl.toString(),
    {
      method: 'GET',
      headers: {
        'x-app-id': appId,
        'x-app-key': appKey,
        Accept: 'application/json',
      },
    },
    signal
  );

  if (!res.ok) {
    throw new Error(`Nutritionix returned ${res.status}`);
  }

  const data = (await res.json()) as {
    common?: NutritionixFoodRaw[];
    branded?: NutritionixFoodRaw[];
  };

  const rawList: NutritionixFoodRaw[] = [
    ...(Array.isArray(data?.common) ? data.common.slice(0, 8) : []),
    ...(Array.isArray(data?.branded) ? data.branded.slice(0, 12) : []),
  ];

  const items: FoodItem[] = [];
  for (const entry of rawList) {
    const mapped = mapNutritionixFood(entry);
    if (mapped) items.push(mapped);
  }
  return items;
}

// ============================================================================
// Public Orchestrators
// ============================================================================

/**
 * Queries live OFF, live USDA FDC, and strictly opt-in FatSecret/Edamam/Nutritionix
 * providers in parallel with a 6s per-provider timeout and a 30-minute bounded in-memory cache.
 */
export async function searchLiveProviders(
  query: string,
  options?: { region?: string; signal?: AbortSignal }
): Promise<LiveSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { items: [], providersUsed: [] };
  }

  const configured = getConfiguredLiveProviders();
  const regionKey = (options?.region ?? '').trim().toLowerCase();
  const providersKey = configured.join(',');
  const cacheKey = `${trimmed.toLowerCase()}|${regionKey}|${providersKey}`;

  const cached = getBoundedCache(searchCache, cacheKey);
  if (cached) {
    return cached;
  }

  const tasks = configured.map(async (provider): Promise<{ provider: string; items: FoodItem[] }> => {
    switch (provider) {
      case 'off':
        return { provider, items: await searchOffLive(trimmed, options?.region, options?.signal) };
      case 'usda':
        return { provider, items: await searchUsdaLive(trimmed, options?.signal) };
      case 'fatsecret':
        return { provider, items: await searchFatSecretLive(trimmed, options?.signal) };
      case 'edamam':
        return { provider, items: await searchEdamamLive(trimmed, options?.signal) };
      case 'nutritionix':
        return { provider, items: await searchNutritionixLive(trimmed, options?.signal) };
      default:
        return { provider, items: [] };
    }
  });

  const settled = await Promise.allSettled(tasks);
  const allItems: FoodItem[] = [];
  const providersUsed: string[] = [];
  const errors: string[] = [];

  settled.forEach((outcome, index) => {
    const provider = configured[index];
    if (outcome.status === 'fulfilled') {
      providersUsed.push(outcome.value.provider);
      allItems.push(...outcome.value.items);
    } else {
      const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      errors.push(`${provider}: ${msg}`);
    }
  });

  const deduplicated = deduplicateSearchResults(allItems);
  const result: LiveSearchResult = {
    items: deduplicated,
    providersUsed,
    ...(errors.length > 0 ? { partialError: errors.join('; ') } : {}),
  };

  // Cache only when at least one provider succeeded with no partial errors
  if (providersUsed.length > 0 && errors.length === 0) {
    setBoundedCache(searchCache, cacheKey, result);
  }

  return result;
}

async function lookupOffBarcode(code: string, signal?: AbortSignal): Promise<FoodItem | null> {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_PRODUCT_FIELDS}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: {
        'User-Agent': OFF_USER_AGENT,
        Accept: 'application/json',
      },
    },
    signal
  );

  if (!res.ok) return null;
  const data = await res.json();
  const item = parseOffProduct(code, data);
  if (!item) return null;

  item.accuracyTier = 4;
  item.barcode = normalizeBarcode(code) ?? code;
  return enrichItem(item);
}

async function lookupNutritionixBarcode(code: string, signal?: AbortSignal): Promise<FoodItem | null> {
  const appId = process.env.NUTRITIONIX_APP_ID?.trim() ?? '';
  const appKey = process.env.NUTRITIONIX_APP_KEY?.trim() ?? '';
  const url = `https://trackapi.nutritionix.com/v2/search/item?upc=${encodeURIComponent(code)}`;

  const res = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: {
        'x-app-id': appId,
        'x-app-key': appKey,
        Accept: 'application/json',
      },
    },
    signal
  );

  if (!res.ok) return null;
  const data = (await res.json()) as { foods?: NutritionixFoodRaw[] };
  const first = Array.isArray(data?.foods) ? data.foods[0] : undefined;
  if (!first) return null;

  return mapNutritionixFood(first, code);
}

async function lookupFatSecretBarcode(code: string, signal?: AbortSignal): Promise<FoodItem | null> {
  const token = await getFatSecretAccessToken(signal);
  const gtin13 = code.padStart(13, '0');
  const findUrl = `https://platform.fatsecret.com/rest/food/barcode/find-by-id/v1?barcode=${encodeURIComponent(gtin13)}&format=json`;

  const findRes = await fetchWithTimeout(
    findUrl,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    },
    signal
  );

  if (!findRes.ok) return null;
  const findData = (await findRes.json()) as { food_id?: { value?: string } };
  const foodId = findData?.food_id?.value?.trim();
  if (!foodId) return null;

  const detailUrl = `https://platform.fatsecret.com/rest/food/v4?food_id=${encodeURIComponent(foodId)}&format=json`;
  const detailRes = await fetchWithTimeout(
    detailUrl,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    },
    signal
  );

  if (!detailRes.ok) return null;
  const detailData = (await detailRes.json()) as { food?: FatSecretFoodRaw };
  if (!detailData?.food) return null;

  return mapFatSecretFood(detailData.food, normalizeBarcode(code) ?? code);
}

/**
 * Looks up a barcode against live OFF first, then opt-in Nutritionix and FatSecret
 * barcode endpoints if configured. Enriches any hit via `enrichServingOptions`.
 */
export async function lookupBarcodeLiveProviders(
  barcode: string,
  options?: { signal?: AbortSignal }
): Promise<FoodItem | null> {
  if (!barcode || typeof barcode !== 'string') return null;
  const normalized = normalizeBarcode(barcode);
  const rawDigits = barcode.replace(/\D+/g, '');
  if (!normalized && (rawDigits.length < 8 || rawDigits.length > 14)) {
    return null;
  }

  const lookupCode = rawDigits.length >= 8 && rawDigits.length <= 14 ? rawDigits : normalized!;
  const configured = getConfiguredLiveProviders();
  const cacheKey = `${normalized ?? lookupCode}|${configured.join(',')}`;

  const cached = getBoundedCache(barcodeCache, cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // 1. Live OFF first
  try {
    const offHit = await lookupOffBarcode(lookupCode, options?.signal);
    if (offHit) {
      setBoundedCache(barcodeCache, cacheKey, offHit);
      return offHit;
    }
  } catch {
    // Fall through to opt-in providers
  }

  // 2. Opt-in Nutritionix barcode endpoint
  if (configured.includes('nutritionix')) {
    try {
      const nixHit = await lookupNutritionixBarcode(lookupCode, options?.signal);
      if (nixHit) {
        setBoundedCache(barcodeCache, cacheKey, nixHit);
        return nixHit;
      }
    } catch {
      // Fall through to FatSecret
    }
  }

  // 3. Opt-in FatSecret barcode endpoint
  if (configured.includes('fatsecret')) {
    try {
      const fsHit = await lookupFatSecretBarcode(lookupCode, options?.signal);
      if (fsHit) {
        setBoundedCache(barcodeCache, cacheKey, fsHit);
        return fsHit;
      }
    } catch {
      // Miss
    }
  }

  return null;
}
