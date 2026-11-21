import React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { db } from '../opencalory-db';
import {
  PENDING_REPLACE_SYNC_KEY,
  SyncAuthError,
  flushPendingMutationsForTests,
  setCloudSyncEnabledForTests,
  syncWithCentralDb,
} from '../cloud-sync';
import { importBackupJson } from '../backup';
import {
  applyTableMutation,
  ensureServerSchema,
  getAllCentralTables,
  getLatestWeightLog,
  getServerDbStatus,
  resetServerDbForTests,
  syncCentralTables,
} from '../server-db';
import { GET as syncGetRoute, POST as syncPostRoute } from '@/app/api/db/sync/route';
import {
  GET as syncSessionGet,
  POST as syncSessionPost,
  DELETE as syncSessionDelete,
} from '@/app/api/auth/sync-session/route';
import { POST as mealScanPost } from '@/app/api/ai/meal-scan/route';
import { POST as refinePost } from '@/app/api/ai/refine/route';
import { POST as labelOcrPost } from '@/app/api/ai/label-ocr/route';
import { GET as aiHealthGet } from '@/app/api/ai/health/route';
import { useLoggerStore } from '@/stores/logger-store';
import { CentralDbStatusCard } from '@/components/settings/central-db-status-card';
import { AiHealthStatusCard } from '@/components/settings/ai-health-status-card';
import type { FoodLogEntry, UserGoals, WeightLogEntry } from '@/types/nutrition';

const makeLog = (id: string, name = 'Chicken Breast'): FoodLogEntry => ({
  id,
  date: '2026-11-15',
  mealSlot: 'lunch',
  foodId: 'staple:chicken',
  name,
  source: 'staple',
  amount: 150,
  unit: 'g',
  nutritionSnapshot: {
    calories: 248,
    protein: 46.5,
    carbs: 0,
    fat: 5.4,
    fiber: 0,
    micros: { sodiumMg: 111 },
  },
  createdAt: 1700000000000,
});

const makeGoals = (dailyCalories: number, updatedAt: number): UserGoals => ({
  id: 'active',
  dailyCalories,
  proteinG: 160,
  carbsG: 200,
  fatG: 65,
  fiberG: 30,
  micronutrientTargets: { sodiumMg: 2300 },
  mealSlots: [
    { id: 'breakfast', name: 'Breakfast', weightPct: 25 },
    { id: 'lunch', name: 'Lunch', weightPct: 35 },
    { id: 'dinner', name: 'Dinner', weightPct: 40 },
  ],
  updatedAt,
});

