import { createClient, type Client, type InStatement } from '@libsql/client';
import {
  CentralTablesSyncSchema,
  CustomRecipeSchema,
  FoodItemSchema,
  FoodLogEntrySchema,
  PinnedFoodSchema,
  SyncTombstoneSchema,
  UserGoalsSchema,
  WeightLogEntrySchema,
} from './backup';
import type {
  CustomRecipe,
  FoodItem,
  FoodLogEntry,
  PinnedFood,
  SyncTableName,
  SyncTombstone,
  UserGoals,
  WeightLogEntry,
} from '@/types/nutrition';

export type CentralTableName = SyncTableName;
export type ServerDbMode = 'turso-cloud' | 'local-sqlite' | 'vercel-ephemeral';

export const TOMBSTONE_RETENTION_MS = 90 * 86_400_000;

export interface ServerDbStatus {
  configured: boolean;
  mode: ServerDbMode;
  label: string;
}

export interface ShortcutSyncStatus {
  connected: boolean;
  lastSyncedAt: string | null;
}

const SHORTCUT_SYNC_METADATA_KEY = 'shortcut_last_sync_at';

export interface CentralTablesPayload {
  foodLogs: FoodLogEntry[];
  foodsCache: FoodItem[];
  customRecipes: CustomRecipe[];
  userGoals: UserGoals[];
  weightLogs: WeightLogEntry[];
  pinnedFoods: PinnedFood[];
  tombstones: SyncTombstone[];
}

export interface CentralTableCounts {
  foodLogs: number;
  foodsCache: number;
  customRecipes: number;
  userGoals: number;
  weightLogs: number;
  pinnedFoods: number;
  tombstones?: number;
}

export interface AllCentralTablesResult {
  tables: CentralTablesPayload;
  counts: CentralTableCounts;
}

export interface TableMutationInput {
  table: CentralTableName;
  op: 'put' | 'delete' | 'clear';
  values?: unknown[];
  keys?: string[];
  deletedAt?: number;
}

const SQL_TABLE_MAP: Record<CentralTableName, string> = {
  foodLogs: 'food_logs',
  foodsCache: 'foods_cache',
  customRecipes: 'custom_recipes',
  userGoals: 'user_goals',
  weightLogs: 'weight_logs',
  pinnedFoods: 'pinned_foods',
};

const DATA_TABLE_NAMES: CentralTableName[] = [
  'foodLogs',
  'foodsCache',
  'customRecipes',
  'userGoals',
  'weightLogs',
  'pinnedFoods',
];

let cachedClient: Client | null = null;
let cachedConfigKey: string | null = null;
let schemaReadyPromise: Promise<void> | null = null;

function resolveConnectionConfig(): {
  url: string;
  authToken?: string;
  status: ServerDbStatus;
} {
  const rawUrl =
    process.env.TURSO_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  const authToken =
    process.env.TURSO_AUTH_TOKEN?.trim() || process.env.DATABASE_AUTH_TOKEN?.trim();

  if (rawUrl) {
    const isLocal = rawUrl.startsWith('file:') || rawUrl === ':memory:';
    return {
      url: rawUrl,
      authToken: authToken || undefined,
      status: isLocal
        ? {
            configured: true,
            mode: 'local-sqlite',
            label: 'Local SQLite',
          }
        : {
            configured: true,
            mode: 'turso-cloud',
            label: 'Turso Cloud (libSQL)',
          },
    };
  }

  if (process.env.NODE_ENV === 'test') {
    return {
      url: ':memory:',
      status: {
        configured: true,
        mode: 'local-sqlite',
        label: 'Local SQLite (Test Memory)',
      },
    };
  }

  if (process.env.VERCEL === '1') {
    return {
      url: 'file:/tmp/opencalory.db',
      status: {
        configured: false,
        mode: 'vercel-ephemeral',
        label: 'Ephemeral (/tmp) — Set TURSO_DATABASE_URL',
      },
    };
  }

  return {
    url: 'file:./opencalory.db',
    status: {
      configured: true,
      mode: 'local-sqlite',
      label: 'Local SQLite (opencalory.db)',
    },
  };
}

