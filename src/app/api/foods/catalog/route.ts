import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { getActiveCatalogGzipPath } from '@/lib/foods/server-catalog';

export const runtime = 'nodejs';

async function resolveEtag(gzipPath: string, manifestSha256?: string): Promise<string> {
  if (manifestSha256 && /^[a-f0-9]{16,64}$/i.test(manifestSha256)) {
    return `"${manifestSha256.toLowerCase()}"`;
  }
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(gzipPath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return `"${hash.digest('hex')}"`;
}

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === '*') return true;

  const targetBare = etag.replace(/^W\//i, '').replace(/^"|"$/g, '');
  return trimmed
    .split(',')
    .map((part) => part.trim().replace(/^W\//i, '').replace(/^"|"$/g, ''))
    .some((candidate) => candidate === targetBare);
}

export async function GET(request: NextRequest) {
  const active = await getActiveCatalogGzipPath();
  if (!active) {
    return NextResponse.json(
      { error: 'Food catalog archive not found.' },
      { status: 404 }
    );
  }

  const [fileStat, etag] = await Promise.all([
    fsp.stat(active.path),
    resolveEtag(active.path, active.manifest?.sha256),
  ]);

  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  const nodeStream = fs.createReadStream(active.path);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(fileStat.size),
      ETag: etag,
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
