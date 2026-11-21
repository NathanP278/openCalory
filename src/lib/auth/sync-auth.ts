import crypto from 'node:crypto';
import { NextResponse } from 'next/server';

export const SYNC_SESSION_COOKIE = 'opencalory_sync_session';
export const SYNC_SESSION_MAX_AGE_SECONDS = 2_592_000; // 30 days

export const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
};

function getSyncAccessKey(): string {
  return process.env.SYNC_ACCESS_KEY?.trim() ?? '';
}

function timingSafeEqualStrings(a: string, b: string, hmacKey: string): boolean {
  const digestA = crypto.createHmac('sha256', hmacKey).update(a, 'utf8').digest();
  const digestB = crypto.createHmac('sha256', hmacKey).update(b, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

export function isSyncAuthConfigured(): boolean {
  return getSyncAccessKey().length > 0;
}

export function verifyPassphrase(candidate: string): boolean {
  const key = getSyncAccessKey();
  if (!key || typeof candidate !== 'string' || candidate.length === 0) {
    return false;
  }
  return timingSafeEqualStrings(candidate, key, key);
}

export function createSyncSessionToken(): string {
  const key = getSyncAccessKey();
  if (!key) {
    throw new Error('SYNC_ACCESS_KEY is not configured');
  }
  const expMs = Date.now() + SYNC_SESSION_MAX_AGE_SECONDS * 1000;
  const nonce = crypto.randomBytes(16).toString('base64url');
  const payload = `v1.${expMs}.${nonce}`;
  const sig = crypto
    .createHmac('sha256', key)
    .update(payload, 'utf8')
    .digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySyncSessionToken(token: string): boolean {
  const key = getSyncAccessKey();
  if (!key || typeof token !== 'string' || token.length === 0) {
    return false;
  }

  const parts = token.split('.');
  if (parts.length !== 4) {
    return false;
  }

  const [version, expStr, nonce, sig] = parts;
  if (version !== 'v1' || !expStr || !nonce || !sig) {
    return false;
  }

  const expMs = Number(expStr);
  if (!Number.isFinite(expMs) || expMs <= Date.now()) {
    return false;
  }

  const payload = `${version}.${expStr}.${nonce}`;
  const expectedSig = crypto
    .createHmac('sha256', key)
    .update(payload, 'utf8')
    .digest('base64url');

  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

function extractCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex).trim();
    if (key === name) {
      const rawValue = pair.slice(eqIndex + 1).trim();
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
  }
  return null;
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

export function isSyncRequestAuthenticated(request?: Request): boolean {
  if (!isSyncAuthConfigured()) {
    return true;
  }
  if (!request) {
    return false;
  }

  const bearer = extractBearerToken(request.headers.get('authorization'));
  if (bearer && verifyPassphrase(bearer)) {
    return true;
  }

  const cookieToken = extractCookieValue(
    request.headers.get('cookie'),
    SYNC_SESSION_COOKIE
  );
  if (cookieToken && verifySyncSessionToken(cookieToken)) {
    return true;
  }

  return false;
}

export function requireSyncAuth(request?: Request): NextResponse | null {
  if (isSyncRequestAuthenticated(request)) {
    return null;
  }
  return NextResponse.json(
    { ok: false, error: 'Unauthorized', authRequired: true },
    { status: 401, headers: NO_STORE_HEADERS }
  );
}
