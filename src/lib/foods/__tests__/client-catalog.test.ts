import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FoodItem } from '@/types/nutrition';
import type { CatalogManifest } from '../catalog-schema';
import { sanitizeFtsQuery, tokenizeQuery } from '../fts-query';
import {
  checkOpfsQuota,
  createClientCatalogController,
  initClientCatalog,
  getCatalogSyncState,
  subscribeCatalogSync,
  resetClientCatalogForTests,
  searchClientCatalog,
  lookupClientCatalogBarcode,
  resolveClientLegacyIds,
  type CatalogSyncState,
  type WorkerLike,
} from '../client-catalog';
import { syncCatalogToOpfs, type OpfsDirectoryLike } from '../catalog-worker';

function makeFood(overrides: Partial<FoodItem> = {}): FoodItem {
  return {
    id: 'catalog:usda:171287',
    barcode: null,
    source: 'usda',
    accuracyTier: 1,
    name: 'Egg, whole, raw, fresh',
    region: 'US',
    basis: 'per100g',
    servingSize: 100,
    servingUnit: 'g',
    nutrientsPerBasis: { calories: 143, protein: 12.6, carbs: 0.7, fat: 9.5, fiber: 0 },
    micronutrientsPerBasis: {},
    updatedAt: 0,
    ...overrides,
  };
}

const SAMPLE_MANIFEST: CatalogManifest = {
  version: '2026.11.23-core',
  tier: 'core',
  sha256: 'abc123def4567890abc123def4567890abc123def4567890abc123def4567890',
  builtAt: '2026-11-23T00:00:00.000Z',
  foodCount: 15000,
  gzipBytes: 4_000_000,
  rawBytes: 12_000_000,
  license: 'ODbL-1.0',
};

/**
 * Controllable mock Web Worker for testing client-catalog bridge behavior
 * (sync state transitions, OPFS routing, monotonic cancellation, barcode/legacy resolution).
 */
class MockCatalogWorker implements WorkerLike {
  public posted: Array<Record<string, unknown>> = [];
  public terminated = false;
  private messageListeners = new Set<(ev: { data: unknown }) => void>();
  private errorListeners = new Set<(ev: { message?: string }) => void>();

  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }

  addEventListener(type: 'message' | 'error', listener: (ev: never) => void): void {
    if (type === 'message') {
      this.messageListeners.add(listener as (ev: { data: unknown }) => void);
    } else if (type === 'error') {
      this.errorListeners.add(listener as (ev: { message?: string }) => void);
    }
  }

  removeEventListener(type: 'message' | 'error', listener: (ev: never) => void): void {
    if (type === 'message') {
      this.messageListeners.delete(listener as (ev: { data: unknown }) => void);
    } else if (type === 'error') {
      this.errorListeners.delete(listener as (ev: { message?: string }) => void);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    for (const listener of this.messageListeners) {
      listener({ data });
    }
  }

  emitError(message: string): void {
    for (const listener of this.errorListeners) {
      listener({ message });
    }
  }
}

/**
 * In-memory OPFS mock for testing manifest-match skip and atomic swap without real browser OPFS.
 */
function createMemoryOpfsDir(initialFiles: Record<string, Uint8Array | string> = {}): {
  root: OpfsDirectoryLike;
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();
  for (const [name, content] of Object.entries(initialFiles)) {
    files.set(
      name,
      typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content)
    );
  }

  const root: OpfsDirectoryLike = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) {
          throw new DOMException(`File not found: ${name}`, 'NotFoundError');
        }
        files.set(name, new Uint8Array(0));
      }
      return {
        async getFile() {
          const data = files.get(name) ?? new Uint8Array(0);
          return {
            size: data.byteLength,
            async text() {
              return new TextDecoder().decode(data);
            },
            async arrayBuffer() {
              return data.slice().buffer;
            },
          };
        },
        async createWritable() {
          const chunks: Uint8Array[] = [];
          return {
            async write(chunk: Uint8Array | string) {
              chunks.push(
                typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)
              );
            },
            async close() {
              const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
              const out = new Uint8Array(total);
              let offset = 0;
              for (const c of chunks) {
                out.set(c, offset);
                offset += c.byteLength;
              }
              files.set(name, out);
            },
          };
        },
      };
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
  };

  return { root, files };
}

