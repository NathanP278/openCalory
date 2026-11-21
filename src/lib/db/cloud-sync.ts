import Dexie, {
  type DBCore,
  type DBCoreMutateRequest,
  type DBCoreMutateResponse,
  type DBCoreTable,
  type Middleware,
} from 'dexie';
import type { OpenCaloryDB } from './opencalory-db';
import type {
  CustomRecipe,
  FoodItem,
  FoodLogEntry,
  PinnedFood,
  SyncTombstone,
  UserGoals,
  WeightLogEntry,
} from '@/types/nutrition';
import type {
  CentralTableCounts,
  CentralTableName,
  ServerDbMode,
} from './server-db';
import { useLoggerStore } from '@/stores/logger-store';

export class SyncAuthError extends Error {
  constructor(message = 'Sync authentication required') {
    super(message);
    this.name = 'SyncAuthError';
  }
}

const SYNC_TABLES = new Set<CentralTableName>([
  'foodLogs',
  'foodsCache',
  'customRecipes',
  'userGoals',
  'weightLogs',
  'pinnedFoods',
]);

const MIGRATED_KEY = 'opencalory_central_migrated_v1';
const DIRTY_SYNC_KEY = 'opencalory_dirty_sync';
export const PENDING_REPLACE_SYNC_KEY = 'opencalory_pending_replace_sync';

let forceEnableInTests = false;
let isHydratingFromServer = false;
let tombstoneQueue: Promise<void> = Promise.resolve();
let mutationQueue: Promise<void> = Promise.resolve();
let inFlightSync: Promise<CentralSyncResult> | null = null;

export interface CentralSyncResult {
  ok: boolean;
  configured: boolean;
  mode: ServerDbMode;
  label: string;
  counts: CentralTableCounts;
  syncedAt: number;
}

interface SyncApiResponse {
  ok: boolean;
  configured?: boolean;
  mode?: ServerDbMode;
  label?: string;
  tables?: {
    foodLogs?: FoodLogEntry[];
    foodsCache?: FoodItem[];
    customRecipes?: CustomRecipe[];
    userGoals?: UserGoals[];
    weightLogs?: WeightLogEntry[];
    pinnedFoods?: PinnedFood[];
    tombstones?: SyncTombstone[];
  };
  counts?: CentralTableCounts;
  error?: string;
}

function safeGetLocalStorage(key: string): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetLocalStorage(key: string, value: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors (private mode / quota)
  }
}

function safeRemoveLocalStorage(key: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

function enqueueTombstoneWork(work: () => Promise<void>): Promise<void> {
  const run = async () => {
    try {
      await Dexie.ignoreTransaction(work);
    } catch {
      // Ignore errors if DB was closed/deleted during test teardown
    }
  };
  const next = tombstoneQueue.then(run, run);
  tombstoneQueue = next;
  return next;
}

export function setCloudSyncEnabledForTests(enabled: boolean): void {
  forceEnableInTests = enabled;
}

export function isCloudSyncEnabled(): boolean {
  return (
    forceEnableInTests ||
    (typeof window !== 'undefined' && process.env.NODE_ENV !== 'test')
  );
}

export function isHydratingCentralDb(): boolean {
  return isHydratingFromServer;
}

export function pushMutationToCentralDb(payload: {
  table: CentralTableName;
  op: 'put' | 'delete' | 'clear';
  values?: unknown[];
  keys?: string[];
  deletedAt?: number;
}): Promise<void> {
  const run = async () => {
    try {
      const res = await fetch('/api/db/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mutate',
          ...payload,
        }),
      });
      if (res.status === 401) {
        safeSetLocalStorage(DIRTY_SYNC_KEY, '1');
        useLoggerStore.getState().setSyncAuthLocked(true);
        return;
      }
      if (!res.ok) {
        safeSetLocalStorage(DIRTY_SYNC_KEY, '1');
        return;
      }
      if (useLoggerStore.getState().syncAuthLocked) {
        useLoggerStore.getState().setSyncAuthLocked(false);
      }
    } catch {
      safeSetLocalStorage(DIRTY_SYNC_KEY, '1');
    }
  };

  const next = mutationQueue.then(run, run);
  mutationQueue = next;
  return next;
}

export async function flushPendingMutationsForTests(): Promise<void> {
  await tombstoneQueue;
  await mutationQueue;
  await tombstoneQueue;
  await mutationQueue;
}

