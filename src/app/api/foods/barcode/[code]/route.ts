import { NextRequest, NextResponse } from 'next/server';
import { normalizeBarcode } from '@/lib/foods/dedup';
import { lookupBarcodeLiveProviders } from '@/lib/foods/live-providers';
import { lookupServerCatalogBarcode } from '@/lib/foods/server-catalog';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ code: string }> | { code: string } }
): Promise<NextResponse> {
  const resolvedParams =
    context.params instanceof Promise ? await context.params : context.params;
  const rawCode = (resolvedParams?.code ?? '').trim();

  const normalized = normalizeBarcode(rawCode);
  const rawDigits = rawCode.replace(/\D+/g, '');
  if (!normalized && (rawDigits.length < 8 || rawDigits.length > 14)) {
    return NextResponse.json(
      {
        status: 'invalid',
        error: 'Invalid barcode format. Expected 8 to 14 numeric digits.',
        barcode: rawCode,
      },
      { status: 400 }
    );
  }

  const catalogHit = await lookupServerCatalogBarcode(rawCode);
  if (catalogHit) {
    return NextResponse.json(
      {
        status: 'hit',
        item: catalogHit,
        source: 'catalog' as const,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, max-age=3600',
        },
      }
    );
  }

  const { searchParams } = new URL(request.url);
  const offlineParam = (searchParams.get('offline') ?? '0').trim().toLowerCase();
  const isOffline = offlineParam === '1' || offlineParam === 'true';

  if (!isOffline) {
    const liveHit = await lookupBarcodeLiveProviders(rawCode, {
      signal: request.signal,
    });
    if (liveHit) {
      return NextResponse.json(
        {
          status: 'hit',
          item: liveHit,
          source: 'live' as const,
        },
        {
          status: 200,
          headers: {
            'Cache-Control': 'public, max-age=1800',
          },
        }
      );
    }
  }

  return NextResponse.json(
    {
      status: 'missing',
      barcode: normalized ?? rawDigits,
    },
    {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}
