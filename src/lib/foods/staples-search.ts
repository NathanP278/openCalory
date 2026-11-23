import type { FoodItem, Micronutrients } from '@/types/nutrition';
import { searchClientCatalog } from '@/lib/foods/client-catalog';

let cachedStaples: FoodItem[] | null = null;

interface IndexedFoodTokens {
  nameLower: string;
  nameNorm: string;
  brandNorm: string;
  combinedNorm: string;
  compactName: string;
  compactCombined: string;
  nameTokens: string[];
  brandTokens: string[];
}

const foodTokenCache = new WeakMap<FoodItem, IndexedFoodTokens>();

const PREP_MODIFIERS = new Set([
  'grilled', 'steamed', 'boiled', 'baked', 'roasted', 'fried', 'pan', 'seared',
  'sauteed', 'poached', 'scrambled', 'mashed', 'cooked', 'raw', 'fresh',
  'organic', 'boneless', 'skinless', 'fillet', 'slice', 'sliced', 'chopped',
  'diced', 'minced', 'shredded', 'grated', 'whole', 'plain', 'extra', 'virgin',
  'light', 'lean', 'trimmed', 'peeled',
]);

const SUBPART_PENALTY = new Set([
  'leaves', 'leaf', 'peel', 'skin', 'powder', 'flour', 'juice', 'syrup',
  'canned', 'pickled', 'dried', 'dehydrated', 'freeze', 'frozen', 'infant',
  'baby', 'formula', 'bran', 'germ', 'starch', 'breaded', 'battered',
  'tenders', 'nuggets', 'candied', 'raab', 'stuffed', 'imitation', 'smoked',
  'cured', 'salted', 'sweetened', 'flavored', 'paste', 'sauce', 'soup',
  'stalks', 'chinese',
]);

const COOKED_MODIFIERS = new Set([
  'grilled', 'steamed', 'boiled', 'baked', 'roasted', 'fried',
  'seared', 'sauteed', 'poached', 'scrambled', 'mashed', 'cooked',
]);

const CORE_RDA_MICRONUTRIENT_KEYS = [
  'sodiumMg',
  'potassiumMg',
  'calciumMg',
  'ironMg',
  'magnesiumMg',
  'zincMg',
  'vitaminAMcg',
  'vitaminCMg',
  'vitaminDMcg',
  'vitaminB6Mg',
  'vitaminB12Mcg',
  'folateMcg',
] as const;

export const TRACKED_MICRONUTRIENT_KEYS = [
  ...CORE_RDA_MICRONUTRIENT_KEYS,
  'sugarG',
  'addedSugarG',
  'saturatedFatG',
  'cholesterolMg',
  'caffeineMg',
  'alcoholG',
] as const;

const round2 = (val: number): number => Math.round((val + Number.EPSILON) * 100) / 100;

function getPerServingWeightGrams(item: FoodItem): number | undefined {
  if (item.basis !== 'perServing') return undefined;
  if (
    typeof item.servingWeightGrams === 'number' &&
    Number.isFinite(item.servingWeightGrams) &&
    item.servingWeightGrams > 0
  ) {
    return item.servingWeightGrams;
  }
  const unitLower = (item.servingUnit ?? '').trim().toLowerCase();
  if (
    (unitLower === 'g' || unitLower === 'ml') &&
    typeof item.servingSize === 'number' &&
    Number.isFinite(item.servingSize) &&
    item.servingSize > 0
  ) {
    return item.servingSize;
  }
  const matchingOption = item.servingOptions?.find(
    (opt) => opt.unit === item.servingUnit && opt.grams > 0
  );
  if (matchingOption) {
    const count =
      typeof item.servingSize === 'number' &&
      Number.isFinite(item.servingSize) &&
      item.servingSize > 0
        ? item.servingSize
        : 1;
    return matchingOption.grams * count;
  }
  return undefined;
}