export function getLibsqlClient(): Client {
  const config = resolveConnectionConfig();
  const configKey = `${config.url}|${config.authToken ?? ''}`;

  if (!cachedClient || cachedConfigKey !== configKey) {
    if (cachedClient) {
      cachedClient.close();
    }
    cachedClient = createClient({
      url: config.url,
      authToken: config.authToken,
    });
    cachedConfigKey = configKey;
    schemaReadyPromise = null;
  }

  return cachedClient;
}

export function resetServerDbForTests(): void {
  if (cachedClient) {
    cachedClient.close();
  }
  cachedClient = null;
  cachedConfigKey = null;
  schemaReadyPromise = null;
}

export function getServerDbStatus(): ServerDbStatus {
  return resolveConnectionConfig().status;
}

export async function ensureServerSchema(): Promise<void> {
  const client = getLibsqlClient();
  if (!schemaReadyPromise) {
    schemaReadyPromise = client
      .executeMultiple(`
        CREATE TABLE IF NOT EXISTS food_logs (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          meal_slot TEXT NOT NULL,
          food_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_food_logs_date ON food_logs(date);

        CREATE TABLE IF NOT EXISTS foods_cache (
          id TEXT PRIMARY KEY,
          barcode TEXT,
          source TEXT NOT NULL,
          name TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_foods_cache_barcode ON foods_cache(barcode);

        CREATE TABLE IF NOT EXISTS custom_recipes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          data TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_goals (
          id TEXT PRIMARY KEY,
          updated_at INTEGER NOT NULL,
          data TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS weight_logs (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_weight_logs_date_recorded ON weight_logs(date DESC, recorded_at DESC, created_at DESC);

        CREATE TABLE IF NOT EXISTS pinned_foods (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          ref_id TEXT NOT NULL,
          pinned_at INTEGER NOT NULL,
          data TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tombstones (
          id TEXT PRIMARY KEY,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          deleted_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tombstones_table_record ON tombstones(table_name, record_id);
        CREATE INDEX IF NOT EXISTS idx_tombstones_deleted_at ON tombstones(deleted_at);

        CREATE TABLE IF NOT EXISTS server_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
      .catch((err) => {
        schemaReadyPromise = null;
        throw err;
      });
  }
  await schemaReadyPromise;
}

function getRecordTimestamp(item: {
  updatedAt?: number;
  createdAt?: number;
  pinnedAt?: number;
}): number {
  return Math.max(item.updatedAt ?? 0, item.createdAt ?? 0, item.pinnedAt ?? 0);
}

function buildPreparedPut(
  table: CentralTableName,
  rawItem: unknown
): { id: string; stmt: InStatement } {
  switch (table) {
    case 'foodLogs': {
      const item = FoodLogEntrySchema.parse(rawItem);
      return {
        id: item.id,
        stmt: {
          sql: `INSERT OR REPLACE INTO food_logs (id, date, meal_slot, food_id, created_at, data)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            item.id,
            item.date,
            item.mealSlot ?? 'log',
            item.foodId,
            item.createdAt,
            JSON.stringify(item),
          ],
        },
      };
    }
    case 'foodsCache': {
      const item = FoodItemSchema.parse(rawItem);
      return {
        id: item.id,
        stmt: {
          sql: `INSERT OR REPLACE INTO foods_cache (id, barcode, source, name, updated_at, data)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            item.id,
            item.barcode ?? null,
            item.source,
            item.name,
            item.updatedAt,
            JSON.stringify(item),
          ],
        },
      };
    }
    case 'customRecipes': {
      const item = CustomRecipeSchema.parse(rawItem);
      return {
        id: item.id,
        stmt: {
          sql: `INSERT OR REPLACE INTO custom_recipes (id, name, created_at, data)
                VALUES (?, ?, ?, ?)`,
          args: [item.id, item.name, item.createdAt, JSON.stringify(item)],
        },
      };
    }
    case 'userGoals': {
      const item = UserGoalsSchema.parse(rawItem);
      return {
        id: item.id,
        stmt: {
          sql: `INSERT OR REPLACE INTO user_goals (id, updated_at, data)
                VALUES (?, ?, ?)`,
          args: [item.id, item.updatedAt, JSON.stringify(item)],
        },
      };
    }
    case 'weightLogs': {
      const item = WeightLogEntrySchema.parse(rawItem);
      return {
        id: item.id,
        stmt: {
          sql: `INSERT OR REPLACE INTO weight_logs (id, date, recorded_at, created_at, updated_at, data)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            item.id,
            item.date,
            item.recordedAt,
            item.createdAt,
            item.updatedAt,
            JSON.stringify(item),
          ],
        },
      };
    }
    case 'pinnedFoods': {
      const item = PinnedFoodSchema.parse(rawItem);
      return {
        id: item.id,
        stmt: {
          sql: `INSERT OR REPLACE INTO pinned_foods (id, kind, ref_id, pinned_at, data)
                VALUES (?, ?, ?, ?, ?)`,
          args: [item.id, item.kind, item.refId, item.pinnedAt, JSON.stringify(item)],
        },
      };
    }
  }
}

