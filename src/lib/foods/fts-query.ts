import type { CatalogFoodRow } from '@/lib/foods/catalog-schema';

export const FTS_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

export const PREP_MODIFIERS = new Set([
  'grilled',
  'steamed',
  'boiled',
  'baked',
  'roasted',
  'fried',
  'pan',
  'seared',
  'sauteed',
  'poached',
  'scrambled',
  'mashed',
  'cooked',
  'raw',
  'fresh',
  'organic',
  'boneless',
  'skinless',
  'fillet',
  'sliced',
  'chopped',
  'diced',
  'minced',
  'shredded',
  'grated',
  'plain',
  'extra',
  'virgin',
  'light',
  'lean',
  'trimmed',
  'peeled',
  'dry',
  'uncooked',
]);

export interface CandidateRow {
  row: CatalogFoodRow;
  bm25: number;
}

/**
 * Extracts normalized, deduplicated, FTS5-safe alphanumeric tokens from a raw user query.
 * Strips diacritics, strips possessive "'s" / "’s", and drops FTS5 boolean operators.
 */
export function tokenizeQuery(raw: string): string[] {
  if (!raw || typeof raw !== 'string') return [];

  // Normalize possessive "'s" / "’s" so "ben & jerry's" yields ["ben", "jerry"]
  const cleaned = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/(?<=[\p{L}\p{N}])['’]s\b/giu, ' ');

  const rawTokens = cleaned.match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const token of rawTokens) {
    if (FTS_OPERATORS.has(token.toUpperCase())) continue;
    const lower = token.toLowerCase();
    if (!lower || seen.has(lower)) continue;
    seen.add(lower);
    tokens.push(lower);
    if (tokens.length >= 12) break;
  }

  return tokens;
}

/**
 * Converts any raw user input into a safe SQLite FTS5 MATCH expression.
 * Returns empty string when no searchable tokens remain.
 */
export function sanitizeFtsQuery(raw: string): string {
  const tokens = tokenizeQuery(raw);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token}"*`).join(' ');
}

export function rowRecordToCatalogFoodRow(row: Record<string, unknown>): CatalogFoodRow {
  return {
    rowid: Number(row.rowid ?? 0),
    id: String(row.id ?? ''),
    barcode: row.barcode == null ? null : String(row.barcode),
    source: String(row.source ?? 'catalog'),
    accuracy_tier: Number(row.accuracy_tier ?? 4),
    region: String(row.region ?? 'GLOBAL'),
    category: String(row.category ?? ''),
    name: String(row.name ?? ''),
    brand: String(row.brand ?? ''),
    aliases: String(row.aliases ?? ''),
    basis: String(row.basis ?? 'per100g'),
    serving_size: Number(row.serving_size ?? 100),
    serving_unit: String(row.serving_unit ?? 'g'),
    serving_weight_grams:
      row.serving_weight_grams == null ? null : Number(row.serving_weight_grams),
    calories: Number(row.calories ?? 0),
    protein: Number(row.protein ?? 0),
    carbs: Number(row.carbs ?? 0),
    fat: Number(row.fat ?? 0),
    fiber: Number(row.fiber ?? 0),
    micronutrients_json: String(row.micronutrients_json ?? '{}'),
    serving_options_json: String(row.serving_options_json ?? '[]'),
    search_rank: Number(row.search_rank ?? 0),
  };
}

export function damerauLevenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  const d: number[][] = Array.from({ length: la + 1 }, () => new Array<number>(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, d[i - 2][j - 2] + 1);
      }
      d[i][j] = val;
    }
  }
  return d[la][lb];
}

