import { NextResponse } from 'next/server';
import { getServerAiConfig, callVisionChatCompletion, AiServiceError } from '@/lib/ai/openai-compat';
import { parseAiJsonResponse, AiLabelOcrResponseSchema } from '@/lib/ai/schemas';
import { NO_STORE_HEADERS, requireSyncAuth } from '@/lib/auth/sync-auth';

export const maxDuration = 60;

export async function POST(request: Request) {
  const authError = requireSyncAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON request body' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json(
      { error: 'Request body must be a JSON object' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const { imageDataUrl } = body as { imageDataUrl?: string };

  if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:')) {
    return NextResponse.json(
      { error: 'Missing or invalid imageDataUrl: must be a valid base64 data URL' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const config = getServerAiConfig();
  if (!config.isConfigured) {
    return NextResponse.json(
      { error: 'AI service is not configured. Please set server environment variables.' },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  const promptText = [
    'Output JSON immediately without extended thinking.',
    'Extract nutrition facts from this label image: optional name, optional brand, servingSize (>0), servingUnit ("g"|"ml"|"serving"), calories, protein, carbs, fat, and optional fiber, sodiumMg, potassiumMg, calciumMg, ironMg, vitaminCMg, sugarG, addedSugarG, saturatedFatG, cholesterolMg, caffeineMg, alcoholG per serving.',
    'Omit optional fields if not visible on the label (do not use null). Use "g", "ml", or "serving" for servingUnit.',
    'Return ONLY a compact JSON object (NOT an array):',
    '{"name":"Product Name","brand":"Brand","servingSize":30,"servingUnit":"g","calories":150,"protein":5,"carbs":25,"fat":3,"fiber":2,"sodiumMg":140,"sugarG":8,"addedSugarG":6,"saturatedFatG":1,"cholesterolMg":15}',
  ].join('\n');

  try {
    const rawAiOutput = await callVisionChatCompletion(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            {
              type: 'image_url',
              image_url: {
                url: imageDataUrl,
              },
            },
          ],
        },
      ],
      {
        temperature: 0,
        maxTokens: 1500,
        signal: request.signal,
      }
    );

    const parsed = parseAiJsonResponse(rawAiOutput, AiLabelOcrResponseSchema);
    return NextResponse.json(parsed, { status: 200, headers: NO_STORE_HEADERS });
  } catch (err: unknown) {
    if (err instanceof AiServiceError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status, headers: NO_STORE_HEADERS }
      );
    }
    const message = err instanceof Error ? err.message : 'Failed to scan nutrition label';
    return NextResponse.json(
      { error: message },
      { status: 422, headers: NO_STORE_HEADERS }
    );
  }
}