export function createCentralSyncMiddleware(
  getDb: () => OpenCaloryDB
): Middleware<DBCore> {
  return {
    stack: 'dbcore',
    name: 'CentralSyncMiddleware',
    create(downlevelCore: DBCore): Partial<DBCore> {
      return {
        table(tableName: string): DBCoreTable {
          const downlevelTable = downlevelCore.table(tableName);

          if (!SYNC_TABLES.has(tableName as CentralTableName)) {
            return downlevelTable;
          }

          const typedTableName = tableName as CentralTableName;

          return {
            ...downlevelTable,
            async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
              const res = await downlevelTable.mutate(req);

              if (!isCloudSyncEnabled() || isHydratingFromServer) {
                return res;
              }

              if (req.type === 'add' || req.type === 'put') {
                const values = Array.isArray(req.values)
                  ? req.values.filter((_, idx) => !res.failures?.[idx])
                  : [];

                if (values.length > 0 && Array.isArray(req.values)) {
                  const tombstoneIds: string[] = [];
                  for (let idx = 0; idx < req.values.length; idx++) {
                    if (res.failures?.[idx]) continue;
                    const rawVal = req.values[idx] as { id?: unknown } | undefined;
                    const recordId =
                      rawVal && typeof rawVal.id === 'string' && rawVal.id.length > 0
                        ? rawVal.id
                        : res.results?.[idx] !== undefined
                          ? String(res.results[idx])
                          : null;
                    if (recordId) {
                      tombstoneIds.push(`${typedTableName}:${recordId}`);
                    }
                  }

                  if (tombstoneIds.length > 0) {
                    void enqueueTombstoneWork(async () => {
                      await getDb().tombstones.bulkDelete(tombstoneIds);
                    });
                  }

                  void pushMutationToCentralDb({
                    table: typedTableName,
                    op: 'put',
                    values,
                  });
                } else if (
                  req.type === 'put' &&
                  req.updates?.keys &&
                  req.updates.keys.length > 0
                ) {
                  const updateKeys = [...req.updates.keys];
                  const tombstoneIds = updateKeys.map(
                    (k) => `${typedTableName}:${String(k)}`
                  );
                  void enqueueTombstoneWork(async () => {
                    await getDb().tombstones.bulkDelete(tombstoneIds);
                  });

                  void Promise.resolve().then(async () => {
                    try {
                      const updatedRows = await Dexie.ignoreTransaction(() =>
                        getDb().table(typedTableName).bulkGet(updateKeys)
                      );
                      const validRows = updatedRows.filter(Boolean);
                      if (validRows.length > 0) {
                        await pushMutationToCentralDb({
                          table: typedTableName,
                          op: 'put',
                          values: validRows,
                        });
                      }
                    } catch {
                      safeSetLocalStorage(DIRTY_SYNC_KEY, '1');
                    }
                  });
                }
              } else if (req.type === 'delete') {
                const keys = (req.keys ?? [])
                  .filter((_, idx) => !res.failures?.[idx])
                  .map((k) => String(k))
                  .filter((k) => k.length > 0);
                if (keys.length > 0) {
                  const deletedAt = Date.now();
                  const tombstones: SyncTombstone[] = keys.map((recordId) => ({
                    id: `${typedTableName}:${recordId}`,
                    tableName: typedTableName,
                    recordId,
                    deletedAt,
                  }));
                  void enqueueTombstoneWork(async () => {
                    await getDb().tombstones.bulkPut(tombstones);
                  });
                  void pushMutationToCentralDb({
                    table: typedTableName,
                    op: 'delete',
                    keys,
                    deletedAt,
                  });
                }
              } else if (req.type === 'deleteRange') {
                void enqueueTombstoneWork(async () => {
                  await getDb()
                    .tombstones.where('tableName')
                    .equals(typedTableName)
                    .delete();
                });
                void pushMutationToCentralDb({
                  table: typedTableName,
                  op: 'clear',
                });
              }

              return res;
            },
          };
        },
      };
    },
  };
}

