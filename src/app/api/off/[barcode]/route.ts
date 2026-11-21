import { NextRequest, NextResponse } from 'next/server';

const OFF_BASE_URL = 'https://world.openfoodfacts.org/api/v2/product';
const OFF_FIELDS =
  'product_name,product_name_en,generic_name,brands,brand_owner,nutriments,product_quantity_unit,serving_quantity_unit,serving_quantity,serving_size';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ barcode: string }> | { barcode: string } }
): Promise<NextResponse> {
  const resolvedParams =
    context.params instanceof Promise ? await context.params : context.params;
  const rawBarcode = resolvedParams?.barcode || '';
  const barcode = rawBarcode.trim();

  // Validate barcode: 4 to 18 numeric digits
  if (!/^\d{4,18}$/.test(barcode)) {
    return NextResponse.json(
      { error: 'Invalid barcode format. Expected 4 to 18 numeric digits.' },
      {
        status: 400,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }

  const targetUrl = `${OFF_BASE_URL}/${encodeURIComponent(barcode)}.json?fields=${OFF_FIELDS}`;

  try {
    const upstreamRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'openCalory/1.0',
      },
      next: { revalidate: 86400 },
      signal: AbortSignal.timeout(8000),
    });

    if (!upstreamRes.ok) {
      const errorText = await upstreamRes.text().catch(() => '');
      return NextResponse.json(
        {
          error: `Open Food Facts API returned error status ${upstreamRes.status}`,
          details: errorText,
        },
        {
          status: upstreamRes.status,
          headers: { 'Cache-Control': 'no-store' },
        }
      );
    }

    const data = await upstreamRes.json();

    if (data && typeof data === 'object' && (data as { status?: number }).status === 1) {
      return NextResponse.json(data, {
        status: 200,
        headers: {
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    // Status === 0 (product not found) or missing status
    return NextResponse.json(data, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: isTimeout
          ? 'Upstream Open Food Facts request timed out'
          : 'Failed to communicate with Open Food Facts API',
        message,
      },
      {
        status: isTimeout ? 504 : 502,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}