function buildTombstoneUpsertStatement(tombstone: SyncTombstone): InStatement {
  const normalizedId = `${tombstone.tableName}:${tombstone.recordId}`;
  return {
    sql: `INSERT INTO tombstones (id, table_name, record_id, deleted_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            deleted_at = MAX(tombstones.deleted_at, excluded.deleted_at)`,
    args: [normalizedId, tombstone.tableName, tombstone.recordId, tombstone.deletedAt],
  };
}

function parseJsonRows<T>(
  rows: Array<Record<string, unknown>>,
  schema: { parse: (v: unknown) => T }
): T[] {
  const results: T[] = [];
  for (const row of rows) {
    const rawData = row.data;
    if (typeof rawData !== 'string') continue;
    const parsedJson = JSON.parse(rawData);
    results.push(schema.parse(parsedJson));
  }
  return results;
}

export async function getAllCentralTables(): Promise<AllCentralTablesResult> {
  await ensureServerSchema();
  const client = getLibsqlClient();
  const cutoff = Date.now() - TOMBSTONE_RETENTION_MS;

  const [
    foodLogsRes,
    foodsCacheRes,
    customRecipesRes,
    userGoalsRes,
    weightLogsRes,
    pinnedFoodsRes,
    tombstonesRes,
  ] = await Promise.all([
    client.execute('SELECT data FROM food_logs ORDER BY created_at ASC'),
    client.execute('SELECT data FROM foods_cache ORDER BY updated_at DESC'),
    client.execute('SELECT data FROM custom_recipes ORDER BY created_at ASC'),
    client.execute('SELECT data FROM user_goals ORDER BY updated_at DESC'),
    client.execute(
      'SELECT data FROM weight_logs ORDER BY date DESC, recorded_at DESC, created_at DESC'
    ),
    client.execute('SELECT data FROM pinned_foods ORDER BY pinned_at DESC'),
    client.execute({
      sql: 'SELECT id, table_name, record_id, deleted_at FROM tombstones WHERE deleted_at >= ? ORDER BY deleted_at DESC',
      args: [cutoff],
    }),
  ]);

  const foodLogs = parseJsonRows(
    foodLogsRes.rows as Array<Record<string, unknown>>,
    FoodLogEntrySchema
  ) as FoodLogEntry[];
  const foodsCache = parseJsonRows(
    foodsCacheRes.rows as Array<Record<string, unknown>>,
    FoodItemSchema
  ) as FoodItem[];
  const customRecipes = parseJsonRows(
    customRecipesRes.rows as Array<Record<string, unknown>>,
    CustomRecipeSchema
  ) as CustomRecipe[];
  const userGoals = parseJsonRows(
    userGoalsRes.rows as Array<Record<string, unknown>>,
    UserGoalsSchema
  ) as UserGoals[];
  const weightLogs = parseJsonRows(
    weightLogsRes.rows as Array<Record<string, unknown>>,
    WeightLogEntrySchema
  ) as WeightLogEntry[];
  const pinnedFoods = parseJsonRows(
    pinnedFoodsRes.rows as Array<Record<string, unknown>>,
    PinnedFoodSchema
  ) as PinnedFood[];

  const tombstones: SyncTombstone[] = [];
  for (const row of tombstonesRes.rows as Array<Record<string, unknown>>) {
    if (
      typeof row.id === 'string' &&
      typeof row.table_name === 'string' &&
      typeof row.record_id === 'string'
    ) {
      tombstones.push(
        SyncTombstoneSchema.parse({
          id: row.id,
          tableName: row.table_name,
          recordId: row.record_id,
          deletedAt: Number(row.deleted_at),
        })
      );
    }
  }

  return {
    tables: {
      foodLogs,
      foodsCache,
      customRecipes,
      userGoals,
      weightLogs,
      pinnedFoods,
      tombstones,
    },
    counts: {
      foodLogs: foodLogs.length,
      foodsCache: foodsCache.length,
      customRecipes: customRecipes.length,
      userGoals: userGoals.length,
      weightLogs: weightLogs.length,
      pinnedFoods: pinnedFoods.length,
      tombstones: tombstones.length,
    },
  };
}