async function runSyncWithCentralDb(
  dbInstance: OpenCaloryDB,
  options?: { forcePushMode?: 'merge' | 'replace' }
): Promise<CentralSyncResult> {
  if (options?.forcePushMode === 'replace') {
    safeSetLocalStorage(PENDING_REPLACE_SYNC_KEY, '1');
  }

  await tombstoneQueue;
  await mutationQueue;

  const hasPendingReplace =
    safeGetLocalStorage(PENDING_REPLACE_SYNC_KEY) === '1';
  const effectivePushMode: 'merge' | 'replace' =
    options?.forcePushMode === 'replace' || hasPendingReplace
      ? 'replace'
      : 'merge';

  const needsPush =
    Boolean(options?.forcePushMode) ||
    hasPendingReplace ||
    safeGetLocalStorage(MIGRATED_KEY) !== '1' ||
    safeGetLocalStorage(DIRTY_SYNC_KEY) === '1';

  let data: SyncApiResponse;

  if (needsPush) {
    const [
      foodLogs,
      foodsCache,
      customRecipes,
      userGoals,
      weightLogs,
      pinnedFoods,
      tombstones,
    ] = await Promise.all([
      dbInstance.foodLogs.toArray(),
      dbInstance.foodsCache.toArray(),
      dbInstance.customRecipes.toArray(),
      dbInstance.userGoals.toArray(),
      dbInstance.weightLogs.toArray(),
      dbInstance.pinnedFoods.toArray(),
      dbInstance.tombstones.toArray(),
    ]);

    const res = await fetch('/api/db/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sync',
        mode: effectivePushMode,
        tables: {
          foodLogs,
          foodsCache,
          customRecipes,
          userGoals,
          weightLogs,
          pinnedFoods,
          tombstones,
        },
      }),
    });

    if (res.status === 401) {
      safeSetLocalStorage(DIRTY_SYNC_KEY, '1');
      useLoggerStore.getState().setSyncAuthLocked(true);
      throw new SyncAuthError('Sync authentication required');
    }

    if (!res.ok) {
      safeSetLocalStorage(DIRTY_SYNC_KEY, '1');
      throw new Error(`Central DB sync failed (${res.status})`);
    }

    data = (await res.json()) as SyncApiResponse;
    if (!data.ok) {
      safeSetLocalStorage(DIRTY_SYNC_KEY, '1');
      throw new Error(data.error || 'Central DB sync returned an error');
    }

    safeSetLocalStorage(MIGRATED_KEY, '1');
    safeRemoveLocalStorage(DIRTY_SYNC_KEY);
    if (effectivePushMode === 'replace') {
      safeRemoveLocalStorage(PENDING_REPLACE_SYNC_KEY);
    }
  } else {
    const res = await fetch('/api/db/sync', {
      method: 'GET',
      headers: { 'Cache-Control': 'no-cache' },
    });

    if (res.status === 401) {
      useLoggerStore.getState().setSyncAuthLocked(true);
      throw new SyncAuthError('Sync authentication required');
    }

    if (!res.ok) {
      throw new Error(`Central DB fetch failed (${res.status})`);
    }

    data = (await res.json()) as SyncApiResponse;
    if (!data.ok) {
      throw new Error(data.error || 'Central DB fetch returned an error');
    }
  }

  if (useLoggerStore.getState().syncAuthLocked) {
    useLoggerStore.getState().setSyncAuthLocked(false);
  }

  const incoming = data.tables ?? {};
  const foodLogs = incoming.foodLogs ?? [];
  const foodsCache = incoming.foodsCache ?? [];
  const customRecipes = incoming.customRecipes ?? [];
  const userGoals = incoming.userGoals ?? [];
  const weightLogs = incoming.weightLogs ?? [];
  const pinnedFoods = incoming.pinnedFoods ?? [];
  const tombstones = incoming.tombstones ?? [];

  isHydratingFromServer = true;
  try {
    await dbInstance.transaction(
      'rw',
      [
        dbInstance.foodLogs,
        dbInstance.foodsCache,
        dbInstance.customRecipes,
        dbInstance.userGoals,
        dbInstance.weightLogs,
        dbInstance.pinnedFoods,
        dbInstance.tombstones,
      ],
      async () => {
        await Promise.all([
          dbInstance.foodLogs.clear(),
          dbInstance.foodsCache.clear(),
          dbInstance.customRecipes.clear(),
          dbInstance.userGoals.clear(),
          dbInstance.weightLogs.clear(),
          dbInstance.pinnedFoods.clear(),
          dbInstance.tombstones.clear(),
        ]);

        if (foodLogs.length > 0) {
          await dbInstance.foodLogs.bulkPut(foodLogs);
        }
        if (foodsCache.length > 0) {
          await dbInstance.foodsCache.bulkPut(foodsCache);
        }
        if (customRecipes.length > 0) {
          await dbInstance.customRecipes.bulkPut(customRecipes);
        }
        if (userGoals.length > 0) {
          await dbInstance.userGoals.bulkPut(userGoals);
        }
        if (weightLogs.length > 0) {
          await dbInstance.weightLogs.bulkPut(weightLogs);
        }
        if (pinnedFoods.length > 0) {
          await dbInstance.pinnedFoods.bulkPut(pinnedFoods);
        }
        if (tombstones.length > 0) {
          await dbInstance.tombstones.bulkPut(tombstones);
        }
      }
    );
  } finally {
    isHydratingFromServer = false;
  }

  return {
    ok: true,
    configured: Boolean(data.configured),
    mode: data.mode ?? 'local-sqlite',
    label: data.label ?? 'Central Database',
    counts: data.counts ?? {
      foodLogs: foodLogs.length,
      foodsCache: foodsCache.length,
      customRecipes: customRecipes.length,
      userGoals: userGoals.length,
      weightLogs: weightLogs.length,
      pinnedFoods: pinnedFoods.length,
      tombstones: tombstones.length,
    },
    syncedAt: Date.now(),
  };
}

export async function syncWithCentralDb(
  dbInstance: OpenCaloryDB,
  options?: { forcePushMode?: 'merge' | 'replace' }
): Promise<CentralSyncResult> {
  if (options?.forcePushMode === 'replace') {
    safeSetLocalStorage(PENDING_REPLACE_SYNC_KEY, '1');
  }

  if (inFlightSync && !options?.forcePushMode) {
    return inFlightSync;
  }

  if (inFlightSync && options?.forcePushMode) {
    await inFlightSync.catch(() => {});
  }

  const promise = runSyncWithCentralDb(dbInstance, options).finally(() => {
    if (inFlightSync === promise) {
      inFlightSync = null;
    }
  });

  inFlightSync = promise;
  return promise;
}
