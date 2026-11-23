import type { FoodItem } from '@/types/nutrition';
import type { CatalogManifest } from '@/lib/foods/catalog-schema';
import { normalizeBarcode } from '@/lib/foods/dedup';
import { sanitizeFtsQuery } from '@/lib/foods/fts-query';
import type {
  CatalogSyncState,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from '@/lib/foods/catalog-worker';

export type { CatalogSyncState };

export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message' | 'error', listener: (ev: never) => void): void;
  removeEventListener(type: 'message' | 'error', listener: (ev: never) => void): void;
  terminate(): void;
}

export interface StorageManagerLike {
  getDirectory?: () => Promise<unknown>;
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
}

export interface OpfsQuotaCheckResult {
  ok: boolean;
  reason?: string;
  availableBytes?: number;
  requiredBytes: number;
}

export interface ClientCatalogDeps {
  fetchImpl?: typeof fetch;
  storage?: StorageManagerLike | null;
  createWorker?: () => WorkerLike;
}

export interface ClientCatalogController {
  init(): void;
  getState(): CatalogSyncState;
  subscribe(cb: (state: CatalogSyncState) => void): () => void;
  search(
    query: string,
    options?: { limit?: number; region?: string; signal?: AbortSignal }
  ): Promise<{ items: FoodItem[]; source: 'opfs' | 'server' }>;
  lookupBarcode(barcode: string): Promise<FoodItem | null>;
  resolveLegacyIds(legacyIds: string[]): Promise<Map<string, FoodItem>>;
  dispose(): void;
}

/**
 * Checks whether OPFS is available and has at least `2 * manifestRawBytes` of free quota
 * (Review Focus #4: prevents Safari private browsing / low-storage crashes or OOM).
 */
export async function checkOpfsQuota(
  manifestRawBytes: number,
  storage?: StorageManagerLike | null
): Promise<OpfsQuotaCheckResult> {
  const requiredBytes = Math.max(0, manifestRawBytes) * 2;
  const resolvedStorage =
    storage !== undefined
      ? storage
      : typeof navigator !== 'undefined'
        ? (navigator.storage as StorageManagerLike | undefined) ?? null
        : null;

  if (!resolvedStorage || typeof resolvedStorage.getDirectory !== 'function') {
    return {
      ok: false,
      reason: 'OPFS (navigator.storage.getDirectory) is unavailable in this browser.',
      requiredBytes,
    };
  }

  if (typeof resolvedStorage.estimate === 'function') {
    try {
      const estimate = await resolvedStorage.estimate();
      const quota = typeof estimate?.quota === 'number' ? estimate.quota : 0;
      const usage = typeof estimate?.usage === 'number' ? estimate.usage : 0;
      const availableBytes = Math.max(0, quota - usage);

      if (quota > 0 && availableBytes < requiredBytes) {
        return {
          ok: false,
          reason: `Insufficient OPFS storage quota (${availableBytes} bytes free, need ${requiredBytes} bytes).`,
          availableBytes,
          requiredBytes,
        };
      }

      return { ok: true, availableBytes, requiredBytes };
    } catch {
      return {
        ok: false,
        reason: 'Unable to estimate OPFS storage quota.',
        requiredBytes,
      };
    }
  }

  return { ok: true, requiredBytes };
}

