import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyTableMutation,
  resetServerDbForTests,
} from '@/lib/db/server-db';
import { GET } from '../latest/route';
import { GET as getStatus } from '../status/route';

const EMPTY_PAYLOAD = {
  id: null,
  date: null,
  weight_kg: null,
  weight_lb: null,
  recorded_at: null,
};

describe('GET /api/weight/latest and GET /api/weight/status', () => {
  const originalShortcutKey = process.env.SHORTCUT_API_KEY;

  beforeEach(async () => {
    resetServerDbForTests();
    await applyTableMutation({ table: 'weightLogs', op: 'clear' });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalShortcutKey === undefined) {
      delete process.env.SHORTCUT_API_KEY;
    } else {
      process.env.SHORTCUT_API_KEY = originalShortcutKey;
    }
    resetServerDbForTests();
  });

  it('enforces SHORTCUT_API_KEY, returns 200 with null fields when empty, and returns today-only flat JSON', async () => {
    delete process.env.SHORTCUT_API_KEY;
    const unconfiguredRes = await GET(
      new Request('http://localhost/api/weight/latest')
    );
    expect(unconfiguredRes.status).toBe(503);
    expect(unconfiguredRes.headers.get('cache-control')).toMatch(/no-store/i);

    const statusUnconfigured = await getStatus();
    expect(statusUnconfigured.status).toBe(200);
    expect(await statusUnconfigured.json()).toEqual({
      configured: false,
      connected: false,
      lastSyncedAt: null,
    });

    process.env.SHORTCUT_API_KEY = 'shortcut-secret';

    const statusConfigured = await getStatus();
    expect(statusConfigured.status).toBe(200);
    expect(statusConfigured.headers.get('cache-control')).toMatch(/no-store/i);
    expect(await statusConfigured.json()).toEqual({
      configured: true,
      connected: false,
      lastSyncedAt: null,
    });

    const missingAuthRes = await GET(
      new Request('http://localhost/api/weight/latest')
    );
    expect(missingAuthRes.status).toBe(401);

    const wrongAuthRes = await GET(
      new Request('http://localhost/api/weight/latest', {
        headers: { Authorization: 'Bearer wrong' },
      })
    );
    expect(wrongAuthRes.status).toBe(401);
    expect(wrongAuthRes.headers.get('cache-control')).toMatch(/no-store/i);

    // Unauthorized calls must NOT mark the shortcut as connected
    const statusAfterFailedAuth = await getStatus();
    expect(await statusAfterFailedAuth.json()).toEqual({
      configured: true,
      connected: false,
      lastSyncedAt: null,
    });

    const emptyRes = await GET(
      new Request('http://localhost/api/weight/latest?date=2026-11-21', {
        headers: { Authorization: 'Bearer shortcut-secret' },
      })
    );
    expect(emptyRes.status).toBe(200);
    expect(emptyRes.headers.get('cache-control')).toMatch(/no-store/i);
    expect(await emptyRes.json()).toEqual(EMPTY_PAYLOAD);

    // First authenticated call marks shortcut as connected and records lastSyncedAt
    const statusAfterConnected = await getStatus();
    const statusAfterConnectedBody = (await statusAfterConnected.json()) as {
      configured: boolean;
      connected: boolean;
      lastSyncedAt: string | null;
    };
    expect(statusAfterConnectedBody.configured).toBe(true);
    expect(statusAfterConnectedBody.connected).toBe(true);
    expect(typeof statusAfterConnectedBody.lastSyncedAt).toBe('string');

    // Backfilled past entries should NOT be returned when querying today (2026-11-21)
    await applyTableMutation({
      table: 'weightLogs',
      op: 'put',
      values: [
        {
          id: 'w_103',
          date: '2026-11-19',
          weightKg: 77.0,
          source: 'manual',
          recordedAt: '2026-11-19T08:00:00.000Z',
          createdAt: 900,
          updatedAt: 900,
        },
        {
          id: 'w_104',
          date: '2026-11-20',
          weightKg: 76.5,
          source: 'manual',
          recordedAt: '2026-11-20T08:00:00.000Z',
          createdAt: 5000,
          updatedAt: 5000,
        },
      ],
    });

    const backfilledOnlyRes = await GET(
      new Request('http://localhost/api/weight/latest?date=2026-11-21', {
        headers: { Authorization: 'Bearer shortcut-secret' },
      })
    );
    expect(backfilledOnlyRes.status).toBe(200);
    expect(backfilledOnlyRes.headers.get('cache-control')).toMatch(/no-store/i);
    expect(await backfilledOnlyRes.json()).toEqual(EMPTY_PAYLOAD);

    // Multiple entries for today -> returns most recent by recorded_at DESC, created_at DESC
    await applyTableMutation({
      table: 'weightLogs',
      op: 'put',
      values: [
        {
          id: 'w_today_morning',
          date: '2026-11-21',
          weightKg: 76.2,
          source: 'manual',
          recordedAt: '2026-11-21T00:15:00.000Z',
          createdAt: 6000,
          updatedAt: 6000,
        },
        {
          id: 'w_today_evening_a',
          date: '2026-11-21',
          weightKg: 76.5,
          source: 'manual',
          recordedAt: '2026-11-21T10:00:00.000Z',
          createdAt: 7000,
          updatedAt: 7000,
        },
        {
          id: 'w_today_evening_b',
          date: '2026-11-21',
          weightKg: 76.4,
          source: 'manual',
          recordedAt: '2026-11-21T10:00:00.000Z',
          createdAt: 8000,
          updatedAt: 8000,
        },
      ],
    });

    const okRes = await GET(
      new Request('http://localhost/api/weight/latest?date=2026-11-21', {
        headers: { Authorization: 'Bearer shortcut-secret' },
      })
    );
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('cache-control')).toMatch(/no-store/i);
    expect(await okRes.json()).toEqual({
      id: 'w_today_evening_b',
      date: '2026-11-21',
      weight_kg: 76.4,
      weight_lb: 168.43,
      recorded_at: '2026-11-21T10:00:00.000Z',
    });
  });

  it('defaults to Asia/Manila timezone and respects ?tz= across UTC midnight boundary', async () => {
    process.env.SHORTCUT_API_KEY = 'shortcut-secret';

    // 2026-11-20T16:30:00.000Z is 2026-11-21 00:30:00 in Asia/Manila (+08:00),
    // but still 2026-11-20 in UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T16:30:00.000Z'));

    await applyTableMutation({
      table: 'weightLogs',
      op: 'put',
      values: [
        {
          id: 'w_nov20',
          date: '2026-11-20',
          weightKg: 77.0,
          source: 'manual',
          recordedAt: '2026-11-20T08:00:00.000Z',
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    });

    // Default tz (Asia/Manila -> 2026-11-21): should NOT return 2026-11-20 entry
    const defaultTzRes = await GET(
      new Request('http://localhost/api/weight/latest', {
        headers: { Authorization: 'Bearer shortcut-secret' },
      })
    );
    expect(defaultTzRes.status).toBe(200);
    expect(await defaultTzRes.json()).toEqual(EMPTY_PAYLOAD);

    // Explicit ?tz=UTC (-> 2026-11-20): SHOULD return 2026-11-20 entry
    const utcTzRes = await GET(
      new Request('http://localhost/api/weight/latest?tz=UTC', {
        headers: { Authorization: 'Bearer shortcut-secret' },
      })
    );
    expect(utcTzRes.status).toBe(200);
    expect(await utcTzRes.json()).toEqual({
      id: 'w_nov20',
      date: '2026-11-20',
      weight_kg: 77,
      weight_lb: 169.76,
      recorded_at: '2026-11-20T08:00:00.000Z',
    });

    // Now log a 2026-11-21 entry and verify default Asia/Manila returns it
    await applyTableMutation({
      table: 'weightLogs',
      op: 'put',
      values: [
        {
          id: 'w_nov21',
          date: '2026-11-21',
          weightKg: 76.5,
          source: 'manual',
          recordedAt: '2026-11-20T16:30:00.000Z',
          createdAt: 2000,
          updatedAt: 2000,
        },
      ],
    });

    const manilaRes = await GET(
      new Request('http://localhost/api/weight/latest?tz=Asia/Manila', {
        headers: { Authorization: 'Bearer shortcut-secret' },
      })
    );
    expect(manilaRes.status).toBe(200);
    expect(await manilaRes.json()).toEqual({
      id: 'w_nov21',
      date: '2026-11-21',
      weight_kg: 76.5,
      weight_lb: 168.65,
      recorded_at: '2026-11-20T16:30:00.000Z',
    });
  });

  it('returns 400 for invalid ?date or ?tz query parameters', async () => {
    process.env.SHORTCUT_API_KEY = 'shortcut-secret';

    const badDateRes = await GET(
      new Request('http://localhost/api/weight/latest?date=2026-99-99', {
        headers: { Authorization: 'Bearer shortcut-secret' },
      })
    );
    expect(badDateRes.status).toBe(400);

    const badTzRes = await GET(
      new Request('http://localhost/api/weight/latest?tz=Invalid/Zone', {
        headers: { Authorization: 'Bearer shortcut-secret' },
      })
    );
    expect(badTzRes.status).toBe(400);
  });
});