/**
 * Deterministically estimates missing extended nutrients (sugarG, addedSugarG, saturatedFatG,
 * cholesterolMg, caffeineMg, alcoholG) for offline staples and PH foods when not explicitly stored,
 * preserving all pre-existing micronutrient values.
 */
export function estimateMissingStapleMicros(item: FoodItem): Micronutrients {
  const existing: Micronutrients = { ...(item.micronutrientsPerBasis ?? {}) };
  const { protein = 0, carbs = 0, fat = 0, fiber = 0 } = item.nutrientsPerBasis ?? {};
  const netCarbs = Math.max(0, carbs - fiber);
  const text = `${item.brand ?? ''} ${item.name ?? ''}`.toLowerCase();
  const servingWeight = getPerServingWeightGrams(item);
  const densityScale =
    item.basis === 'perServing' && servingWeight && servingWeight > 0
      ? servingWeight / 100
      : 1;

  if (typeof existing.sugarG !== 'number') {
    if (netCarbs <= 0) {
      existing.sugarG = 0;
    } else if (
      /\b(fruit|apple|banana|orange|mango|grape|berry|strawberry|blueberry|pineapple|watermelon|peach|pear|plum|cherry|papaya|guava|juice|soda|cola|sprite|royal|sarsi|honey|syrup|sugar|candy|chocolate|cake|cookie|ice cream|halo-halo|flan|donut|pastry|jam|jelly|sweet|sundae|float|shake|mocha|latte|caramel)\b/.test(
        text
      )
    ) {
      existing.sugarG = round2(Math.min(netCarbs, netCarbs * 0.65));
    } else if (/\b(milk|yogurt|curd|whey)\b/.test(text)) {
      existing.sugarG = round2(Math.min(netCarbs, netCarbs * 0.75));
    } else if (
      /\b(tomato|carrot|onion|beet|pepper|squash|corn|pea|sauce|ketchup|bbq|teriyaki|tocino|longganisa|tapa|adobo|bread|pandesal|bun|roll|cereal|granola|mcmuffin|burger)\b/.test(
        text
      )
    ) {
      existing.sugarG = round2(Math.min(netCarbs, netCarbs * 0.15));
    } else {
      existing.sugarG = round2(Math.min(netCarbs, netCarbs * 0.05));
    }
  }

  if (typeof existing.addedSugarG !== 'number') {
    const sugarVal = existing.sugarG ?? 0;
    if (
      sugarVal > 0 &&
      /\b(sweetened|soda|cola|sprite|royal|sarsi|candy|chocolate|cake|cookie|ice cream|halo-halo|flan|donut|pastry|syrup|jam|jelly|sundae|float|shake|mocha|caramel|cereal|granola|tocino|bbq|ketchup)\b/.test(
        text
      )
    ) {
      existing.addedSugarG = round2(sugarVal * 0.75);
    } else {
      existing.addedSugarG = 0;
    }
  }

  if (typeof existing.saturatedFatG !== 'number') {
    if (fat <= 0) {
      existing.saturatedFatG = 0;
    } else if (
      /\b(butter|cheese|cream|milk|yogurt|coconut|beef|steak|burger|pork|bacon|sausage|ham|longganisa|tocino|lechon|sisig|crispy|fried|chickenjoy|mcmuffin|mcdo|jollibee|chowking|kfc|chocolate|lard|tallow|ghee|egg)\b/.test(
        text
      )
    ) {
      existing.saturatedFatG = round2(Math.min(fat, fat * 0.38));
    } else {
      existing.saturatedFatG = round2(Math.min(fat, fat * 0.18));
    }
  }

  if (typeof existing.cholesterolMg !== 'number') {
    if (/\b(egg|mcmuffin|kwek|balut)\b/.test(text)) {
      existing.cholesterolMg = round2(Math.max(120 * densityScale, protein * 14));
    } else if (
      /\b(liver|giblet|kidney|heart|shrimp|prawn|squid|calamari|crab|oyster|clam)\b/.test(
        text
      )
    ) {
      existing.cholesterolMg = round2(Math.max(140 * densityScale, protein * 7.5));
    } else if (
      /\b(chicken|turkey|duck|beef|steak|veal|pork|ham|bacon|sausage|lamb|goat|venison|fish|salmon|tuna|cod|tilapia|bangus|galunggong|sardine|mackerel|trout|halibut|milk|cheese|butter|cream|yogurt|ice cream|mcdo|jollibee|kfc|chowking|burger|chickenjoy|adobo|sinigang|sisig|lechon|tapa|tocino|longganisa)\b/.test(
        text
      )
    ) {
      existing.cholesterolMg = round2(Math.max(10 * densityScale, protein * 3.2 + fat * 1.1));
    } else {
      existing.cholesterolMg = 0;
    }
  }

  if (typeof existing.caffeineMg !== 'number') {
    let caffeinePer100g = 0;
    if (/\bespresso\b/.test(text)) {
      caffeinePer100g = 212;
    } else if (/\b(coffee|mocha|latte|cappuccino|americano|macchiato|brew)\b/.test(text)) {
      caffeinePer100g = 45;
    } else if (/\b(energy drink|red bull|monster|cobra|sting)\b/.test(text)) {
      caffeinePer100g = 32;
    } else if (/\b(tea|matcha|chai)\b/.test(text)) {
      caffeinePer100g = 20;
    } else if (/\b(cola|coke|pepsi|mountain dew)\b/.test(text)) {
      caffeinePer100g = 10;
    } else if (/\b(chocolate|cocoa|cacao|milo|ovaltine)\b/.test(text)) {
      caffeinePer100g = 12;
    }
    existing.caffeineMg = caffeinePer100g > 0 ? round2(caffeinePer100g * densityScale) : 0;
  }

  if (typeof existing.alcoholG !== 'number') {
    let alcoholPer100g = 0;
    if (/\b(gin|rum|vodka|whiskey|whisky|tequila|brandy|liquor)\b/.test(text)) {
      alcoholPer100g = 33;
    } else if (/\b(wine|sangria|sake|champagne|prosecco)\b/.test(text)) {
      alcoholPer100g = 10;
    } else if (/\b(beer|ale|lager|stout|cider|san miguel|red horse)\b/.test(text)) {
      alcoholPer100g = 4;
    }
    existing.alcoholG = alcoholPer100g > 0 ? round2(alcoholPer100g * densityScale) : 0;
  }

  return existing;
}

