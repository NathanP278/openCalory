import { NextResponse } from 'next/server';
import { getActiveCatalogManifest } from '@/lib/foods/server-catalog';

export const runtime = 'nodejs';

export async function GET() {
  const manifest = await getActiveCatalogManifest();
  if (!manifest) {
    return NextResponse.json(
      { error: 'Food catalog manifest not found.' },
      { status: 404 }
    );
  }

  return NextResponse.json(manifest, {
    status: 200,
    headers: {
      'Cache-Control': 'public, max-age=300',
    },
  });
}
