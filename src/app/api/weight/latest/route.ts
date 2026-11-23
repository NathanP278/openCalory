import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { NO_STORE_HEADERS } from '@/lib/auth/sync-auth';
import {
  getLatestWeightLog,
  recordShortcutSyncTimestamp,
} from '@/lib/db/server-db';

export const dynamic = 'force-dynamic';

const KG_TO_LB = 2.20462;
const DEFAULT_TIMEZONE = 'Asia/Manila';

const EMPTY_WEIGHT_RESPONSE = {
  id: null,
  date: null,
  weight_kg: null,
  weight_lb: null,
  recorded_at: null,
} as const;

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() + 1 === month &&
    check.getUTCDate() === day
  );
}

function getTodayDateInTimezone(timeZone: string, now: Date = new Date()): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

function verifyShortcutApiKey(candidate: string, secret: string): boolean {
  if (!secret || !candidate) return false;
  const digestA = crypto.createHmac('sha256', secret).update(candidate, 'utf8').digest();
  const digestB = crypto.createHmac('sha256', secret).update(secret, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

export async function GET(request: Request) {
  const configuredSecret = process.env.SHORTCUT_API_KEY?.trim() ?? '';

  if (!configuredSecret) {
    return NextResponse.json(
      { error: 'SHORTCUT_API_KEY is not configured on the server.' },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  const token = extractBearerToken(request.headers.get('authorization'));
  if (!token || !verifyShortcutApiKey(token, configuredSecret)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  const { searchParams } = new URL(request.url);
  const dateParam = searchParams.get('date')?.trim() ?? '';
  const tzParam = searchParams.get('tz')?.trim() ?? '';

  let targetDate: string;
  if (dateParam) {
    if (!isValidIsoDate(dateParam)) {
      return NextResponse.json(
        { error: 'Invalid date parameter. Expected YYYY-MM-DD.' },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }
    targetDate = dateParam;
  } else {
    const timeZone = tzParam || DEFAULT_TIMEZONE;
    const resolvedDate = getTodayDateInTimezone(timeZone);
    if (!resolvedDate) {
      return NextResponse.json(
        { error: 'Invalid tz parameter. Expected a valid IANA timezone (e.g. Asia/Manila).' },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }
    targetDate = resolvedDate;
  }

  try {
    await recordShortcutSyncTimestamp();
    const latest = await getLatestWeightLog(targetDate);
    if (!latest) {
      return NextResponse.json(EMPTY_WEIGHT_RESPONSE, {
        status: 200,
        headers: NO_STORE_HEADERS,
      });
    }

    return NextResponse.json(
      {
        id: latest.id,
        date: latest.date,
        weight_kg: Number(latest.weightKg.toFixed(2)),
        weight_lb: Number((latest.weightKg * KG_TO_LB).toFixed(2)),
        recorded_at: latest.recordedAt,
      },
      { status: 200, headers: NO_STORE_HEADERS }
    );
  } catch (err: unknown) {
    console.error('Failed to query latest weigh-in:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve latest weigh-in.' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