export function normalizeForScoring(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function bestTokenMatchScore(queryToken: string, fieldTokens: string[]): number {
  let best = 0;
  for (const ft of fieldTokens) {
    if (ft === queryToken) return 1.0;
    if (
      (ft.length === queryToken.length + 1 && ft === `${queryToken}s`) ||
      (queryToken.length === ft.length + 1 && queryToken === `${ft}s`)
    ) {
      best = Math.max(best, 0.96);
      continue;
    }
    if (ft.startsWith(queryToken)) {
      const ratio = queryToken.length / ft.length;
      best = Math.max(best, 0.45 + 0.4 * ratio);
      continue;
    }
    if (queryToken.length >= 4 && Math.abs(ft.length - queryToken.length) <= 2) {
      const dist = damerauLevenshtein(queryToken, ft);
      if (dist === 1) {
        best = Math.max(best, 0.82);
      } else if (dist === 2 && queryToken.length >= 5) {
        best = Math.max(best, 0.58);
      }
    }
  }
  return best;
}

const SUBPART_PENALTY_TOKENS = new Set([
  'yolk',
  'white',
  'whites',
  'dried',
  'powder',
  'powdered',
  'dehydrated',
  'shell',
  'substitute',
  'frozen',
  'pasteurized',
  'peel',
  'skin',
  'leaves',
  'leaf',
  'bran',
  'germ',
  'flour',
  'starch',
  'juice',
  'syrup',
  'baby',
  'infant',
  'formula',
]);

export function scoreCandidate(
  candidate: CandidateRow,
  queryTokens: string[],
  queryNorm: string,
  region?: string
): number {
  const { row, bm25 } = candidate;
  const nameNorm = normalizeForScoring(row.name);
  const nameTokens = nameNorm ? nameNorm.split(' ') : [];
  const nameTokenSet = new Set(nameTokens);
  const queryTokenSet = new Set(queryTokens);
  const brandNorm = normalizeForScoring(row.brand);
  const brandTokens = brandNorm ? brandNorm.split(' ') : [];

  const aliasParts = row.aliases
    ? row.aliases
        .split('|')
        .map((a) => normalizeForScoring(a))
        .filter(Boolean)
    : [];
  const aliasTokens = aliasParts.flatMap((a) => a.split(' '));

  let score = Math.min(Math.max(-bm25, 0), 40);

  const hasExactWholeWordInSet = (qt: string, tokenSet: Set<string>): boolean =>
    tokenSet.has(qt) ||
    tokenSet.has(`${qt}s`) ||
    (qt.endsWith('s') && qt.length > 3 && tokenSet.has(qt.slice(0, -1)));

  const allQueryTokensExactInName =
    queryTokens.length > 0 && queryTokens.every((qt) => hasExactWholeWordInSet(qt, nameTokenSet));

  // Best unordered exact-token match against any individual alias (e.g. "japanese white rice" for "white japanese rice")
  let bestAliasPrecision = 0;
  if (queryTokens.length > 0 && aliasParts.length > 0) {
    for (const aliasPart of aliasParts) {
      const aTokens = aliasPart.split(' ');
      const aSet = new Set(aTokens);
      if (queryTokens.every((qt) => hasExactWholeWordInSet(qt, aSet))) {
        const precision = Math.min(1, queryTokens.length / Math.max(aTokens.length, 1));
        if (precision > bestAliasPrecision) {
          bestAliasPrecision = precision;
        }
      }
    }
  }

  // Exact name / alias / prefix boosts
  if (nameNorm === queryNorm) {
    score += 140;
  } else if (aliasParts.includes(queryNorm)) {
    score += 105;
  } else if (bestAliasPrecision > 0 && !allQueryTokensExactInName) {
    score += 25 + 65 * bestAliasPrecision;
  } else if (allQueryTokensExactInName) {
    const namePrecision = Math.min(1, queryTokens.length / Math.max(nameTokens.length, 1));
    score += Math.max(25 + 50 * namePrecision, bestAliasPrecision > 0 ? 25 + 65 * bestAliasPrecision : 0);
    if (
      nameNorm.startsWith(`${queryNorm} `) ||
      row.name.toLowerCase().startsWith(`${queryNorm},`) ||
      (nameTokens.length > 0 &&
        queryTokens.length === 1 &&
        (nameTokens[0] === queryTokens[0] || nameTokens[0] === `${queryTokens[0]}s`))
    ) {
      score += 20;
    }
    if (queryTokens.length === 1 && nameTokenSet.has('whole')) {
      score += 35;
    }
  } else if (nameNorm.startsWith(queryNorm)) {
    score += 18;
  }

  // Penalize subpart / derivative foods (e.g. Egg Yolk, Egg White, Dried) unless user asked for them
  for (const nt of nameTokens) {
    if (SUBPART_PENALTY_TOKENS.has(nt) && !queryTokenSet.has(nt)) {
      score -= 32;
    }
  }

  // Token coverage + fuzzy match score
  let matchedCount = 0;
  let tokenScoreSum = 0;
  for (const qt of queryTokens) {
    const inName = bestTokenMatchScore(qt, nameTokens);
    const inAlias = bestTokenMatchScore(qt, aliasTokens) * 0.9;
    const inBrand = bestTokenMatchScore(qt, brandTokens) * 0.75;
    const best = Math.max(inName, inAlias, inBrand);
    tokenScoreSum += best;
    if (best >= 0.55) {
      matchedCount++;
    }
  }

  const coverageRatio = queryTokens.length > 0 ? matchedCount / queryTokens.length : 0;
  score += tokenScoreSum * 28;
  score += coverageRatio * 30;
  if (matchedCount === queryTokens.length && queryTokens.length > 0) {
    score += 25;
  }

  // Accuracy tier bonus
  if (row.accuracy_tier === 1) score += 24;
  else if (row.accuracy_tier === 2) score += 14;
  else if (row.accuracy_tier === 3) score += 6;

  // Search rank contribution
  score += Math.min(Math.max(row.search_rank, 0), 100) * 0.35;

  // Optional regional boost
  if (region && row.region.toUpperCase() === region.trim().toUpperCase()) {
    score += 14;
  }

  // Mild conciseness tie-breaker
  score -= Math.min(row.name.length, 90) * 0.08;

  return score;
}

export function rankCandidates(
  candidates: Iterable<CandidateRow>,
  queryTokens: string[],
  options?: { limit?: number; region?: string }
): CatalogFoodRow[] {
  const limit = Math.max(1, Math.min(100, Math.round(options?.limit ?? 20)));
  const queryNorm = queryTokens.join(' ');

  return Array.from(candidates)
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, queryTokens, queryNorm, options?.region),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.candidate.row.accuracy_tier !== b.candidate.row.accuracy_tier) {
        return a.candidate.row.accuracy_tier - b.candidate.row.accuracy_tier;
      }
      if (b.candidate.row.search_rank !== a.candidate.row.search_rank) {
        return b.candidate.row.search_rank - a.candidate.row.search_rank;
      }
      return a.candidate.row.name.length - b.candidate.row.name.length;
    })
    .slice(0, limit)
    .map(({ candidate }) => candidate.row);
}
