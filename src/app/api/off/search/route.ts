import { NextRequest, NextResponse } from 'next/server';

const OFF_SEARCH_FIELDS = [
  'code',
  'product_name',
  'product_name_en',
  'generic_name',
  'brands',
  'brand_owner',
  'countries_tags',
  'nutriments',
  'product_quantity_unit',
  'serving_quantity_unit',
  'serving_quantity',
  'serving_size',
].join(',');

const REQUEST_TIMEOUT_MS = 8000;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get('query') ?? searchParams.get('q') ?? '').trim();

  if (!query) {
    return NextResponse.json(
      { error: 'Missing required search query parameter.' },
      { status: 400 }
    );
  }

  const countryParam = (searchParams.get('country') ?? 'world').toLowerCase();
  const country = countryParam === 'ph' ? 'ph' : 'world';
  const rawPageSize = Number(searchParams.get('page_size') ?? searchParams.get('pageSize') ?? '12');
  const pageSize = Number.isFinite(rawPageSize)
    ? Math.max(1, Math.min(50, Math.round(rawPageSize)))
    : 12;

  const host = country === 'ph' ? 'ph.openfoodfacts.org' : 'world.openfoodfacts.org';
  const targetUrl = new URL(`https://${host}/cgi/search.pl`);
  targetUrl.searchParams.set('search_terms', query);
  targetUrl.searchParams.set('search_simple', '1');
  targetUrl.searchParams.set('action', 'process');
  targetUrl.searchParams.set('json', '1');
  targetUrl.searchParams.set('page_size', String(pageSize));
  targetUrl.searchParams.set('fields', OFF_SEARCH_FIELDS);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamRes = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'openCalory/1.0 (https://opencalory.local)',
        Accept: 'application/json',
      },
      signal: controller.signal,
      next: { revalidate: 3600 },
    });

    if (!upstreamRes.ok) {
      return NextResponse.json(
        { error: `Open Food Facts upstream error: ${upstreamRes.status}` },
        { status: upstreamRes.status === 429 ? 429 : 502 }
      );
    }

    const data = await upstreamRes.json();
    return NextResponse.json(data, {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return NextResponse.json(
      { error: isAbort ? 'Open Food Facts request timed out.' : 'Failed to fetch from Open Food Facts.' },
      { status: isAbort ? 504 : 502 }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
