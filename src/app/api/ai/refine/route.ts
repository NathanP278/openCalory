import { NextResponse } from 'next/server';
import { getServerAiConfig, callVisionChatCompletion, AiServiceError } from '@/lib/ai/openai-compat';
import { parseAiJsonResponse, AiMealScanResponseSchema } from '@/lib/ai/schemas';
import { enrichMealItemsWithStaples } from '@/lib/foods/staples-search';
import { NO_STORE_HEADERS, requireSyncAuth } from '@/lib/auth/sync-auth';
import type { Micronutrients } from '@/types/nutrition';

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

  const { items, instruction, contextPrompt } = body as {
    items?: unknown[];
    instruction?: string;
    contextPrompt?: string;
  };

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json(
      { error: 'Missing or invalid items: must be a non-empty array of meal items' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
    return NextResponse.json(
      { error: 'Missing or empty refinement instruction' },
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

  const priorMicrosByName = new Map<string, Micronutrients>();
  const slimItems = items.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const it = raw as {
      name?: unknown;
      grams?: unknown;
      per100g?: unknown;
      microsPer100g?: Micronutrients;
    };
    if (
      typeof it.name === 'string' &&
      it.microsPer100g &&
      typeof it.microsPer100g === 'object'
    ) {
      priorMicrosByName.set(it.name.trim().toLowerCase(), it.microsPer100g);
    }
    return {
      name: it.name,
      grams: it.grams,
      per100g: it.per100g,
    };
  });

  const promptText = [
    'Output JSON immediately without extended thinking.',
    'Refine this meal nutrition draft based on user instruction.',
    `Draft: ${JSON.stringify(slimItems)}`,
    `Instruction: "${instruction.trim()}"`,
    contextPrompt ? `Prep context: "${contextPrompt.trim()}"` : '',
    'Apply requested gram edits, additions, removals, or density updates across non-overlapping items (grams > 0).',
    'Every item MUST include per100g (calories, protein, carbs, fat, fiber) and microsPer100g (estimated per 100g for applicable keys: sodiumMg, potassiumMg, calciumMg, ironMg, magnesiumMg, zincMg, vitaminAMcg, vitaminCMg, vitaminDMcg, vitaminB6Mg, vitaminB12Mcg, folateMcg, sugarG, addedSugarG, saturatedFatG, cholesterolMg, caffeineMg, alcoholG). Always estimate non-zero vitamins, minerals, and extended nutrients in microsPer100g for new or modified items; omit keys equal to 0.',
    'Return ONLY compact JSON matching this schema:',
    '{"items":[{"name":"Chicken Breast, Grilled","grams":150,"per100g":{"calories":165,"protein":31,"carbs":0,"fat":3.6,"fiber":0},"microsPer100g":{"sodiumMg":74,"potassiumMg":256,"ironMg":1,"vitaminB6Mg":0.6,"saturatedFatG":1,"cholesterolMg":85}}]}',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const rawAiOutput = await callVisionChatCompletion(
      [
        {
          role: 'user',
          content: promptText,
        },
      ],
      {
        temperature: 0,
        maxTokens: 3200,
        signal: request.signal,
      }
    );

    const parsed = parseAiJsonResponse(rawAiOutput, AiMealScanResponseSchema);
    const mergedItems = parsed.items.map((item) => {
      const prior = priorMicrosByName.get(item.name.trim().toLowerCase());
      if (!prior) return item;
      return {
        ...item,
        microsPer100g: {
          ...prior,
          ...(item.microsPer100g ?? {}),
        },
      };
    });
    const enrichedItems = await enrichMealItemsWithStaples(mergedItems);
    return NextResponse.json({ items: enrichedItems }, { status: 200, headers: NO_STORE_HEADERS });
  } catch (err: unknown) {
    if (err instanceof AiServiceError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status, headers: NO_STORE_HEADERS }
      );
    }
    const message = err instanceof Error ? err.message : 'Failed to refine meal draft';
    return NextResponse.json(
      { error: message },
      { status: 422, headers: NO_STORE_HEADERS }
    );
  }
}