describe('fts-query (Review Focus #1: browser-safe FTS5 sanitization)', () => {
  it('sanitizes special characters, possessives, and FTS5 operators safely', () => {
    expect(sanitizeFtsQuery("ben & jerry's")).toBe('"ben"* "jerry"*');
    expect(sanitizeFtsQuery('OR NOT *')).toBe('');
    expect(sanitizeFtsQuery('coca-cola')).toBe('"coca"* "cola"*');
    expect(sanitizeFtsQuery('2% milk')).toBe('"2"* "milk"*');
    expect(sanitizeFtsQuery('egg (raw)')).toBe('"egg"* "raw"*');
    expect(sanitizeFtsQuery('')).toBe('');
    expect(tokenizeQuery("ben & jerry's")).toEqual(['ben', 'jerry']);
    expect(tokenizeQuery('OR NOT *')).toEqual([]);
  });
});

describe('client-catalog (OPFS/quota safety, worker bridge, cancellation, fallback)', () => {
  beforeEach(() => {
    resetClientCatalogForTests();
  });

  afterEach(() => {
    resetClientCatalogForTests();
    vi.restoreAllMocks();
  });

  describe('Review Focus #4: OPFS unavailable & insufficient quota fallback', () => {
    it('checkOpfsQuota reports unavailable when navigator.storage.getDirectory is missing', async () => {
      const res = await checkOpfsQuota(SAMPLE_MANIFEST.rawBytes, {
        estimate: vi.fn().mockResolvedValue({ quota: 1_000_000_000, usage: 0 }),
      } as unknown as StorageManager);

      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/opfs|getDirectory|unavailable/i);
    });

    it('checkOpfsQuota rejects when free quota is less than 2 * manifest.rawBytes', async () => {
      const storage = {
        getDirectory: vi.fn(),
        estimate: vi.fn().mockResolvedValue({
          quota: 25_000_000,
          usage: 5_000_000, // 20 MB free < 2 * 12 MB (24 MB required)
        }),
      };

      const res = await checkOpfsQuota(SAMPLE_MANIFEST.rawBytes, storage);
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/quota|storage/i);
      expect(res.requiredBytes).toBe(SAMPLE_MANIFEST.rawBytes * 2);
      expect(res.availableBytes).toBe(20_000_000);
    });

    it('transitions to fallback and routes searchClientCatalog to /api/foods/search when OPFS getDirectory is unavailable', async () => {
      const egg = makeFood();
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ items: [egg], source: 'catalog' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const controller = createClientCatalogController({
        fetchImpl: fetchMock,
        storage: null, // simulates Safari private browsing / jsdom / missing OPFS
        createWorker: () => new MockCatalogWorker(),
      });

      const states: CatalogSyncState[] = [];
      const unsub = controller.subscribe((s) => states.push(s));

      controller.init();
      await Promise.resolve();

      const current = controller.getState();
      expect(current.status).toBe('fallback');
      expect(current.reason).toBeTruthy();
      expect(states.some((s) => s.status === 'fallback')).toBe(true);

      const result = await controller.search("ben & jerry's", { limit: 15, region: 'US' });
      expect(result.source).toBe('server');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(egg.id);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calledUrl = String(fetchMock.mock.calls[0][0]);
      expect(calledUrl).toContain('/api/foods/search');
      expect(calledUrl).toContain('q=');
      expect(calledUrl).toContain('limit=15');
      expect(calledUrl).toContain('region=US');

      unsub();
    });

    it('transitions to fallback and routes to /api/foods/search when storage quota < 2 * manifest.rawBytes', async () => {
      const egg = makeFood();
      const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/foods/manifest')) {
          return new Response(JSON.stringify(SAMPLE_MANIFEST), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/foods/search')) {
          return new Response(JSON.stringify({ items: [egg], source: 'catalog' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const worker = new MockCatalogWorker();
      const controller = createClientCatalogController({
        fetchImpl: fetchMock,
        storage: {
          getDirectory: vi.fn(),
          estimate: vi.fn().mockResolvedValue({
            quota: 20_000_000,
            usage: 5_000_000, // 15 MB free < 24 MB needed
          }),
        },
        createWorker: () => worker,
      });

      controller.init();
      await vi.waitFor(() => {
        expect(controller.getState().status).toBe('fallback');
      });

      expect(controller.getState().reason).toMatch(/quota|storage/i);

      const result = await controller.search('OR NOT *');
      expect(result.source).toBe('server');
      expect(Array.isArray(result.items)).toBe(true);
    });
  });

  describe('routing during syncing vs ready', () => {
    it('routes search to /api/foods/search while syncing, then to OPFS worker once ready', async () => {
      const serverEgg = makeFood({ id: 'server:egg', name: 'Server Egg' });
      const opfsEgg = makeFood({ id: 'opfs:egg', name: 'OPFS Egg' });

      const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/foods/manifest')) {
          return new Response(JSON.stringify(SAMPLE_MANIFEST), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/foods/search')) {
          return new Response(JSON.stringify({ items: [serverEgg], source: 'catalog' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const worker = new MockCatalogWorker();
      const controller = createClientCatalogController({
        fetchImpl: fetchMock,
        storage: {
          getDirectory: vi.fn(),
          estimate: vi.fn().mockResolvedValue({ quota: 500_000_000, usage: 10_000_000 }),
        },
        createWorker: () => worker,
      });

      controller.init();
      await vi.waitFor(() => {
        expect(controller.getState().status).toBe('syncing');
      });

      // While syncing -> immediate server route
      const syncingRes = await controller.search('egg', { limit: 10 });
      expect(syncingRes.source).toBe('server');
      expect(syncingRes.items).toEqual([serverEgg]);

      // Worker signals ready
      worker.emitMessage({
        type: 'status',
        state: {
          status: 'ready',
          tier: 'core',
          foodCount: 15000,
          version: SAMPLE_MANIFEST.version,
          progressPct: 100,
        },
      });
      expect(controller.getState().status).toBe('ready');

      // Once ready -> routes to worker (source: 'opfs')
      const searchPromise = controller.search("ben & jerry's", { limit: 10, region: 'US' });
      const searchMsg = worker.posted.find((m) => m.type === 'search');
      expect(searchMsg).toBeDefined();
      expect(searchMsg!.query).toBe("ben & jerry's");

      worker.emitMessage({
        type: 'searchResult',
        requestId: searchMsg!.requestId,
        items: [opfsEgg],
      });

      const readyRes = await searchPromise;
      expect(readyRes.source).toBe('opfs');
      expect(readyRes.items).toEqual([opfsEgg]);

      // Operator-only query in OPFS mode short-circuits cleanly without crashing
      const opOnlyRes = await controller.search('OR NOT *');
      expect(opOnlyRes.source).toBe('opfs');
      expect(opOnlyRes.items).toEqual([]);
    });
  });

  describe('monotonic request cancellation', () => {
    it('cancels/ignores stale query A when query B fires before A resolves', async () => {
      const worker = new MockCatalogWorker();
      const controller = createClientCatalogController({
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(JSON.stringify(SAMPLE_MANIFEST), { status: 200 })
        ),
        storage: {
          getDirectory: vi.fn(),
          estimate: vi.fn().mockResolvedValue({ quota: 500_000_000, usage: 0 }),
        },
        createWorker: () => worker,
      });

      controller.init();
      await vi.waitFor(() => {
        expect(worker.posted.some((m) => m.type === 'init')).toBe(true);
      });

      worker.emitMessage({
        type: 'status',
        state: { status: 'ready', tier: 'core', foodCount: 100, version: '1.0' },
      });

      const foodA = makeFood({ id: 'food:a', name: 'Apple' });
      const foodB = makeFood({ id: 'food:b', name: 'Banana' });

      // Fire query A, then immediately fire query B before A resolves
      const promiseA = controller.search('apple');
      const promiseB = controller.search('banana');

      const searchMsgs = worker.posted.filter((m) => m.type === 'search');
      expect(searchMsgs).toHaveLength(2);
      const reqIdA = searchMsgs[0].requestId as number;
      const reqIdB = searchMsgs[1].requestId as number;
      expect(reqIdB).toBeGreaterThan(reqIdA);

      // Worker responds to stale query A first, then query B
      worker.emitMessage({ type: 'searchResult', requestId: reqIdA, items: [foodA] });
      worker.emitMessage({ type: 'searchResult', requestId: reqIdB, items: [foodB] });

      const [resA, resB] = await Promise.all([promiseA, promiseB]);

      // Stale query A must be ignored/empty; query B wins cleanly
      expect(resA.items).toEqual([]);
      expect(resB.source).toBe('opfs');
      expect(resB.items).toEqual([foodB]);
    });
  });

  describe('OPFS sync manifest-match skip & atomic download', () => {
    it('skips re-downloading /api/foods/catalog when stored manifest sha256 already matches', async () => {
      const { root } = createMemoryOpfsDir({
        'catalog-manifest.json': JSON.stringify(SAMPLE_MANIFEST),
        'food-catalog.db': new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]), // non-empty existing DB
      });

      const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/foods/manifest')) {
          return new Response(JSON.stringify(SAMPLE_MANIFEST), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch to ${url} — should have skipped catalog download`);
      });

      const onProgress = vi.fn();
      const result = await syncCatalogToOpfs({
        opfsRoot: root,
        fetchImpl: fetchMock,
        onProgress,
      });

      expect(result.downloaded).toBe(false);
      expect(result.manifest.sha256).toBe(SAMPLE_MANIFEST.sha256);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain('/api/foods/manifest');
    });

    it('streams, decompresses, swaps, and writes manifest when sha256 differs', async () => {
      const { gzipSync } = await import('node:zlib');
      const fakeDbBytes = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00]);
      const gzipped = new Uint8Array(gzipSync(fakeDbBytes));
      const { root, files } = createMemoryOpfsDir({
        'catalog-manifest.json': JSON.stringify({ ...SAMPLE_MANIFEST, sha256: 'old-sha' }),
      });

      const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/foods/manifest')) {
          return new Response(JSON.stringify({ ...SAMPLE_MANIFEST, rawBytes: fakeDbBytes.byteLength }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/foods/catalog')) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(gzipped);
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'application/gzip' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const result = await syncCatalogToOpfs({
        opfsRoot: root,
        fetchImpl: fetchMock,
      });

      expect(result.downloaded).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(files.get('food-catalog.db')).toEqual(fakeDbBytes);
      expect(files.has('food-catalog.tmp.db')).toBe(false);
      const savedManifest = JSON.parse(new TextDecoder().decode(files.get('catalog-manifest.json')));
      expect(savedManifest.sha256).toBe(SAMPLE_MANIFEST.sha256);
    });
  });

  describe('lookupClientCatalogBarcode and resolveClientLegacyIds', () => {
    it('works in server fallback mode', async () => {
      const coke = makeFood({
        id: 'catalog:off:0049000042566',
        barcode: '0049000042566',
        name: 'Coca-Cola Zero Sugar',
      });

      const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/foods/barcode/0049000042566')) {
          return new Response(JSON.stringify({ status: 'hit', item: coke, source: 'catalog' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ status: 'missing' }), { status: 404 });
      });

      const controller = createClientCatalogController({
        fetchImpl: fetchMock,
        storage: null,
        createWorker: () => new MockCatalogWorker(),
      });
      controller.init();

      // 12-digit UPC-A normalizes to 13-digit EAN-13
      const hit = await controller.lookupBarcode('049000042566');
      expect(hit).toEqual(coke);

      const miss = await controller.lookupBarcode('9999999999999');
      expect(miss).toBeNull();

      // In fallback mode, resolveLegacyIds returns empty Map safely
      const legacy = await controller.resolveLegacyIds(['staple:egg-whole']);
      expect(legacy).toBeInstanceOf(Map);
      expect(legacy.size).toBe(0);
    });

    it('works in OPFS worker mode for both barcode and legacy IDs', async () => {
      const worker = new MockCatalogWorker();
      const controller = createClientCatalogController({
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(JSON.stringify(SAMPLE_MANIFEST), { status: 200 })
        ),
        storage: {
          getDirectory: vi.fn(),
          estimate: vi.fn().mockResolvedValue({ quota: 500_000_000, usage: 0 }),
        },
        createWorker: () => worker,
      });

      controller.init();
      await vi.waitFor(() => {
        expect(worker.posted.some((m) => m.type === 'init')).toBe(true);
      });
      worker.emitMessage({
        type: 'status',
        state: { status: 'ready', tier: 'core', foodCount: 15000, version: SAMPLE_MANIFEST.version },
      });

      const egg = makeFood({ id: 'catalog:usda:171287', barcode: '0049000042566' });

      // Barcode lookup via worker
      const barcodePromise = controller.lookupBarcode('049000042566');
      const barcodeMsg = worker.posted.find((m) => m.type === 'barcode');
      expect(barcodeMsg).toBeDefined();
      worker.emitMessage({
        type: 'barcodeResult',
        requestId: barcodeMsg!.requestId,
        item: egg,
      });
      expect(await barcodePromise).toEqual(egg);

      // Legacy ID resolution via worker
      const legacyPromise = controller.resolveLegacyIds(['staple:egg-whole', 'unknown:id']);
      const legacyMsg = worker.posted.find((m) => m.type === 'resolveLegacyIds');
      expect(legacyMsg).toBeDefined();
      worker.emitMessage({
        type: 'legacyIdsResult',
        requestId: legacyMsg!.requestId,
        entries: [['staple:egg-whole', egg]],
      });
      const legacyMap = await legacyPromise;
      expect(legacyMap.get('staple:egg-whole')).toEqual(egg);
      expect(legacyMap.has('unknown:id')).toBe(false);
    });
  });

  describe('default singleton exports', () => {
    it('exposes initClientCatalog, getCatalogSyncState, subscribeCatalogSync, searchClientCatalog, lookupClientCatalogBarcode, resolveClientLegacyIds', async () => {
      expect(getCatalogSyncState().status).toBe('idle');

      const seen: CatalogSyncState[] = [];
      const unsub = subscribeCatalogSync((s) => seen.push(s));

      // In jsdom, navigator.storage.getDirectory is undefined -> cleanly enters fallback
      initClientCatalog();
      await Promise.resolve();
      expect(getCatalogSyncState().status).toBe('fallback');
      expect(seen.some((s) => s.status === 'fallback')).toBe(true);

      const egg = makeFood();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ items: [egg], source: 'catalog' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await searchClientCatalog('egg');
      expect(res.source).toBe('server');
      expect(res.items).toEqual([egg]);

      const legacy = await resolveClientLegacyIds(['staple:egg-whole']);
      expect(legacy.size).toBe(0);

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'hit', item: egg }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      expect(await lookupClientCatalogBarcode('049000042566')).toEqual(egg);

      unsub();
    });
  });
});