export async function getLatestWeightLog(
  date?: string
): Promise<WeightLogEntry | null> {
  await ensureServerSchema();
  const client = getLibsqlClient();
  const res = date
    ? await client.execute({
        sql: 'SELECT data FROM weight_logs WHERE date = ? ORDER BY recorded_at DESC, created_at DESC LIMIT 1',
        args: [date],
      })
    : await client.execute(
        'SELECT data FROM weight_logs ORDER BY date DESC, recorded_at DESC, created_at DESC LIMIT 1'
      );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (!row || typeof row.data !== 'string') {
    return null;
  }
  return WeightLogEntrySchema.parse(JSON.parse(row.data));
}

export async function recordShortcutSyncTimestamp(
  isoTimestamp: string = new Date().toISOString()
): Promise<void> {
  await ensureServerSchema();
  const client = getLibsqlClient();
  await client.execute({
    sql: `INSERT INTO server_metadata (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at`,
    args: [SHORTCUT_SYNC_METADATA_KEY, isoTimestamp, Date.now()],
  });
}

export async function getShortcutSyncStatus(): Promise<ShortcutSyncStatus> {
  await ensureServerSchema();
  const client = getLibsqlClient();
  const res = await client.execute({
    sql: 'SELECT value FROM server_metadata WHERE key = ? LIMIT 1',
    args: [SHORTCUT_SYNC_METADATA_KEY],
  });
  const row = res.rows[0] as Record<string, unknown> | undefined;
  const lastSyncedAt =
    row && typeof row.value === 'string' && row.value.trim().length > 0
      ? row.value.trim()
      : null;
  return {
    connected: lastSyncedAt !== null,
    lastSyncedAt,
  };
}

