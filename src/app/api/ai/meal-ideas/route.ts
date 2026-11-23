import { NextResponse } from 'next/server';
import {
  getServerAiConfig,
  callVisionChatCompletion,
  AiServiceError,
} from '@/lib/ai/openai-compat';
import {
  parseAiJsonResponse,
  AiMealIdeasResponseSchema,
  type AiMealIdea,
} from '@/lib/ai/schemas';
import { enrichMealItemsWithStaples } from '@/lib/foods/staples-search';
import { NO_STORE_HEADERS, requireSyncAuth } from '@/lib/auth/sync-auth';

export const maxDuration = 60;

function isFiniteNumber(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

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

  const { remaining, preferencePrompt, preference } = body as {
    remaining?: unknown;
    preferencePrompt?: unknown;
    preference?: unknown;
  };

  if (!remaining || typeof remaining !== 'object' || Array.isArray(remaining)) {
    return NextResponse.json(
      { error: 'Missing or invalid remaining macros object' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const rem = remaining as Record<string, unknown>;
  if (
    !isFiniteNumber(rem.calories) ||
    !isFiniteNumber(rem.protein) ||
    !isFiniteNumber(rem.carbs) ||
    !isFiniteNumber(rem.fat) ||
    (rem.fiber !== undefined && rem.fiber !== null && !isFiniteNumber(rem.fiber))
  ) {
    return NextResponse.json(
      {
        error:
          'Invalid remaining macros: calories, protein, carbs, fat (and optional fiber) must be finite numbers',
      },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const safeRemaining = {
    calories: Math.max(0, Math.round(rem.calories)),
    protein: Math.max(0, Math.round(rem.protein * 10) / 10),
    carbs: Math.max(0, Math.round(rem.carbs * 10) / 10),
    fat: Math.max(0, Math.round(rem.fat * 10) / 10),
    fiber: isFiniteNumber(rem.fiber) ? Math.max(0, Math.round(rem.fiber * 10) / 10) : 0,
  };

  const rawPref =
    typeof preferencePrompt === 'string'
      ? preferencePrompt
      : typeof preference === 'string'
        ? preference
        : '';
  const trimmedPreference = rawPref.trim();

  const config = getServerAiConfig();
  if (!config.isConfigured) {
    return NextResponse.json(
      { error: 'AI service is not configured. Please set server environment variables.' },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  const promptText = [
    'Output JSON immediately without extended thinking.',
    `Generate 3 to 4 practical, delicious whole-food and Filipino-friendly meal ideas tailored to fit this remaining daily macro budget: ${safeRemaining.calories} kcal, ${safeRemaining.protein}g protein, ${safeRemaining.carbs}g carbs, ${safeRemaining.fat}g fat, ${safeRemaining.fiber}g fiber.`,
    trimmedPreference
      ? `USER PREFERENCE / PANTRY NOTES (honor closely): "${trimmedPreference}".`
      : 'Include a practical mix of high-protein lutong bahay / Filipino-friendly staples and quick whole-food meals.',
    'Decompose each meal idea into non-overlapping whole-food/ingredient components with realistic gram weights so the summed items closely fit the remaining macro budget.',
    'For each idea provide: title (non-empty string), prepMinutes (number >= 0), summary (short 1-sentence description), and items[] where each item has name, grams (>0), per100g (calories, protein, carbs, fat, fiber in g), and optional microsPer100g (sodiumMg, potassiumMg, calciumMg, ironMg, magnesiumMg, zincMg, vitaminAMcg, vitaminCMg, vitaminDMcg, vitaminB6Mg, vitaminB12Mcg, folateMcg, sugarG, addedSugarG, saturatedFatG, cholesterolMg, caffeineMg, alcoholG per 100g).',
    'Estimate non-zero extended nutrients (sugarG, addedSugarG, saturatedFatG, cholesterolMg, caffeineMg, alcoholG) and core micronutrients in microsPer100g; omit keys equal to 0 (server backfills USDA micronutrients for standard whole foods).',
    'Return ONLY compact JSON matching this schema:',
    '{"ideas":[{"title":"Chicken Adobo & Garlic Rice Bowl","prepMinutes":15,"summary":"Savory high-protein chicken breast adobo with steamed rice.","items":[{"name":"Chicken Breast, Cooked","grams":180,"per100g":{"calories":165,"protein":31,"carbs":0,"fat":3.6,"fiber":0}}]}]}',
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
        temperature: 0.3,
        maxTokens: 3000,
        signal: request.signal,
      }
    );

    const parsed = parseAiJsonResponse(rawAiOutput, AiMealIdeasResponseSchema);
    const enrichedIdeas: AiMealIdea[] = await Promise.all(
      parsed.ideas.map(async (idea) => ({
        ...idea,
        items: await enrichMealItemsWithStaples(idea.items),
      }))
    );

    return NextResponse.json(
      { ideas: enrichedIdeas },
      { status: 200, headers: NO_STORE_HEADERS }
    );
  } catch (err: unknown) {
    if (err instanceof AiServiceError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status, headers: NO_STORE_HEADERS }
      );
    }
    const message = err instanceof Error ? err.message : 'Failed to generate meal ideas';
    return NextResponse.json(
      { error: message },
      { status: 422, headers: NO_STORE_HEADERS }
    );
  }
}