function hydrateStapleList(items: FoodItem[]): FoodItem[] {
  return items.map((item) => ({
    ...item,
    micronutrientsPerBasis: estimateMissingStapleMicros(item),
  }));
}

function getFoodTokens(item: FoodItem): IndexedFoodTokens {
  const cached = foodTokenCache.get(item);
  if (cached) return cached;

  const nameLower = (item.name || '').toLowerCase();
  const brandLower = (item.brand || '').toLowerCase();
  const nameNorm = nameLower.replace(/['’.,()-]/g, ' ').replace(/\s+/g, ' ').trim();
  const brandNorm = brandLower.replace(/['’.,()-]/g, ' ').replace(/\s+/g, ' ').trim();
  const combinedNorm = brandNorm ? `${brandNorm} ${nameNorm}` : nameNorm;
  const compactName = nameNorm.replace(/[^a-z0-9]/g, '');
  const compactCombined = combinedNorm.replace(/[^a-z0-9]/g, '');
  const nameTokens = nameNorm.split(/[\s/]+/).filter(Boolean);
  const brandTokens = brandNorm.split(/[\s/]+/).filter(Boolean);

  const indexed: IndexedFoodTokens = {
    nameLower,
    nameNorm,
    brandNorm,
    combinedNorm,
    compactName,
    compactCombined,
    nameTokens,
    brandTokens,
  };
  foodTokenCache.set(item, indexed);
  return indexed;
}

function toSingular(token: string): string {
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 3) return token.slice(0, -1);
  return token;
}

let dlPrev2 = new Int32Array(64);
let dlPrev = new Int32Array(64);
let dlCurr = new Int32Array(64);

/**
 * Bounded Optimal String Alignment (Damerau-Levenshtein) distance with early bailout.
 * Uses flat pre-allocated typed arrays for zero heap allocations on hot search paths.
 */
function damerauLevenshtein(a: string, b: string, maxDist: number): number {
  const lenA = a.length;
  const lenB = b.length;
  if (a === b) return 0;
  if (Math.abs(lenA - lenB) > maxDist) return maxDist + 1;
  if (lenA === 0) return lenB <= maxDist ? lenB : maxDist + 1;
  if (lenB === 0) return lenA <= maxDist ? lenA : maxDist + 1;

  if (lenB + 1 > dlCurr.length) {
    const nextSize = lenB + 16;
    dlPrev2 = new Int32Array(nextSize);
    dlPrev = new Int32Array(nextSize);
    dlCurr = new Int32Array(nextSize);
  }

  for (let j = 0; j <= lenB; j++) {
    dlPrev[j] = j;
  }

  for (let i = 1; i <= lenA; i++) {
    dlCurr[0] = i;
    let rowMin = i;
    const chA = a.charCodeAt(i - 1);
    const chAPrev = i > 1 ? a.charCodeAt(i - 2) : 0;

    for (let j = 1; j <= lenB; j++) {
      const chB = b.charCodeAt(j - 1);
      const cost = chA === chB ? 0 : 1;
      let val = dlPrev[j] + 1;
      const ins = dlCurr[j - 1] + 1;
      const sub = dlPrev[j - 1] + cost;
      if (ins < val) val = ins;
      if (sub < val) val = sub;

      if (i > 1 && j > 1 && chA === b.charCodeAt(j - 2) && chAPrev === chB) {
        const trans = dlPrev2[j - 2] + 1;
        if (trans < val) val = trans;
      }

      dlCurr[j] = val;
      if (val < rowMin) rowMin = val;
    }

    if (rowMin > maxDist) return maxDist + 1;

    const tmp = dlPrev2;
    dlPrev2 = dlPrev;
    dlPrev = dlCurr;
    dlCurr = tmp;
  }

  return dlPrev[lenB];
}

let diceBigramsA = new Int32Array(128);

function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const lenA = a.length;
  const lenB = b.length;
  if (lenA < 2 || lenB < 2) return 0;

  const totalBigrams = lenA + lenB - 2;
  const maxPossibleMatches = Math.min(lenA, lenB) - 1;
  if ((2 * maxPossibleMatches) / totalBigrams < 0.6) {
    return 0;
  }

  const bigramsALen = lenA - 1;
  if (bigramsALen > diceBigramsA.length) {
    diceBigramsA = new Int32Array(bigramsALen + 32);
  }
  for (let i = 0; i < bigramsALen; i++) {
    diceBigramsA[i] = (a.charCodeAt(i) << 16) | a.charCodeAt(i + 1);
  }

  let matches = 0;
  const bigramsBLen = lenB - 1;
  for (let i = 0; i < bigramsBLen; i++) {
    const bg = (b.charCodeAt(i) << 16) | b.charCodeAt(i + 1);
    for (let j = 0; j < bigramsALen; j++) {
      if (diceBigramsA[j] === bg) {
        matches++;
        diceBigramsA[j] = -1;
        break;
      }
    }
  }

  return (2 * matches) / totalBigrams;
}

function matchQueryTokenFuzzy(qToken: string, tokens: string[]): number {
  let best = 0;
  const maxDist = qToken.length <= 4 ? 1 : qToken.length <= 7 ? 2 : 3;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token === qToken || token === toSingular(qToken)) {
      return 140 - Math.min(i * 5, 25);
    }
    if (token.startsWith(qToken)) {
      best = Math.max(best, 105 - Math.min(i * 5, 25));
      continue;
    }
    if (qToken.length >= 4 && qToken.startsWith(token) && token.length >= 3) {
      best = Math.max(best, 75 - Math.min(i * 5, 25));
      continue;
    }
    if (qToken.length >= 3 && token.includes(qToken)) {
      best = Math.max(best, 45);
      continue;
    }

    if (qToken.length < 2) continue;
    if (qToken.length <= 3 && token[0] !== qToken[0]) continue;

    let bestDist = damerauLevenshtein(qToken, token, maxDist);
    if (
      bestDist > maxDist &&
      qToken.length >= 4 &&
      token.length > qToken.length &&
      (token.charCodeAt(0) === qToken.charCodeAt(0) ||
        token.charCodeAt(1) === qToken.charCodeAt(0) ||
        token.charCodeAt(0) === qToken.charCodeAt(1))
    ) {
      const pDistSame = damerauLevenshtein(qToken, token.slice(0, qToken.length), 1);
      if (pDistSame <= 1 && pDistSame < bestDist) {
        bestDist = pDistSame;
      }
      const pDistPlus = damerauLevenshtein(qToken, token.slice(0, qToken.length + 1), 1);
      if (pDistPlus <= 1 && pDistPlus < bestDist) {
        bestDist = pDistPlus;
      }
    }

    if (bestDist <= maxDist) {
      const fuzzyScore = Math.max(25, 95 - bestDist * 30 - Math.min(i * 5, 25));
      best = Math.max(best, fuzzyScore);
      continue;
    }

    if (
      qToken.length >= 5 &&
      Math.abs(qToken.length - token.length) <= 3 &&
      diceSimilarity(qToken, token) >= 0.65
    ) {
      best = Math.max(best, 35);
    }
  }

  return best;
}