function createDefaultBrowserWorker(): WorkerLike {
  return new Worker(new URL('./catalog-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

export function createClientCatalogController(
  deps: ClientCatalogDeps = {}
): ClientCatalogController {
  let state: CatalogSyncState = { status: 'idle' };
  const listeners = new Set<(next: CatalogSyncState) => void>();

  let worker: WorkerLike | null = null;
  let initialized = false;
  let disposed = false;
  let nextRequestId = 1;
  let latestSearchRequestId = 0;

  const pendingSearches = new Map<
    number,
    {
      resolve: (res: { items: FoodItem[]; source: 'opfs' | 'server' }) => void;
      query: string;
      options?: { limit?: number; region?: string; signal?: AbortSignal };
      cleanupAbort?: () => void;
    }
  >();

  const pendingBarcodes = new Map<number, (item: FoodItem | null) => void>();
  const pendingLegacyIds = new Map<number, (entries: Map<string, FoodItem>) => void>();

  const getFetch = (): typeof fetch => deps.fetchImpl ?? globalThis.fetch;

  const getStorage = (): StorageManagerLike | null => {
    if (deps.storage !== undefined) return deps.storage;
    if (typeof navigator !== 'undefined' && navigator.storage) {
      return navigator.storage as unknown as StorageManagerLike;
    }
    return null;
  };

  const setState = (next: CatalogSyncState) => {
    if (disposed) return;
    state = next;
    for (const cb of listeners) {
      try {
        cb(state);
      } catch {
        // Isolate subscriber errors
      }
    }
  };

  const searchServerFallback = async (
    query: string,
    options?: { limit?: number; region?: string; signal?: AbortSignal }
  ): Promise<{ items: FoodItem[]; source: 'server' }> => {
    const trimmed = query.trim();
    if (!trimmed) {
      return { items: [], source: 'server' };
    }
    if (options?.signal?.aborted) {
      return { items: [], source: 'server' };
    }

    const params = new URLSearchParams();
    params.set('q', trimmed);
    if (options?.limit != null) {
      params.set('limit', String(options.limit));
    }
    if (options?.region) {
      params.set('region', options.region);
    }

    try {
      const res = await getFetch()(`/api/foods/search?${params.toString()}`, {
        signal: options?.signal,
      });
      if (!res.ok) {
        return { items: [], source: 'server' };
      }
      const data = (await res.json()) as { items?: FoodItem[] };
      return {
        items: Array.isArray(data?.items) ? data.items : [],
        source: 'server',
      };
    } catch {
      return { items: [], source: 'server' };
    }
  };

  const lookupBarcodeServerFallback = async (barcode: string): Promise<FoodItem | null> => {
    const normalized = normalizeBarcode(barcode);
    const rawDigits = barcode.replace(/\D+/g, '');
    const code = normalized ?? (rawDigits.length >= 8 && rawDigits.length <= 14 ? rawDigits : null);
    if (!code) return null;

    try {
      const res = await getFetch()(`/api/foods/barcode/${encodeURIComponent(code)}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { status?: string; item?: FoodItem | null };
      return data?.item ?? null;
    } catch {
      return null;
    }
  };

  const handleWorkerMessage = (event: { data: WorkerResponseMessage }) => {
    if (disposed) return;
    const msg = event?.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'status') {
      setState(msg.state);
      return;
    }

    if (msg.type === 'searchResult') {
      const pending = pendingSearches.get(msg.requestId);
      if (!pending) return;
      pendingSearches.delete(msg.requestId);
      pending.cleanupAbort?.();

      // Monotonic request cancellation: ignore stale search results
      if (msg.requestId < latestSearchRequestId) {
        pending.resolve({ items: [], source: 'opfs' });
        return;
      }
      pending.resolve({ items: Array.isArray(msg.items) ? msg.items : [], source: 'opfs' });
      return;
    }

    if (msg.type === 'barcodeResult') {
      const resolve = pendingBarcodes.get(msg.requestId);
      if (!resolve) return;
      pendingBarcodes.delete(msg.requestId);
      resolve(msg.item ?? null);
      return;
    }

    if (msg.type === 'legacyIdsResult') {
      const resolve = pendingLegacyIds.get(msg.requestId);
      if (!resolve) return;
      pendingLegacyIds.delete(msg.requestId);
      resolve(new Map(Array.isArray(msg.entries) ? msg.entries : []));
      return;
    }

    if (msg.type === 'error' && msg.requestId != null) {
      const pendingSearch = pendingSearches.get(msg.requestId);
      if (pendingSearch) {
        pendingSearches.delete(msg.requestId);
        pendingSearch.cleanupAbort?.();
        void searchServerFallback(pendingSearch.query, pendingSearch.options).then(
          pendingSearch.resolve
        );
        return;
      }
      const resolveBarcode = pendingBarcodes.get(msg.requestId);
      if (resolveBarcode) {
        pendingBarcodes.delete(msg.requestId);
        resolveBarcode(null);
        return;
      }
      const resolveLegacy = pendingLegacyIds.get(msg.requestId);
      if (resolveLegacy) {
        pendingLegacyIds.delete(msg.requestId);
        resolveLegacy(new Map());
      }
    }
  };

  const handleWorkerError = (event: { message?: string }) => {
    if (disposed) return;
    const reason = event?.message || 'Catalog Web Worker encountered an unexpected error.';

    // Gracefully drain any in-flight worker requests
    for (const [id, pending] of pendingSearches.entries()) {
      pendingSearches.delete(id);
      pending.cleanupAbort?.();
      void searchServerFallback(pending.query, pending.options).then(pending.resolve);
    }
    for (const [id, resolve] of pendingBarcodes.entries()) {
      pendingBarcodes.delete(id);
      resolve(null);
    }
    for (const [id, resolve] of pendingLegacyIds.entries()) {
      pendingLegacyIds.delete(id);
      resolve(new Map());
    }

    setState({ status: 'fallback', reason });
  };

  const startWorkerInit = async () => {
    const storage = getStorage();

    // Fetch manifest first so we can verify free quota >= 2 * manifest.rawBytes before spawning Worker
    let manifest: CatalogManifest;
    try {
      const res = await getFetch()('/api/foods/manifest');
      if (!res.ok) {
        setState({
          status: 'fallback',
          reason: `Catalog manifest unavailable (HTTP ${res.status}).`,
        });
        return;
      }
      const parsed = (await res.json()) as Partial<CatalogManifest>;
      if (
        !parsed ||
        typeof parsed.version !== 'string' ||
        typeof parsed.sha256 !== 'string' ||
        typeof parsed.rawBytes !== 'number'
      ) {
        setState({
          status: 'fallback',
          reason: 'Invalid catalog manifest response.',
        });
        return;
      }
      manifest = parsed as CatalogManifest;
    } catch (err) {
      setState({
        status: 'fallback',
        reason: err instanceof Error ? err.message : 'Failed to fetch catalog manifest.',
      });
      return;
    }

    if (disposed) return;

    const quotaCheck = await checkOpfsQuota(manifest.rawBytes, storage);
    if (disposed) return;

    if (!quotaCheck.ok) {
      setState({
        status: 'fallback',
        tier: manifest.tier,
        foodCount: manifest.foodCount,
        version: manifest.version,
        reason: quotaCheck.reason,
      });
      return;
    }

    setState({
      status: 'syncing',
      tier: manifest.tier,
      foodCount: manifest.foodCount,
      version: manifest.version,
      progressPct: 0,
    });

    try {
      const factory = deps.createWorker ?? createDefaultBrowserWorker;
      const w = factory();
      if (disposed) {
        w.terminate();
        return;
      }
      worker = w;
      w.addEventListener('message', handleWorkerMessage as (ev: never) => void);
      w.addEventListener('error', handleWorkerError as (ev: never) => void);
      const initMsg: WorkerRequestMessage = { type: 'init', manifest };
      w.postMessage(initMsg);
    } catch (err) {
      setState({
        status: 'fallback',
        tier: manifest.tier,
        foodCount: manifest.foodCount,
        version: manifest.version,
        reason: err instanceof Error ? err.message : 'Failed to start Catalog Web Worker.',
      });
    }
  };

  return {
    init(): void {
      if (initialized || disposed) return;
      initialized = true;

      const storage = getStorage();
      const canCreateWorker = Boolean(deps.createWorker || typeof Worker !== 'undefined');

      if (!storage || typeof storage.getDirectory !== 'function' || !canCreateWorker) {
        setState({
          status: 'fallback',
          reason: !storage || typeof storage.getDirectory !== 'function'
            ? 'OPFS (navigator.storage.getDirectory) is unavailable in this browser.'
            : 'Web Workers are unavailable in this environment.',
        });
        return;
      }

      void startWorkerInit();
    },

    getState(): CatalogSyncState {
      return state;
    },

    subscribe(cb: (next: CatalogSyncState) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    async search(
      query: string,
      options?: { limit?: number; region?: string; signal?: AbortSignal }
    ): Promise<{ items: FoodItem[]; source: 'opfs' | 'server' }> {
      if (options?.signal?.aborted) {
        return { items: [], source: state.status === 'ready' ? 'opfs' : 'server' };
      }

      if (state.status !== 'ready' || !worker) {
        return searchServerFallback(query, options);
      }

      // Fast-path empty/operator-only queries without unnecessary worker round-trip
      if (!sanitizeFtsQuery(query)) {
        return { items: [], source: 'opfs' };
      }

      const requestId = nextRequestId++;
      latestSearchRequestId = requestId;

      // Cancel all older in-flight search requests so stale responses are ignored
      for (const [oldId, oldPending] of pendingSearches.entries()) {
        if (oldId < requestId) {
          pendingSearches.delete(oldId);
          oldPending.cleanupAbort?.();
          const cancelMsg: WorkerRequestMessage = { type: 'cancel', requestId: oldId };
          worker.postMessage(cancelMsg);
          oldPending.resolve({ items: [], source: 'opfs' });
        }
      }

      return new Promise<{ items: FoodItem[]; source: 'opfs' | 'server' }>((resolve) => {
        const signal = options?.signal;
        let cleanupAbort: (() => void) | undefined;

        if (signal) {
          const onAbort = () => {
            if (pendingSearches.delete(requestId)) {
              worker?.postMessage({ type: 'cancel', requestId } satisfies WorkerRequestMessage);
              resolve({ items: [], source: 'opfs' });
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });
          cleanupAbort = () => signal.removeEventListener('abort', onAbort);
        }

        pendingSearches.set(requestId, { resolve, query, options, cleanupAbort });

        const msg: WorkerRequestMessage = {
          type: 'search',
          requestId,
          query,
          limit: options?.limit,
          region: options?.region,
        };
        worker!.postMessage(msg);
      });
    },

    async lookupBarcode(barcode: string): Promise<FoodItem | null> {
      if (!barcode || typeof barcode !== 'string') return null;

      if (state.status !== 'ready' || !worker) {
        return lookupBarcodeServerFallback(barcode);
      }

      const requestId = nextRequestId++;
      return new Promise<FoodItem | null>((resolve) => {
        pendingBarcodes.set(requestId, resolve);
        const msg: WorkerRequestMessage = {
          type: 'barcode',
          requestId,
          barcode,
        };
        worker!.postMessage(msg);
      });
    },

    async resolveLegacyIds(legacyIds: string[]): Promise<Map<string, FoodItem>> {
      if (!Array.isArray(legacyIds) || legacyIds.length === 0) {
        return new Map();
      }
      const uniqueIds = Array.from(
        new Set(legacyIds.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean))
      );
      if (uniqueIds.length === 0) {
        return new Map();
      }

      if (state.status !== 'ready' || !worker) {
        return new Map();
      }

      const requestId = nextRequestId++;
      return new Promise<Map<string, FoodItem>>((resolve) => {
        pendingLegacyIds.set(requestId, resolve);
        const msg: WorkerRequestMessage = {
          type: 'resolveLegacyIds',
          requestId,
          legacyIds: uniqueIds,
        };
        worker!.postMessage(msg);
      });
    },

    dispose(): void {
      disposed = true;
      for (const [, pending] of pendingSearches.entries()) {
        pending.cleanupAbort?.();
        pending.resolve({ items: [], source: 'opfs' });
      }
      pendingSearches.clear();
      for (const [, resolve] of pendingBarcodes.entries()) {
        resolve(null);
      }
      pendingBarcodes.clear();
      for (const [, resolve] of pendingLegacyIds.entries()) {
        resolve(new Map());
      }
      pendingLegacyIds.clear();

      if (worker) {
        worker.removeEventListener('message', handleWorkerMessage as (ev: never) => void);
        worker.removeEventListener('error', handleWorkerError as (ev: never) => void);
        worker.terminate();
        worker = null;
      }
      listeners.clear();
    },
  };
}

let defaultController: ClientCatalogController = createClientCatalogController();

export function initClientCatalog(): void {
  defaultController.init();
}

export function getCatalogSyncState(): CatalogSyncState {
  return defaultController.getState();
}

export function subscribeCatalogSync(cb: (state: CatalogSyncState) => void): () => void {
  return defaultController.subscribe(cb);
}

export function resetClientCatalogForTests(): void {
  defaultController.dispose();
  defaultController = createClientCatalogController();
}

export async function searchClientCatalog(
  query: string,
  options?: { limit?: number; region?: string; signal?: AbortSignal }
): Promise<{ items: FoodItem[]; source: 'opfs' | 'server' }> {
  return defaultController.search(query, options);
}

export async function lookupClientCatalogBarcode(barcode: string): Promise<FoodItem | null> {
  return defaultController.lookupBarcode(barcode);
}

export async function resolveClientLegacyIds(
  legacyIds: string[]
): Promise<Map<string, FoodItem>> {
  return defaultController.resolveLegacyIds(legacyIds);
}