export async function applyTableMutation(
  input: TableMutationInput
): Promise<void> {
  await ensureServerSchema();
  const client = getLibsqlClient();
  const sqlTable = SQL_TABLE_MAP[input.table];

  if (!sqlTable) {
    throw new Error(`Unsupported table: ${String(input.table)}`);
  }

  if (input.op === 'clear') {
    await client.batch(
      [
        `DELETE FROM ${sqlTable}`,
        {
          sql: 'DELETE FROM tombstones WHERE table_name = ?',
          args: [input.table],
        },
      ],
      'write'
    );
    return;
  }

  if (input.op === 'delete') {
    const keys = (input.keys ?? []).filter(
      (k) => typeof k === 'string' && k.length > 0
    );
    if (keys.length === 0) return;

    const deletedAt =
      typeof input.deletedAt === 'number' && Number.isFinite(input.deletedAt)
        ? input.deletedAt
        : Date.now();

    const stmts: InStatement[] = [];
    for (const key of keys) {
      stmts.push({
        sql: `DELETE FROM ${sqlTable} WHERE id = ?`,
        args: [key],
      });
      stmts.push(
        buildTombstoneUpsertStatement({
          id: `${input.table}:${key}`,
          tableName: input.table,
          recordId: key,
          deletedAt,
        })
      );
    }
    await client.batch(stmts, 'write');
    return;
  }

  if (input.op === 'put') {
    const values = input.values ?? [];
    if (values.length === 0) return;

    const stmts: InStatement[] = [];

    if (input.table === 'userGoals') {
      const existingRes = await client.execute(
        'SELECT id, updated_at FROM user_goals'
      );
      const existingMap = new Map<string, number>();
      for (const row of existingRes.rows as Array<Record<string, unknown>>) {
        if (typeof row.id === 'string') {
          existingMap.set(row.id, Number(row.updated_at ?? 0));
        }
      }

      for (const rawItem of values) {
        const parsedGoal = UserGoalsSchema.parse(rawItem);
        const existingUpdatedAt = existingMap.get(parsedGoal.id);
        if (
          existingUpdatedAt !== undefined &&
          existingUpdatedAt > parsedGoal.updatedAt &&
          parsedGoal.updatedAt === 0
        ) {
          continue;
        }
        const prepared = buildPreparedPut('userGoals', parsedGoal);
        stmts.push(prepared.stmt);
        stmts.push({
          sql: 'DELETE FROM tombstones WHERE id = ?',
          args: [`userGoals:${prepared.id}`],
        });
      }
    } else {
      for (const rawItem of values) {
        const prepared = buildPreparedPut(input.table, rawItem);
        stmts.push(prepared.stmt);
        stmts.push({
          sql: 'DELETE FROM tombstones WHERE id = ?',
          args: [`${input.table}:${prepared.id}`],
        });
      }
    }

    if (stmts.length > 0) {
      await client.batch(stmts, 'write');
    }
    return;
  }

  throw new Error(`Unsupported operation: ${String(input.op)}`);
}

