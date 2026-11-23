import { NextResponse } from 'next/server';
import { NO_STORE_HEADERS } from '@/lib/auth/sync-auth';
import { getShortcutSyncStatus } from '@/lib/db/server-db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const configured = Boolean(process.env.SHORTCUT_API_KEY?.trim());
  let connected = false;
  let lastSyncedAt: string | null = null;

  if (configured) {
    try {
      const syncStatus = await getShortcutSyncStatus();
      connected = syncStatus.connected;
      lastSyncedAt = syncStatus.lastSyncedAt;
    } catch {
      connected = false;
      lastSyncedAt = null;
    }
  }

  return NextResponse.json(
    { configured, connected, lastSyncedAt },
    { status: 200, headers: NO_STORE_HEADERS }
  );
}