/**
 * Pure in-memory ranking and filtering for whole-food staples.
 * Ranks exact matches first, followed by prefix matches and token-prefix matches,
 * while ensuring all query tokens match (with a prep-modifier fallback when no exact match exists).
 */
export function filterStaples(
  items: FoodItem[],
  query: string,
  limit: number = 25,
  options?: { allowFuzzy?: boolean }
): FoodItem[] {
  const allowFuzzy = options?.allowFuzzy ?? true;
  const trimmed = query.trim().toLowerCase();
  const normalizedQuery = trimmed
    .replace(/['’.,()-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const compactQuery = normalizedQuery.replace(/[^a-z0-9]/g, '');
  if (!trimmed) {
    return items.slice(0, limit);
  }

  const queryTokens = normalizedQuery.split(/[\s/]+/).filter(Boolean);
  const scored: Array<{ item: FoodItem; score: number }> = [];
  const scoredIds = new Set<string>();

  for (const item of items) {
    const {
      nameLower,
      nameNorm,
      brandNorm,
      combinedNorm,
      nameTokens,
      brandTokens,
    } = getFoodTokens(item);

    let matchesAllTokens = true;
    let brandMatched = false;
    let score = 0;

    if (nameLower === trimmed || nameNorm === normalizedQuery) {
      score += 1000;
    } else if (nameLower.startsWith(trimmed) || nameNorm.startsWith(normalizedQuery)) {
      score += 800;
    } else if (combinedNorm === normalizedQuery) {
      score += 950;
    } else if (combinedNorm.startsWith(normalizedQuery)) {
      score += 750;
    }

    for (const qToken of queryTokens) {
      let tokenMatched = false;

      for (let i = 0; i < nameTokens.length; i++) {
        const nToken = nameTokens[i];
        if (nToken === qToken) {
          score += 150 - Math.min(i * 10, 50);
          tokenMatched = true;
        } else if (nToken.startsWith(qToken)) {
          score += 100 - Math.min(i * 10, 50);
          tokenMatched = true;
        }
      }

      for (let i = 0; i < brandTokens.length; i++) {
        const bToken = brandTokens[i];
        if (bToken === qToken) {
          score += 120 - Math.min(i * 10, 40);
          tokenMatched = true;
          brandMatched = true;
        } else if (bToken.startsWith(qToken)) {
          score += 80 - Math.min(i * 10, 40);
          tokenMatched = true;
          brandMatched = true;
        }
      }

      if (!tokenMatched && nameNorm.includes(qToken)) {
        score += 20;
        tokenMatched = true;
      } else if (!tokenMatched && brandNorm.includes(qToken)) {
        score += 20;
        tokenMatched = true;
        brandMatched = true;
      }

      if (!tokenMatched) {
        matchesAllTokens = false;
        break;
      }
    }

    if (matchesAllTokens && score > 0) {
      if (item.region === 'PH') {
        score += 30;
      }
      if (brandMatched) {
        score += 30;
      }
      // Prefer shorter names (closer match, less noise)
      score += Math.max(0, 40 - nameLower.length * 0.2);
      scored.push({ item, score: score + 1000 });
      scoredIds.add(item.id);
    }
  }

  // Fallback pass: strip cooking/prep modifiers (e.g. "Steamed Broccoli", "Grilled Salmon")
  if (scored.length === 0 && queryTokens.length > 1) {
    const coreTokens = queryTokens.filter((t) => !PREP_MODIFIERS.has(t));
    if (coreTokens.length > 0 && coreTokens.length < queryTokens.length) {
      const queryTokenSet = new Set(queryTokens);
      const wantsCooked = queryTokens.some((t) => COOKED_MODIFIERS.has(t));

      for (const item of items) {
        const { nameLower, nameNorm, nameTokens, brandTokens } = getFoodTokens(item);
        let matchedCore = 0;
        let score = 0;

        for (const qToken of coreTokens) {
          const qSingular = toSingular(qToken);
          let tokenMatched = false;

          for (let i = 0; i < nameTokens.length; i++) {
            const nToken = nameTokens[i];
            if (nToken === qToken || nToken === qSingular) {
              score += 160 - Math.min(i * 10, 50);
              if (i === 0) score += 80;
              tokenMatched = true;
              break;
            } else if (qSingular.length >= 3 && nToken.startsWith(qSingular)) {
              score += 100 - Math.min(i * 10, 50);
              if (i === 0) score += 40;
              tokenMatched = true;
              break;
            }
          }

          if (!tokenMatched) {
            for (let i = 0; i < brandTokens.length; i++) {
              const bToken = brandTokens[i];
              if (bToken === qToken || bToken === qSingular) {
                score += 110 - Math.min(i * 10, 40);
                tokenMatched = true;
                break;
              }
            }
          }

          if (!tokenMatched && qSingular.length >= 3 && nameNorm.includes(qSingular)) {
            score += 20;
            tokenMatched = true;
          }

          if (tokenMatched) {
            matchedCore++;
          } else {
            break;
          }
        }

        if (matchedCore === coreTokens.length && score > 0) {
          for (const mod of queryTokens) {
            if (PREP_MODIFIERS.has(mod) && nameTokens.includes(mod)) {
              score += 55;
            }
          }
          if (wantsCooked && nameTokens.includes('cooked')) {
            score += 45;
          }
          for (const nToken of nameTokens) {
            if (SUBPART_PENALTY.has(nToken) && !queryTokenSet.has(nToken)) {
              score -= 180;
            }
          }
          if (item.region === 'PH') {
            score += 30;
          }
          score += Math.max(0, 40 - nameLower.length * 0.2);
          if (score > 0 && !scoredIds.has(item.id)) {
            scored.push({ item, score: score + 500 });
            scoredIds.add(item.id);
          }
        }
      }
    }
  }

  // Pass 3: Typo-tolerant / fuzzy / compact-space fallback when no exact/prep match exists
  if (allowFuzzy && scored.length === 0) {
    const queryTokenSet = new Set(queryTokens);

    for (const item of items) {
      if (scoredIds.has(item.id)) continue;

      const {
        nameLower,
        compactName,
        compactCombined,
        nameTokens,
        brandTokens,
      } = getFoodTokens(item);

      let compactScore = 0;
      if (compactQuery.length >= 4) {
        if (compactName === compactQuery || compactCombined === compactQuery) {
          compactScore = 400;
        } else if (
          compactName.includes(compactQuery) ||
          compactCombined.includes(compactQuery)
        ) {
          compactScore = 300;
        } else if (
          compactQuery.length >= 5 &&
          Math.abs(compactName.length - compactQuery.length) <= 3
        ) {
          const maxCompactDist = compactQuery.length <= 7 ? 2 : 3;
          const dist = damerauLevenshtein(compactQuery, compactName, maxCompactDist);
          if (dist <= maxCompactDist) {
            compactScore = Math.max(150, 320 - dist * 55);
          }
        }
      }

      let matchedCount = 0;
      let tokenScoreSum = 0;
      let brandMatched = false;

      for (const qToken of queryTokens) {
        const nScore = matchQueryTokenFuzzy(qToken, nameTokens);
        const bScore = matchQueryTokenFuzzy(qToken, brandTokens);
        const bestTokenScore = Math.max(nScore, bScore);
        if (bestTokenScore > 0) {
          matchedCount++;
          tokenScoreSum += bestTokenScore;
          if (bScore > 0 && bScore >= nScore) {
            brandMatched = true;
          }
        }
      }

      const qualifies =
        compactScore > 0 ||
        (queryTokens.length > 0 && matchedCount === queryTokens.length) ||
        (queryTokens.length >= 2 &&
          matchedCount >= Math.ceil(queryTokens.length * 0.6));

      if (!qualifies) continue;

      let fuzzyScore = compactScore + tokenScoreSum;
      if (matchedCount === queryTokens.length && queryTokens.length > 0) {
        fuzzyScore += 200;
      }
      if (item.region === 'PH') {
        fuzzyScore += 30;
      }
      if (brandMatched) {
        fuzzyScore += 30;
      }
      for (const nToken of nameTokens) {
        if (SUBPART_PENALTY.has(nToken) && !queryTokenSet.has(nToken)) {
          fuzzyScore -= 40;
        }
      }
      fuzzyScore += Math.max(0, 40 - nameLower.length * 0.2);

      if (fuzzyScore > 0) {
        scored.push({ item, score: fuzzyScore });
        scoredIds.add(item.id);
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

/**
 * Returns the in-memory staples cache when seeded (e.g. in tests or legacy callers).
 * Static staples JSON files have been retired in favor of the SQLite FTS5 catalog.
 */
export async function loadStaples(): Promise<FoodItem[]> {
  if (cachedStaples && cachedStaples.length > 0) {
    return cachedStaples;
  }
  return [];
}

/**
 * Allows pre-seeding or clearing memory cache (especially useful for tests).
 */
export function setStaplesCache(staples: FoodItem[] | null): void {
  cachedStaples = staples ? hydrateStapleList(staples) : null;
}

/**
 * Searches offline staples cache if seeded, otherwise delegates to the unified
 * SQLite FTS5 client catalog (`searchClientCatalog`).
 */
export async function searchStaples(query: string, limit: number = 25): Promise<FoodItem[]> {
  const staples = await loadStaples();
  if (staples.length > 0) {
    return filterStaples(staples, query, limit);
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const { items } = await searchClientCatalog(trimmed, { limit });
    return hydrateStapleList(items);
  } catch {
    return [];
  }
}

function hasAllTrackedMicros(micros?: Micronutrients): boolean {
  if (!micros) return false;
  for (const key of CORE_RDA_MICRONUTRIENT_KEYS) {
    if (typeof micros[key] !== 'number') {
      return false;
    }
  }
  return true;
}

function selectCleanStapleCandidate(candidates: FoodItem[], query: string): FoodItem | undefined {
  if (candidates.length === 0) return undefined;
  const queryTokens = new Set(
    query.trim().toLowerCase().replace(/['’]/g, '').split(/[\s,/-]+/).filter(Boolean)
  );
  const cleanMatch = candidates.find((candidate) => {
    const { nameTokens } = getFoodTokens(candidate);
    return !nameTokens.some((t) => SUBPART_PENALTY.has(t) && !queryTokens.has(t));
  });
  return cleanMatch ?? candidates[0];
}

function applyStapleMicrosToItem<
  T extends { name: string; microsPer100g?: Micronutrients },
>(item: T, bestStaple: FoodItem | undefined): T & { microsPer100g?: Micronutrients } {
  if (!bestStaple?.micronutrientsPerBasis) {
    return item;
  }

  let scaleTo100g = 1;
  if (bestStaple.basis === 'perServing') {
    const grams = getPerServingWeightGrams(bestStaple);
    if (!grams || grams <= 0) {
      return item;
    }
    scaleTo100g = 100 / grams;
  }

  const stapleMicros = estimateMissingStapleMicros(bestStaple);
  const mergedMicros: Micronutrients = { ...(item.microsPer100g ?? {}) };
  let changed = false;
  for (const key of TRACKED_MICRONUTRIENT_KEYS) {
    const existingVal = mergedMicros[key];
    const rawStapleVal = stapleMicros[key];
    if (typeof existingVal !== 'number' && typeof rawStapleVal === 'number') {
      mergedMicros[key] =
        scaleTo100g === 1 ? rawStapleVal : round2(rawStapleVal * scaleTo100g);
      changed = true;
    }
  }

  if (!changed) {
    return item;
  }

  return {
    ...item,
    microsPer100g: mergedMicros,
  };
}

/**
 * Enriches meal items with missing micronutrient densities from the local staples cache
 * or (on the server) the SQLite FTS5 food catalog.
 * Never overwrites micronutrient keys already populated by the AI or user verification.
 */
export async function enrichMealItemsWithStaples<
  T extends { name: string; microsPer100g?: Micronutrients },
>(items: T[]): Promise<Array<T & { microsPer100g?: Micronutrients }>> {
  if (!Array.isArray(items) || items.length === 0) {
    return items;
  }

  const needsEnrichment = items.some((item) => !hasAllTrackedMicros(item.microsPer100g));
  if (!needsEnrichment) {
    return items;
  }

  const staples = await loadStaples();
  if (staples.length > 0) {
    return items.map((item) => {
      if (hasAllTrackedMicros(item.microsPer100g)) {
        return item;
      }

      const candidates = filterStaples(staples, item.name, 8, { allowFuzzy: false });
      const bestStaple = selectCleanStapleCandidate(candidates, item.name);
      return applyStapleMicrosToItem(item, bestStaple);
    });
  }

  if (typeof window !== 'undefined') {
    return items;
  }

  let searchServerCatalogFn: typeof import('./server-catalog').searchServerCatalog;
  try {
    const serverCatalog = await import('./server-catalog');
    searchServerCatalogFn = serverCatalog.searchServerCatalog;
  } catch {
    return items;
  }

  return Promise.all(
    items.map(async (item) => {
      if (hasAllTrackedMicros(item.microsPer100g) || !item.name?.trim()) {
        return item;
      }
      try {
        const candidates = await searchServerCatalogFn(item.name, { limit: 8 });
        const bestStaple = selectCleanStapleCandidate(candidates, item.name);
        return applyStapleMicrosToItem(item, bestStaple);
      } catch {
        return item;
      }
    })
  );
}
