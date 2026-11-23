import { NextRequest, NextResponse } from 'next/server';
import { deduplicateSearchResults } from '@/lib/foods/dedup';
import { searchLiveProviders } from '@/lib/foods/live-providers';
import { searchServerCatalog } from '@/lib/foods/server-catalog';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') ?? searchParams.get('query') ?? '').trim();

  const rawLimit = Number(searchParams.get('limit') ?? '30');
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(60, Math.round(rawLimit)))
    : 30;

  const region = (searchParams.get('region') ?? '').trim() || undefined;
  const onlineParam = (searchParams.get('online') ?? '0').trim().toLowerCase();
  const includeOnline = onlineParam === '1' || onlineParam === 'true';

  if (!q) {
    return NextResponse.json(
      {
        items: [],
        source: includeOnline ? 'catalog+live' : 'catalog',
        providersUsed: ['catalog'],
      },
      { status: 200 }
    );
  }

  const catalogItems = await searchServerCatalog(q, { limit, region });

  if (!includeOnline) {
    const items = deduplicateSearchResults(catalogItems).slice(0, limit);
    return NextResponse.json(
      {
        items,
        source: 'catalog' as const,
        providersUsed: ['catalog'],
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'private, max-age=60',
        },
      }
    );
  }

  const liveResult = await searchLiveProviders(q, {
    region,
    signal: request.signal,
  });

  const merged = deduplicateSearchResults([...catalogItems, ...liveResult.items]).slice(0, limit);
  const providersUsed = ['catalog', ...liveResult.providersUsed];

  return NextResponse.json(
    {
      items: merged,
      source: 'catalog+live' as const,
      ...(liveResult.partialError ? { partialError: liveResult.partialError } : {}),
      providersUsed,
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'private, max-age=60',
      },
    }
  );
}
