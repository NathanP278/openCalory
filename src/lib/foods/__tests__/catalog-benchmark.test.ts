import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, afterAll } from 'vitest';
import {
  searchServerCatalog,
  resetServerCatalogCache,
} from '@/lib/foods/server-catalog';
import { buildCanonicalFoodKey } from '@/lib/foods/name-normalizer';

const BENCHMARK_QUERIES = [
  'egg',
  'white japanese rice',
  'chicken breast',
  'jollibee',
  'pandesal',
  'ramen',
  'olive oil',
  "ben & jerry's",
  'chiken brest',
  'banana',
  'salmon',
  'oatmeal',
  'bibimbap',
  'pad thai',
  'pho',
  'croissant',
  'avocado',
  'milk',
  'pork adobo',
  'tofu',
] as const;

const CATALOG_GZIP_PATH = path.resolve(
  process.cwd(),
  'public',
  'data',
  'food-catalog.db.gz'
);

describe('food catalog quality & latency benchmark', () => {
  afterAll(() => {
    resetServerCatalogCache();
  });

  it('has built public/data/food-catalog.db.gz on disk', () => {
    expect(fs.existsSync(CATALOG_GZIP_PATH)).toBe(true);
    const stat = fs.statSync(CATALOG_GZIP_PATH);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('meets quality, deduplication, servingOptions, and <25ms median latency across 20 real queries', async () => {
    // Warm up once (decompresses db.gz into tmpdir and opens SQLite connection)
    const warmup = await searchServerCatalog('chicken', { limit: 20 });
    expect(warmup.length).toBeGreaterThan(0);

    const timingsMs: number[] = [];
    const resultsByQuery = new Map<string, Awaited<ReturnType<typeof searchServerCatalog>>>();

    for (const query of BENCHMARK_QUERIES) {
      const start = performance.now();
      const results = await searchServerCatalog(query, { limit: 20 });
      const elapsed = performance.now() - start;

      timingsMs.push(elapsed);
      resultsByQuery.set(query, results);

      // Every benchmark query should return at least one result
      expect(results.length, `Expected results for query "${query}"`).toBeGreaterThan(0);

      // Zero duplicate canonical IDs or canonical names in top 20 results
      const seenIds = new Set<string>();
      const seenCanonicalKeys = new Set<string>();
      for (const item of results) {
        expect(
          seenIds.has(item.id),
          `Duplicate canonical ID "${item.id}" for query "${query}"`
        ).toBe(false);
        seenIds.add(item.id);

        const canonicalKey = buildCanonicalFoodKey(item.name, item.brand);
        expect(
          seenCanonicalKeys.has(canonicalKey),
          `Duplicate canonical key "${canonicalKey}" (${item.name}) for query "${query}"`
        ).toBe(false);
        seenCanonicalKeys.add(canonicalKey);
      }
    }

    // Everyday staple: 'egg' -> large or pc, plus g and oz
    const eggTop = resultsByQuery.get('egg')?.[0];
    expect(eggTop).toBeDefined();
    const eggUnits = new Set((eggTop?.servingOptions ?? []).map((o) => o.unit.toLowerCase()));
    expect(
      eggUnits.has('large') || eggUnits.has('pc'),
      `Expected 'egg' top result (${eggTop?.name}) to include 'large' or 'pc', got: ${Array.from(eggUnits).join(', ')}`
    ).toBe(true);
    expect(eggUnits.has('g'), `Expected 'egg' top result to include 'g'`).toBe(true);
    expect(eggUnits.has('oz'), `Expected 'egg' top result to include 'oz'`).toBe(true);

    // Everyday staple: 'white japanese rice' -> cup, g, and oz
    const riceTop = resultsByQuery.get('white japanese rice')?.[0];
    expect(riceTop).toBeDefined();
    const riceUnits = new Set((riceTop?.servingOptions ?? []).map((o) => o.unit.toLowerCase()));
    expect(
      riceUnits.has('cup'),
      `Expected 'white japanese rice' top result (${riceTop?.name}) to include 'cup', got: ${Array.from(riceUnits).join(', ')}`
    ).toBe(true);
    expect(riceUnits.has('g'), `Expected 'white japanese rice' top result to include 'g'`).toBe(true);
    expect(riceUnits.has('oz'), `Expected 'white japanese rice' top result to include 'oz'`).toBe(true);

    // Regional & restaurant results with servingOptions
    const jollibeeResults = resultsByQuery.get('jollibee') ?? [];
    expect(
      jollibeeResults.some(
        (item) =>
          (item.brand?.toLowerCase().includes('jollibee') ||
            item.name.toLowerCase().includes('jollibee')) &&
          (item.servingOptions?.length ?? 0) > 0
      ),
      'Expected relevant Jollibee result with servingOptions'
    ).toBe(true);

    const pandesalResults = resultsByQuery.get('pandesal') ?? [];
    expect(
      pandesalResults.some(
        (item) =>
          item.name.toLowerCase().includes('pandesal') &&
          (item.servingOptions?.length ?? 0) > 0
      ),
      'Expected relevant Pandesal result with servingOptions'
    ).toBe(true);

    const ramenResults = resultsByQuery.get('ramen') ?? [];
    expect(
      ramenResults.some(
        (item) =>
          (item.name.toLowerCase().includes('ramen') ||
            (item.aliases ?? []).some((a) => a.toLowerCase().includes('ramen'))) &&
          (item.servingOptions?.length ?? 0) > 0
      ),
      'Expected relevant Ramen result with servingOptions'
    ).toBe(true);

    // Median latency across the 20 queries must be < 25 ms
    const sorted = [...timingsMs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianMs =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

    console.info(
      `[catalog-benchmark] 20 queries median=${medianMs.toFixed(2)}ms, min=${sorted[0].toFixed(2)}ms, max=${sorted[sorted.length - 1].toFixed(2)}ms`
    );

    expect(
      medianMs,
      `Expected median FTS5 query latency < 25 ms, got ${medianMs.toFixed(2)} ms`
    ).toBeLessThan(25);
  });
});