describe('Central Database (Turso / libSQL) & Hybrid Dexie Sync', () => {
  const originalSyncAccessKey = process.env.SYNC_ACCESS_KEY;

  beforeEach(async () => {
    delete process.env.SYNC_ACCESS_KEY;
    useLoggerStore.setState({ syncAuthLocked: false });
    resetServerDbForTests();
    await ensureServerSchema();
    await db.delete();
    await db.open();
    localStorage.clear();
    setCloudSyncEnabledForTests(false);
  });

  afterEach(() => {
    if (originalSyncAccessKey === undefined) {
      delete process.env.SYNC_ACCESS_KEY;
    } else {
      process.env.SYNC_ACCESS_KEY = originalSyncAccessKey;
    }
    useLoggerStore.setState({ syncAuthLocked: false });
    setCloudSyncEnabledForTests(false);
    vi.restoreAllMocks();
    resetServerDbForTests();
  });

  describe('server-db (libSQL)', () => {
    it('initializes schema and reports status cleanly', () => {
      const status = getServerDbStatus();
      expect(status.configured).toBe(true);
      expect(status.mode).toBe('local-sqlite');
    });

    it('supports put, delete, and clear mutations', async () => {
      const log1 = makeLog('log-1', 'Oats');
      const log2 = makeLog('log-2', 'Eggs');

      await applyTableMutation({
        table: 'foodLogs',
        op: 'put',
        values: [log1, log2],
      });

      let state = await getAllCentralTables();
      expect(state.counts.foodLogs).toBe(2);

      await applyTableMutation({
        table: 'foodLogs',
        op: 'delete',
        keys: ['log-1'],
      });

      state = await getAllCentralTables();
      expect(state.counts.foodLogs).toBe(1);
      expect(state.tables.foodLogs[0].id).toBe('log-2');

      await applyTableMutation({
        table: 'foodLogs',
        op: 'clear',
      });

      state = await getAllCentralTables();
      expect(state.counts.foodLogs).toBe(0);
    });

    it('prevents unconfigured seed goals (updatedAt: 0) from overwriting customized goals', async () => {
      await applyTableMutation({
        table: 'userGoals',
        op: 'put',
        values: [makeGoals(2600, 1700005000000)],
      });

      await applyTableMutation({
        table: 'userGoals',
        op: 'put',
        values: [makeGoals(2000, 0)],
      });

      const state = await getAllCentralTables();
      expect(state.tables.userGoals).toHaveLength(1);
      expect(state.tables.userGoals[0].dailyCalories).toBe(2600);
    });

    it('supports merge (with updatedAt resolution) and replace sync modes', async () => {
      await syncCentralTables(
        {
          foodLogs: [makeLog('log-a', 'Rice')],
          foodsCache: [],
          customRecipes: [],
          userGoals: [makeGoals(2400, 5000)],
        },
        'replace'
      );

      // Merge with stale userGoals (updatedAt: 0) and a new log
      const merged = await syncCentralTables(
        {
          foodLogs: [makeLog('log-b', 'Salmon')],
          foodsCache: [],
          customRecipes: [],
          userGoals: [makeGoals(2000, 0)],
        },
        'merge'
      );

      expect(merged.counts.foodLogs).toBe(2);
      expect(merged.tables.userGoals[0].dailyCalories).toBe(2400);

      // Replace wipes existing logs and replaces userGoals
      const replaced = await syncCentralTables(
        {
          foodLogs: [makeLog('log-c', 'Greek Yogurt')],
          foodsCache: [],
          customRecipes: [],
          userGoals: [makeGoals(1900, 9000)],
        },
        'replace'
      );

      expect(replaced.counts.foodLogs).toBe(1);
      expect(replaced.tables.foodLogs[0].id).toBe('log-c');
      expect(replaced.tables.userGoals[0].dailyCalories).toBe(1900);
    });
  });

  describe('/api/db/sync route', () => {
    it('handles GET, POST mutate, POST sync, and rejects invalid requests', async () => {
      const mutateReq = new Request('http://localhost/api/db/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mutate',
          table: 'foodLogs',
          op: 'put',
          values: [makeLog('route-log-1', 'Steak')],
        }),
      });
      const mutateRes = await syncPostRoute(mutateReq);
      expect(mutateRes.status).toBe(200);
      expect(await mutateRes.json()).toEqual({ ok: true });

      const getRes = await syncGetRoute();
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.ok).toBe(true);
      expect(getData.counts.foodLogs).toBe(1);
      expect(getData.tables.foodLogs[0].name).toBe('Steak');

      const syncReq = new Request('http://localhost/api/db/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sync',
          mode: 'merge',
          tables: {
            foodLogs: [makeLog('route-log-2', 'Banana')],
            foodsCache: [],
            customRecipes: [],
            userGoals: [],
          },
        }),
      });
      const syncRes = await syncPostRoute(syncReq);
      expect(syncRes.status).toBe(200);
      const syncData = await syncRes.json();
      expect(syncData.counts.foodLogs).toBe(2);

      const badActionReq = new Request('http://localhost/api/db/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unknown' }),
      });
      expect((await syncPostRoute(badActionReq)).status).toBe(400);

      const badTableReq = new Request('http://localhost/api/db/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mutate',
          table: 'invalidTable',
          op: 'put',
        }),
      });
      expect((await syncPostRoute(badTableReq)).status).toBe(400);
    });
  });

  describe('Dexie DBCore middleware & client hydration', () => {
    it('replicates local put/delete to central DB and hydrates without echo loops', async () => {
      const fetchCalls: Array<{ method: string; body?: string }> = [];

      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          const method = init?.method ?? 'GET';
          const body = typeof init?.body === 'string' ? init.body : undefined;
          fetchCalls.push({ method, body });

          if (method === 'GET') {
            return syncGetRoute();
          }

          return syncPostRoute(
            new Request('http://localhost/api/db/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            })
          );
        }
      );

      setCloudSyncEnabledForTests(true);

      // Initial startup sync marks browser migrated
      await syncWithCentralDb(db);
      expect(localStorage.getItem('opencalory_central_migrated_v1')).toBe('1');

      // Local write replicates automatically via DBCore middleware
      await db.foodLogs.put(makeLog('sync-log-1', 'Whey Protein'));
      await db.foodLogs.put(makeLog('sync-log-2', 'Blueberries'));
      await flushPendingMutationsForTests();

      let serverSnapshot = await getAllCentralTables();
      expect(serverSnapshot.counts.foodLogs).toBe(2);

      // Local delete replicates automatically
      await db.foodLogs.delete('sync-log-1');
      await flushPendingMutationsForTests();

      serverSnapshot = await getAllCentralTables();
      expect(serverSnapshot.counts.foodLogs).toBe(1);
      expect(serverSnapshot.tables.foodLogs[0].id).toBe('sync-log-2');

      // Simulate another browser adding a log directly on the central server
      await applyTableMutation({
        table: 'foodLogs',
        op: 'put',
        values: [makeLog('remote-log-3', 'Avocado')],
      });

      const callCountBeforeHydrate = fetchCalls.length;
      const syncResult = await syncWithCentralDb(db);
      await flushPendingMutationsForTests();

      expect(syncResult.counts.foodLogs).toBe(2);
      const localLogs = await db.foodLogs.toArray();
      expect(localLogs.map((l) => l.id).sort()).toEqual([
        'remote-log-3',
        'sync-log-2',
      ]);

      // Hydration must issue ONLY the single GET /api/db/sync and NO echo POST mutations
      const newCalls = fetchCalls.slice(callCountBeforeHydrate);
      expect(newCalls).toHaveLength(1);
      expect(newCalls[0].method).toBe('GET');
    });

    it('tracks offline delete tombstones, clears them on Undo, and propagates deletes without resurrecting rows on reconnect', async () => {
      const onlineFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? init.body : undefined;
        if (method === 'GET') {
          return syncGetRoute();
        }
        return syncPostRoute(
          new Request('http://localhost/api/db/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
        );
      };

      vi.spyOn(globalThis, 'fetch').mockImplementation(onlineFetch);
      setCloudSyncEnabledForTests(true);

      const logKeep = { ...makeLog('off-keep', 'Eggs'), createdAt: 1000 };
      const logUndo = { ...makeLog('off-undo', 'Banana'), createdAt: 1000 };
      const logDelete = { ...makeLog('off-del', 'Toast'), createdAt: 1000 };

      await db.foodLogs.bulkPut([logKeep, logUndo, logDelete]);
      await flushPendingMutationsForTests();
      await syncWithCentralDb(db);

      // Go offline
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network offline'));

      // Delete off-undo and then Undo while offline
      await db.foodLogs.delete('off-undo');
      await flushPendingMutationsForTests();
      expect(await db.tombstones.get('foodLogs:off-undo')).toBeDefined();

      await db.foodLogs.put(logUndo);
      await flushPendingMutationsForTests();
      expect(await db.tombstones.get('foodLogs:off-undo')).toBeUndefined();

      // Delete off-del while offline and keep it deleted
      await db.foodLogs.delete('off-del');
      await flushPendingMutationsForTests();
      expect(await db.tombstones.get('foodLogs:off-del')).toBeDefined();

      // Reconnect and sync
      vi.spyOn(globalThis, 'fetch').mockImplementation(onlineFetch);
      const result = await syncWithCentralDb(db);
      expect(result.counts.foodLogs).toBe(2);

      const serverAfter = await getAllCentralTables();
      expect(serverAfter.tables.foodLogs.map((l) => l.id).sort()).toEqual([
        'off-keep',
        'off-undo',
      ]);
    });
  });

  describe('Turso v2 Schema, Tombstones & SYNC_ACCESS_KEY Auth', () => {
    it('propagates offline delete tombstones without resurrecting rows, clears tombstone on Undo re-put, and prunes >90d tombstones', async () => {
      await syncCentralTables(
        { foodLogs: [makeLog('del-1', 'Oats'), makeLog('keep-1', 'Eggs')] },
        'replace'
      );

      // Simulate offline delete tombstone newer than createdAt
      const merged = await syncCentralTables(
        {
          foodLogs: [makeLog('keep-1', 'Eggs')],
          tombstones: [
            {
              id: 'foodLogs:del-1',
              tableName: 'foodLogs',
              recordId: 'del-1',
              deletedAt: Date.now() + 1000,
            },
          ],
        },
        'merge'
      );
      expect(merged.tables.foodLogs.map((l) => l.id)).toEqual(['keep-1']);

      // Stale client still carrying del-1 (older createdAt) must not resurrect it
      const staleMerge = await syncCentralTables(
        {
          foodLogs: [makeLog('del-1', 'Oats')],
        },
        'merge'
      );
      expect(staleMerge.tables.foodLogs.map((l) => l.id)).toEqual(['keep-1']);

      // Undo restores del-1 with newer put clearing tombstone
      await applyTableMutation({
        table: 'foodLogs',
        op: 'put',
        values: [{ ...makeLog('del-1', 'Oats'), createdAt: Date.now() + 5000 }],
      });
      const afterUndo = await getAllCentralTables();
      expect(afterUndo.tables.foodLogs.map((l) => l.id)).toContain('del-1');

      // Prunes tombstones older than 90 days
      const oldTs = Date.now() - 91 * 86_400_000;
      const pruned = await syncCentralTables(
        {
          tombstones: [
            {
              id: 'foodLogs:ancient-1',
              tableName: 'foodLogs',
              recordId: 'ancient-1',
              deletedAt: oldTs,
            },
          ],
        },
        'merge'
      );
      expect(pruned.tables.tombstones).toEqual([]);
    });

    it('persists weightLogs and pinnedFoods and returns latest weight via getLatestWeightLog()', async () => {
      expect(await getLatestWeightLog()).toBeNull();

      const older: WeightLogEntry = {
        id: 'w-1',
        date: '2026-11-18',
        weightKg: 77.2,
        source: 'manual',
        recordedAt: '2026-11-18T07:00:00.000Z',
        createdAt: 1000,
        updatedAt: 1000,
      };
      const newer: WeightLogEntry = {
        id: 'w-2',
        date: '2026-11-20',
        weightKg: 76.5,
        source: 'apple_health',
        recordedAt: '2026-11-20T07:30:00.000Z',
        createdAt: 2000,
        updatedAt: 2000,
      };

      const weightMutRes = await syncPostRoute(
        new Request('http://localhost/api/db/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'mutate',
            table: 'weightLogs',
            op: 'put',
            values: [older, newer],
          }),
        })
      );
      expect(weightMutRes.status).toBe(200);

      const pinMutRes = await syncPostRoute(
        new Request('http://localhost/api/db/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'mutate',
            table: 'pinnedFoods',
            op: 'put',
            values: [{ id: 'food:staple:1', kind: 'food', refId: 'staple:1', pinnedAt: 1500 }],
          }),
        })
      );
      expect(pinMutRes.status).toBe(200);

      const latest = await getLatestWeightLog();
      expect(latest?.id).toBe('w-2');
      expect(latest?.weightKg).toBe(76.5);
    });

    it('breaks same-day weightLogs ties by recordedAt DESC, then createdAt DESC', async () => {
      const sameDayEarlierRecordedNewerCreated: WeightLogEntry = {
        id: 'w-tie-a',
        date: '2026-11-20',
        weightKg: 77.0,
        source: 'manual',
        recordedAt: '2026-11-20T06:00:00.000Z',
        createdAt: 5000,
        updatedAt: 5000,
      };
      const sameDayLaterRecordedEarlierCreated: WeightLogEntry = {
        id: 'w-tie-b',
        date: '2026-11-20',
        weightKg: 76.4,
        source: 'apple_health',
        recordedAt: '2026-11-20T08:30:00.000Z',
        createdAt: 2000,
        updatedAt: 2000,
      };

      await applyTableMutation({
        table: 'weightLogs',
        op: 'put',
        values: [sameDayEarlierRecordedNewerCreated, sameDayLaterRecordedEarlierCreated],
      });

      const latestByRecorded = await getLatestWeightLog();
      expect(latestByRecorded?.id).toBe('w-tie-b');

      const allAfterRecorded = await getAllCentralTables();
      expect(allAfterRecorded.tables.weightLogs.map((w) => w.id)).toEqual([
        'w-tie-b',
        'w-tie-a',
      ]);

      // Exact same date & recordedAt -> breaks tie by createdAt DESC
      const exactTieOlder: WeightLogEntry = {
        id: 'w-tie-c',
        date: '2026-11-21',
        weightKg: 76.2,
        source: 'manual',
        recordedAt: '2026-11-21T07:00:00.000Z',
        createdAt: 1000,
        updatedAt: 1000,
      };
      const exactTieNewer: WeightLogEntry = {
        id: 'w-tie-d',
        date: '2026-11-21',
        weightKg: 76.1,
        source: 'manual',
        recordedAt: '2026-11-21T07:00:00.000Z',
        createdAt: 3000,
        updatedAt: 3000,
      };

      await applyTableMutation({
        table: 'weightLogs',
        op: 'put',
        values: [exactTieOlder, exactTieNewer],
      });

      const latestByCreated = await getLatestWeightLog();
      expect(latestByCreated?.id).toBe('w-tie-d');

      const allAfterCreated = await getAllCentralTables();
      expect(allAfterCreated.tables.weightLogs.map((w) => w.id)).toEqual([
        'w-tie-d',
        'w-tie-c',
        'w-tie-b',
        'w-tie-a',
      ]);
    });

    it('rejects unauthenticated /api/db/sync and /api/ai/* when SYNC_ACCESS_KEY is set, and accepts Bearer token', async () => {
      process.env.SYNC_ACCESS_KEY = 'secret-passphrase';

      const unauthSync = await syncGetRoute(new Request('http://localhost/api/db/sync'));
      expect(unauthSync.status).toBe(401);
      expect(await unauthSync.json()).toEqual({
        ok: false,
        error: 'Unauthorized',
        authRequired: true,
      });

      const unauthSyncPost = await syncPostRoute(
        new Request('http://localhost/api/db/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sync', mode: 'merge', tables: {} }),
        })
      );
      expect(unauthSyncPost.status).toBe(401);

      const unauthAiMeal = await mealScanPost(
        new Request('http://localhost/api/ai/meal-scan', { method: 'POST', body: '{}' })
      );
      expect(unauthAiMeal.status).toBe(401);

      const unauthAiRefine = await refinePost(
        new Request('http://localhost/api/ai/refine', { method: 'POST', body: '{}' })
      );
      expect(unauthAiRefine.status).toBe(401);

      const unauthAiOcr = await labelOcrPost(
        new Request('http://localhost/api/ai/label-ocr', { method: 'POST', body: '{}' })
      );
      expect(unauthAiOcr.status).toBe(401);

      const unauthAiHealth = await aiHealthGet(new Request('http://localhost/api/ai/health'));
      expect(unauthAiHealth.status).toBe(401);

      const authSync = await syncGetRoute(
        new Request('http://localhost/api/db/sync', {
          headers: { Authorization: 'Bearer secret-passphrase' },
        })
      );
      expect(authSync.status).toBe(200);

      delete process.env.AI_BASE_URL;
      delete process.env.AI_API_KEY;
      delete process.env.AI_MODEL;
      const authAiHealth = await aiHealthGet(
        new Request('http://localhost/api/ai/health', {
          headers: { Authorization: 'Bearer secret-passphrase' },
        })
      );
      expect(authAiHealth.status).toBe(200);
    });

    it('issues and clears HttpOnly HMAC session cookie via /api/auth/sync-session and unlocks sync & AI routes', async () => {
      // Open mode when SYNC_ACCESS_KEY is unset
      const openStatusRes = await syncSessionGet(
        new Request('http://localhost/api/auth/sync-session')
      );
      expect(openStatusRes.status).toBe(200);
      expect(await openStatusRes.json()).toEqual({
        authRequired: false,
        authenticated: true,
      });

      process.env.SYNC_ACCESS_KEY = 'secret-passphrase';

      const lockedStatusRes = await syncSessionGet(
        new Request('http://localhost/api/auth/sync-session')
      );
      expect(await lockedStatusRes.json()).toEqual({
        authRequired: true,
        authenticated: false,
      });

      const badPassRes = await syncSessionPost(
        new Request('http://localhost/api/auth/sync-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: 'wrong-passphrase' }),
        })
      );
      expect(badPassRes.status).toBe(401);

      const arrayBodyRes = await syncSessionPost(
        new Request('http://localhost/api/auth/sync-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '[]',
        })
      );
      expect(arrayBodyRes.status).toBe(400);
      expect(arrayBodyRes.headers.get('Cache-Control')).toContain('no-store');

      const goodPassRes = await syncSessionPost(
        new Request('http://localhost/api/auth/sync-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: 'secret-passphrase' }),
        })
      );
      expect(goodPassRes.status).toBe(200);
      const setCookie = goodPassRes.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('opencalory_sync_session=');
      expect(setCookie.toLowerCase()).toContain('httponly');
      expect(setCookie.toLowerCase()).toContain('samesite=lax');
      expect(setCookie).toContain('Max-Age=2592000');

      const cookiePair = setCookie.split(';')[0];
      const unlockedStatus = await syncSessionGet(
        new Request('http://localhost/api/auth/sync-session', {
          headers: { Cookie: cookiePair },
        })
      );
      expect(await unlockedStatus.json()).toEqual({
        authRequired: true,
        authenticated: true,
      });

      const cookieSyncRes = await syncGetRoute(
        new Request('http://localhost/api/db/sync', {
          headers: { Cookie: cookiePair },
        })
      );
      expect(cookieSyncRes.status).toBe(200);

      delete process.env.AI_BASE_URL;
      delete process.env.AI_API_KEY;
      delete process.env.AI_MODEL;
      const cookieAiHealthRes = await aiHealthGet(
        new Request('http://localhost/api/ai/health', {
          headers: { Cookie: cookiePair },
        })
      );
      expect(cookieAiHealthRes.status).toBe(200);

      const logoutRes = await syncSessionDelete();
      expect(logoutRes.status).toBe(200);
      const clearedCookie = logoutRes.headers.get('set-cookie') ?? '';
      expect(clearedCookie).toContain('Max-Age=0');
    });

    it('sets syncAuthLocked on 401 and allows unlocking via SyncUnlockCard inside CentralDbStatusCard and AiHealthStatusCard', async () => {
      process.env.SYNC_ACCESS_KEY = 'secret-passphrase';
      delete process.env.AI_BASE_URL;
      delete process.env.AI_API_KEY;
      delete process.env.AI_MODEL;

      let cookieHeader = '';
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.toString();
          const method = init?.method ?? 'GET';
          const headers = new Headers(init?.headers);
          if (cookieHeader && !headers.has('Cookie')) {
            headers.set('Cookie', cookieHeader);
          }

          if (url.includes('/api/auth/sync-session')) {
            const res = await syncSessionPost(
              new Request('http://localhost/api/auth/sync-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: typeof init?.body === 'string' ? init.body : undefined,
              })
            );
            const setCookie = res.headers.get('set-cookie');
            if (setCookie) {
              cookieHeader = setCookie.split(';')[0];
            }
            return res;
          }

          if (url.includes('/api/ai/health')) {
            return aiHealthGet(
              new Request('http://localhost/api/ai/health', { headers })
            );
          }

          if (method === 'GET') {
            return syncGetRoute(
              new Request('http://localhost/api/db/sync', { headers })
            );
          }
          return syncPostRoute(
            new Request('http://localhost/api/db/sync', {
              method: 'POST',
              headers,
              body: typeof init?.body === 'string' ? init.body : undefined,
            })
          );
        }
      );

      setCloudSyncEnabledForTests(true);

      await expect(syncWithCentralDb(db)).rejects.toBeInstanceOf(SyncAuthError);
      expect(useLoggerStore.getState().syncAuthLocked).toBe(true);

      render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(CentralDbStatusCard),
          React.createElement(AiHealthStatusCard)
        )
      );

      const inputs = await screen.findAllByPlaceholderText(/enter sync passphrase/i);
      expect(inputs.length).toBeGreaterThan(0);

      // Submit invalid passphrase first
      fireEvent.change(inputs[0], { target: { value: 'wrong' } });
      fireEvent.click(screen.getAllByRole('button', { name: /^unlock$/i })[0]);
      await waitFor(() => {
        expect(screen.getByText(/invalid passphrase/i)).toBeInTheDocument();
      });

      // Submit valid passphrase
      fireEvent.change(inputs[0], { target: { value: 'secret-passphrase' } });
      fireEvent.click(screen.getAllByRole('button', { name: /^unlock$/i })[0]);

      await waitFor(() => {
        expect(useLoggerStore.getState().syncAuthLocked).toBe(false);
        expect(screen.queryByPlaceholderText(/enter sync passphrase/i)).not.toBeInTheDocument();
        expect(screen.getByText(/Local SQLite \(Test Memory\)/i)).toBeInTheDocument();
        expect(screen.getByText(/Not configured/i)).toBeInTheDocument();
      });
    });

    it('auto-refreshes CentralDbStatusCard when unlocked via AiHealthStatusCard and sets no-store on AI error responses', async () => {
      process.env.SYNC_ACCESS_KEY = 'secret-passphrase';
      delete process.env.AI_BASE_URL;
      delete process.env.AI_API_KEY;
      delete process.env.AI_MODEL;

      // Verify NO_STORE_HEADERS on AI error responses (authenticated 400 / 503)
      const bearerHeader = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-passphrase',
      };
      const mealBadRes = await mealScanPost(
        new Request('http://localhost/api/ai/meal-scan', {
          method: 'POST',
          headers: bearerHeader,
          body: '{}',
        })
      );
      expect(mealBadRes.status).toBe(400);
      expect(mealBadRes.headers.get('Cache-Control')).toContain('no-store');

      const refineBadRes = await refinePost(
        new Request('http://localhost/api/ai/refine', {
          method: 'POST',
          headers: bearerHeader,
          body: '{}',
        })
      );
      expect(refineBadRes.status).toBe(400);
      expect(refineBadRes.headers.get('Cache-Control')).toContain('no-store');

      const ocrUnconfiguredRes = await labelOcrPost(
        new Request('http://localhost/api/ai/label-ocr', {
          method: 'POST',
          headers: bearerHeader,
          body: JSON.stringify({ imageDataUrl: 'data:image/png;base64,AAAA' }),
        })
      );
      expect(ocrUnconfiguredRes.status).toBe(503);
      expect(ocrUnconfiguredRes.headers.get('Cache-Control')).toContain('no-store');

      // Now test unlocking via AiHealthStatusCard (second unlock card) refreshing CentralDbStatusCard
      let cookieHeader = '';
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.toString();
          const method = init?.method ?? 'GET';
          const headers = new Headers(init?.headers);
          if (cookieHeader && !headers.has('Cookie')) {
            headers.set('Cookie', cookieHeader);
          }

          if (url.includes('/api/auth/sync-session')) {
            const res = await syncSessionPost(
              new Request('http://localhost/api/auth/sync-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: typeof init?.body === 'string' ? init.body : undefined,
              })
            );
            const setCookie = res.headers.get('set-cookie');
            if (setCookie) {
              cookieHeader = setCookie.split(';')[0];
            }
            return res;
          }

          if (url.includes('/api/ai/health')) {
            return aiHealthGet(
              new Request('http://localhost/api/ai/health', { headers })
            );
          }

          if (method === 'GET') {
            return syncGetRoute(
              new Request('http://localhost/api/db/sync', { headers })
            );
          }
          return syncPostRoute(
            new Request('http://localhost/api/db/sync', {
              method: 'POST',
              headers,
              body: typeof init?.body === 'string' ? init.body : undefined,
            })
          );
        }
      );

      setCloudSyncEnabledForTests(true);

      render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(CentralDbStatusCard),
          React.createElement(AiHealthStatusCard)
        )
      );

      const inputs = await screen.findAllByPlaceholderText(/enter sync passphrase/i);
      expect(inputs).toHaveLength(2);
      await waitFor(() => {
        expect(screen.queryByText(/Syncing\.\.\.|Checking\.\.\./i)).not.toBeInTheDocument();
      });

      // Unlock using the SECOND unlock card (AiHealthStatusCard)
      fireEvent.change(inputs[1], { target: { value: 'secret-passphrase' } });
      fireEvent.click(screen.getAllByRole('button', { name: /^unlock$/i })[1]);

      await waitFor(() => {
        expect(useLoggerStore.getState().syncAuthLocked).toBe(false);
        expect(screen.queryByPlaceholderText(/enter sync passphrase/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Syncing\.\.\.|Checking\.\.\./i)).not.toBeInTheDocument();
        expect(screen.getByText(/Local SQLite \(Test Memory\)/i)).toBeInTheDocument();
        expect(screen.getByText(/Not configured/i)).toBeInTheDocument();
      });

      // When syncAuthLocked flips back to true, neither card shows stale status details
      act(() => {
        useLoggerStore.getState().setSyncAuthLocked(true);
      });
      expect(screen.queryByText(/Local SQLite \(Test Memory\)/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Not configured/i)).not.toBeInTheDocument();
      expect(screen.getAllByPlaceholderText(/enter sync passphrase/i)).toHaveLength(2);
    });

    it('persists PENDING_REPLACE_SYNC_KEY when importBackupJson(replace) hits 401 or network error and upgrades reconnect sync to mode: replace', async () => {
      await syncCentralTables(
        {
          foodLogs: [makeLog('server-stale-1', 'Old Server Pizza'), makeLog('server-stale-2', 'Old Server Soda')],
          foodsCache: [],
          customRecipes: [],
          userGoals: [makeGoals(2600, 5000)],
        },
        'replace'
      );

      localStorage.setItem('opencalory_central_migrated_v1', '1');
      setCloudSyncEnabledForTests(true);

      // 1. Simulate 401 locked state during importBackupJson(..., 'replace')
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized', authRequired: true }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const backupPayload = JSON.stringify({
        version: 2,
        exportedAt: 9000,
        tables: {
          foodLogs: [makeLog('backup-only-1', 'Backup Oats')],
          foodsCache: [],
          customRecipes: [],
          userGoals: [makeGoals(1950, 9000)],
          weightLogs: [],
          pinnedFoods: [],
        },
      });

      const importResult = await importBackupJson(backupPayload, 'replace');
      expect(importResult.syncPending).toBe(true);
      expect(localStorage.getItem(PENDING_REPLACE_SYNC_KEY)).toBe('1');

      // 2. Reconnect / unlock and call syncWithCentralDb(db) without explicit forcePushMode
      const sentSyncModes: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          const method = init?.method ?? 'GET';
          const body = typeof init?.body === 'string' ? init.body : undefined;
          if (method === 'POST' && body) {
            const parsed = JSON.parse(body) as { action?: string; mode?: string };
            if (parsed.action === 'sync' && parsed.mode) {
              sentSyncModes.push(parsed.mode);
            }
          }
          if (method === 'GET') {
            return syncGetRoute(new Request('http://localhost/api/db/sync'));
          }
          return syncPostRoute(
            new Request('http://localhost/api/db/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            })
          );
        }
      );

      const syncRes = await syncWithCentralDb(db);
      expect(sentSyncModes).toEqual(['replace']);
      expect(localStorage.getItem(PENDING_REPLACE_SYNC_KEY)).toBeNull();
      expect(syncRes.counts.foodLogs).toBe(1);

      const serverAfter = await getAllCentralTables();
      expect(serverAfter.tables.foodLogs.map((l) => l.id)).toEqual(['backup-only-1']);
      expect(serverAfter.tables.userGoals[0].dailyCalories).toBe(1950);

      // 3. Also verify offline network failure path preserves pending replace intent
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network offline'));
      const secondBackup = JSON.stringify({
        version: 2,
        exportedAt: 12000,
        tables: {
          foodLogs: [],
          foodsCache: [],
          customRecipes: [],
          userGoals: [makeGoals(1800, 12000)],
          weightLogs: [],
          pinnedFoods: [],
        },
      });
      const offlineResult = await importBackupJson(secondBackup, 'replace');
      expect(offlineResult.syncPending).toBe(true);
      expect(localStorage.getItem(PENDING_REPLACE_SYNC_KEY)).toBe('1');

      sentSyncModes.length = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          const method = init?.method ?? 'GET';
          const body = typeof init?.body === 'string' ? init.body : undefined;
          if (method === 'POST' && body) {
            const parsed = JSON.parse(body) as { action?: string; mode?: string };
            if (parsed.action === 'sync' && parsed.mode) {
              sentSyncModes.push(parsed.mode);
            }
          }
          if (method === 'GET') {
            return syncGetRoute(new Request('http://localhost/api/db/sync'));
          }
          return syncPostRoute(
            new Request('http://localhost/api/db/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            })
          );
        }
      );

      const secondSync = await syncWithCentralDb(db);
      expect(sentSyncModes).toEqual(['replace']);
      expect(localStorage.getItem(PENDING_REPLACE_SYNC_KEY)).toBeNull();
      expect(secondSync.counts.foodLogs).toBe(0);
    });
  });
});