export async function syncCentralTables(
  incomingTables: unknown,
  mode: 'merge' | 'replace'
): Promise<AllCentralTablesResult> {
  await ensureServerSchema();
  const client = getLibsqlClient();
  const tables = CentralTablesSyncSchema.parse(incomingTables ?? {});
  const cutoff = Date.now() - TOMBSTONE_RETENTION_MS;

  const stmts: InStatement[] = [];

  if (mode === 'replace') {
    stmts.push(
      'DELETE FROM food_logs',
      'DELETE FROM foods_cache',
      'DELETE FROM custom_recipes',
      'DELETE FROM user_goals',
      'DELETE FROM weight_logs',
      'DELETE FROM pinned_foods',
      'DELETE FROM tombstones'
    );

    for (const tableName of DATA_TABLE_NAMES) {
      for (const item of tables[tableName]) {
        stmts.push(buildPreparedPut(tableName, item).stmt);
      }
    }

    const activeTombstones = new Map<string, SyncTombstone>();
    for (const tomb of tables.tombstones) {
      if (tomb.deletedAt < cutoff) continue;
      const key = `${tomb.tableName}:${tomb.recordId}`;
      const prev = activeTombstones.get(key);
      if (!prev || tomb.deletedAt > prev.deletedAt) {
        activeTombstones.set(key, { ...tomb, id: key });
      }
    }
    for (const tomb of activeTombstones.values()) {
      stmts.push(buildTombstoneUpsertStatement(tomb));
    }
  } else {
    const existing = await getAllCentralTables();
    const mergedTombstones = new Map<string, SyncTombstone>();

    for (const tomb of existing.tables.tombstones) {
      if (tomb.deletedAt < cutoff) continue;
      const key = `${tomb.tableName}:${tomb.recordId}`;
      const prev = mergedTombstones.get(key);
      if (!prev || tomb.deletedAt > prev.deletedAt) {
        mergedTombstones.set(key, { ...tomb, id: key });
      }
    }
    for (const tomb of tables.tombstones) {
      if (tomb.deletedAt < cutoff) continue;
      const key = `${tomb.tableName}:${tomb.recordId}`;
      const prev = mergedTombstones.get(key);
      if (!prev || tomb.deletedAt > prev.deletedAt) {
        mergedTombstones.set(key, { ...tomb, id: key });
      }
    }

    const survivingUpdatedAt: Record<
      'userGoals' | 'weightLogs' | 'foodsCache',
      Map<string, number>
    > = {
      userGoals: new Map(),
      weightLogs: new Map(),
      foodsCache: new Map(),
    };

    for (const tableName of DATA_TABLE_NAMES) {
      const sqlTable = SQL_TABLE_MAP[tableName];
      for (const existingRow of existing.tables[tableName]) {
        const key = `${tableName}:${existingRow.id}`;
        const tomb = mergedTombstones.get(key);
        const rowTs = getRecordTimestamp(existingRow);

        if (tomb && rowTs < tomb.deletedAt) {
          stmts.push({
            sql: `DELETE FROM ${sqlTable} WHERE id = ?`,
            args: [existingRow.id],
          });
          continue;
        }

        if (tomb && rowTs >= tomb.deletedAt) {
          mergedTombstones.delete(key);
        }

        if (
          tableName === 'userGoals' ||
          tableName === 'weightLogs' ||
          tableName === 'foodsCache'
        ) {
          survivingUpdatedAt[tableName].set(
            existingRow.id,
            (existingRow as { updatedAt: number }).updatedAt
          );
        }
      }
    }

    for (const tableName of DATA_TABLE_NAMES) {
      for (const incomingRow of tables[tableName]) {
        const key = `${tableName}:${incomingRow.id}`;
        const tomb = mergedTombstones.get(key);
        const rowTs = getRecordTimestamp(incomingRow);

        if (tomb && rowTs < tomb.deletedAt) {
          continue;
        }
        if (tomb && rowTs >= tomb.deletedAt) {
          mergedTombstones.delete(key);
        }

        if (tableName === 'userGoals') {
          const existingTs = survivingUpdatedAt.userGoals.get(incomingRow.id);
          const incomingTs = (incomingRow as UserGoals).updatedAt;
          if (existingTs !== undefined && incomingTs <= existingTs) {
            continue;
          }
          survivingUpdatedAt.userGoals.set(incomingRow.id, incomingTs);
        } else if (tableName === 'weightLogs' || tableName === 'foodsCache') {
          const existingTs = survivingUpdatedAt[tableName].get(incomingRow.id);
          const incomingTs = (incomingRow as { updatedAt: number }).updatedAt;
          if (existingTs !== undefined && incomingTs < existingTs) {
            continue;
          }
          survivingUpdatedAt[tableName].set(incomingRow.id, incomingTs);
        }

        stmts.push(buildPreparedPut(tableName, incomingRow).stmt);
      }
    }

    stmts.push('DELETE FROM tombstones');
    for (const tomb of mergedTombstones.values()) {
      stmts.push(buildTombstoneUpsertStatement(tomb));
    }
  }

  if (stmts.length > 0) {
    await client.batch(stmts, 'write');
  }

  return getAllCentralTables();
}
