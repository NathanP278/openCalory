import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import {
  AiMealScanResponseSchema,
  AiLabelOcrResponseSchema,
  parseAiJsonResponse,
} from '../schemas';
import {
  getServerAiConfig,
  normalizeChatEndpoint,
  callVisionChatCompletion,
  clearAiRuntimeCaches,
} from '../openai-compat';
import { dynamic, GET as getHealth } from '@/app/api/ai/health/route';
import { POST as postMealScan } from '@/app/api/ai/meal-scan/route';
import { POST as postRefine } from '@/app/api/ai/refine/route';
import { POST as postLabelOcr } from '@/app/api/ai/label-ocr/route';
import { AiHealthStatusCard } from '@/components/settings/ai-health-status-card';

describe('Task 9: AI Schemas & JSON Parser', () => {
  it('strips markdown code fences and validates non-overlapping meal items', () => {
    const raw =
      '```json\n{"items":[{"name":"Grilled Chicken Breast","grams":180,"per100g":{"calories":165,"protein":31,"carbs":0,"fat":3.6,"fiber":0}}]}\n```';
    const parsed = parseAiJsonResponse(raw, AiMealScanResponseSchema);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].name).toBe('Grilled Chicken Breast');
    expect(parsed.items[0].grams).toBe(180);
    expect(parsed.items[0].per100g.protein).toBe(31);
  });

  it('strips generic markdown code fences without language tag and handles surrounding text', () => {
    const raw =
      'Here is the extracted meal info:\n```\n{"items":[{"name":"White Rice","grams":150,"per100g":{"calories":130,"protein":2.7,"carbs":28.2,"fat":0.3}}]}\n```\nEnjoy your meal!';
    const parsed = parseAiJsonResponse(raw, AiMealScanResponseSchema);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].name).toBe('White Rice');
    expect(parsed.items[0].grams).toBe(150);
  });

  it('parses valid JSON with commentary inside markdown code fence', () => {
    const raw =
      '```json\nHere is the nutritional breakdown you requested:\n{"items":[{"name":"Baked Salmon","grams":150,"per100g":{"calories":206,"protein":22,"carbs":0,"fat":12,"fiber":0}}]}\nNote: estimated values\n```';
    const parsed = parseAiJsonResponse(raw, AiMealScanResponseSchema);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].name).toBe('Baked Salmon');
    expect(parsed.items[0].grams).toBe(150);
  });

  it('parses raw JSON strings without code fences', () => {
    const raw =
      '{"items":[{"name":"Olive Oil","grams":10,"per100g":{"calories":884,"protein":0,"carbs":0,"fat":100}}]}';
    const parsed = parseAiJsonResponse(raw, AiMealScanResponseSchema);
    expect(parsed.items[0].name).toBe('Olive Oil');
    expect(parsed.items[0].grams).toBe(10);
  });

    it('rejects zero-gram or missing-macro malformed AI payloads', () => {
    expect(() =>
      parseAiJsonResponse('{"items":[{"name":"Plate","grams":0}]}', AiMealScanResponseSchema)
    ).toThrow();
    expect(() =>
      parseAiJsonResponse('{"items":[{"name":"Empty","grams":-50,"per100g":{"calories":100,"protein":1,"carbs":1,"fat":1}}]}', AiMealScanResponseSchema)
    ).toThrow();
    expect(() =>
      parseAiJsonResponse('{"items":[{"name":"","grams":100,"per100g":{"calories":100,"protein":1,"carbs":1,"fat":1}}]}', AiMealScanResponseSchema)
    ).toThrow();
    expect(() =>
      parseAiJsonResponse('{"items":[]}', AiMealScanResponseSchema)
    ).toThrow();
    expect(() =>
      parseAiJsonResponse(
        '{"items":[{"name":"Salad","grams":100,"per100g":{"calories":50,"protein":2,"carbs":8,"fat":1,"fiber":3},"microsPer100g":{"sodiumMg":-10}}]}',
        AiMealScanResponseSchema
      )
    ).toThrow();
    expect(() => parseAiJsonResponse('not json', AiLabelOcrResponseSchema)).toThrow();
  });

  it('parses fiber and all 12 micronutrients in microsPer100g and normalizes null values', () => {
    const raw = JSON.stringify({
      items: [
        {
          name: 'Spinach & Salmon Bowl',
          grams: 200,
          per100g: { calories: 150, protein: 16, carbs: 4, fat: 8, fiber: 2.5 },
          microsPer100g: {
            sodiumMg: 120,
            potassiumMg: 450,
            calciumMg: 80,
            ironMg: 2.1,
            magnesiumMg: 60,
            zincMg: 0.9,
            vitaminAMcg: 350,
            vitaminCMg: 18,
            vitaminDMcg: 5.5,
            vitaminB6Mg: 0.4,
            vitaminB12Mcg: 1.8,
            folateMcg: 95,
          },
        },
        {
          name: 'Plain Water',
          grams: 100,
          per100g: { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: null },
          microsPer100g: { sodiumMg: null, calciumMg: 2 },
        },
      ],
    });
    const parsed = parseAiJsonResponse(raw, AiMealScanResponseSchema);
    expect(parsed.items[0].per100g.fiber).toBe(2.5);
    expect(parsed.items[0].microsPer100g).toEqual({
      sodiumMg: 120,
      potassiumMg: 450,
      calciumMg: 80,
      ironMg: 2.1,
      magnesiumMg: 60,
      zincMg: 0.9,
      vitaminAMcg: 350,
      vitaminCMg: 18,
      vitaminDMcg: 5.5,
      vitaminB6Mg: 0.4,
      vitaminB12Mcg: 1.8,
      folateMcg: 95,
    });
    expect(parsed.items[1].per100g.fiber).toBe(0);
    expect(parsed.items[1].microsPer100g?.sodiumMg).toBeUndefined();
    expect(parsed.items[1].microsPer100g?.calciumMg).toBe(2);
  });

  it('validates AiLabelOcrResponseSchema matching Task 8 -> Task 9 contract', () => {
    const validOcr = JSON.stringify({
      name: 'Greek Yogurt 0%',
      brand: 'Chobani',
      servingSize: 170,
      servingUnit: 'g',
      calories: 100,
      protein: 18,
      carbs: 6,
      fat: 0,
      fiber: 0,
      sodiumMg: 65,
    });
    const parsed = parseAiJsonResponse(validOcr, AiLabelOcrResponseSchema);
    expect(parsed.servingSize).toBe(170);
    expect(parsed.servingUnit).toBe('g');
    expect(parsed.protein).toBe(18);

    // Rejects invalid servingUnit
    const invalidUnit = JSON.stringify({
      servingSize: 100,
      servingUnit: 'oz',
      calories: 100,
      protein: 10,
      carbs: 10,
      fat: 2,
    });
    expect(() => parseAiJsonResponse(invalidUnit, AiLabelOcrResponseSchema)).toThrow();

    // Rejects zero servingSize
    const zeroServing = JSON.stringify({
      servingSize: 0,
      servingUnit: 'g',
      calories: 100,
      protein: 10,
      carbs: 10,
      fat: 2,
    });
    expect(() => parseAiJsonResponse(zeroServing, AiLabelOcrResponseSchema)).toThrow();
  });

  it('normalizes bare top-level JSON arrays and flattened micros in AiMealScanResponseSchema', () => {
    const bareArrayRaw = JSON.stringify([
      {
        name: 'Brewed Americano Coffee',
        grams: 240,
        per100g: {
          calories: 2,
          protein: 0.1,
          carbs: 0,
          fat: 0,
          fiber: 0,
          caffeineMg: 40,
        },
      },
      {
        name: "McDonald's Vanilla Soft Serve Ice Cream",
        grams: 170,
        per100g: {
          calories: 169,
          protein: 3.5,
          carbs: 26.5,
          fat: 5.3,
          fiber: 0,
          sugarG: 22.4,
          addedSugarG: 20,
          saturatedFatG: 3.5,
          cholesterolMg: 20,
        },
      },
    ]);

    const parsed = parseAiJsonResponse(bareArrayRaw, AiMealScanResponseSchema);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].name).toBe('Brewed Americano Coffee');
    expect(parsed.items[0].microsPer100g?.caffeineMg).toBe(40);
    expect(parsed.items[1].microsPer100g?.sugarG).toBe(22.4);
    expect(parsed.items[1].microsPer100g?.addedSugarG).toBe(20);
    expect(parsed.items[1].microsPer100g?.saturatedFatG).toBe(3.5);
    expect(parsed.items[1].microsPer100g?.cholesterolMg).toBe(20);
  });

  it('normalizes null name/brand, unit casing/aliases, numeric strings, and array wrappers in AiLabelOcrResponseSchema', () => {
    const labelWithNullsAndCasing = JSON.stringify({
      name: null,
      brand: null,
      servingSize: '250',
      servingUnit: 'mL',
      calories: '120',
      protein: null,
      carbs: 30,
      fat: null,
      sugarG: '28',
      sodiumMg: 45,
    });

    const parsed = parseAiJsonResponse(labelWithNullsAndCasing, AiLabelOcrResponseSchema);
    expect(parsed.name).toBeUndefined();
    expect(parsed.brand).toBeUndefined();
    expect(parsed.servingSize).toBe(250);
    expect(parsed.servingUnit).toBe('ml');
    expect(parsed.calories).toBe(120);
    expect(parsed.protein).toBe(0);
    expect(parsed.carbs).toBe(30);
    expect(parsed.fat).toBe(0);
    expect(parsed.sugarG).toBe(28);

    const wrappedInArray = JSON.stringify([
      {
        name: 'Oat Cereal',
        brand: 'Harvest',
        servingSize: 45,
        servingUnit: 'grams',
        calories: 180,
        protein: 6,
        carbs: 33,
        fat: 3.5,
      },
    ]);
    const unwrapped = parseAiJsonResponse(wrappedInArray, AiLabelOcrResponseSchema);
    expect(unwrapped.name).toBe('Oat Cereal');
    expect(unwrapped.servingUnit).toBe('g');
  });
});

describe('Task 9: OpenAI-Compatible Client Helper', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    clearAiRuntimeCaches();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('correctly reads and normalizes server-side env vars', () => {
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL;
    delete process.env.AI_CUSTOM_HEADERS;

    const unconfigured = getServerAiConfig();
    expect(unconfigured.isConfigured).toBe(false);

    process.env.AI_BASE_URL = 'https://api.openai.com/v1/';
    process.env.AI_API_KEY = 'sk-test-secret-key-12345';
    process.env.AI_MODEL = 'gpt-4o-mini';
    process.env.AI_CUSTOM_HEADERS = '{"HTTP-Referer":"https://opencalory.app"}';

    const configured = getServerAiConfig();
    expect(configured.isConfigured).toBe(true);
    expect(configured.baseUrl).toBe('https://api.openai.com/v1/');
    expect(configured.model).toBe('gpt-4o-mini');
    expect(configured.customHeaders['HTTP-Referer']).toBe('https://opencalory.app');
  });

  it('safely handles invalid AI_CUSTOM_HEADERS JSON', () => {
    process.env.AI_BASE_URL = 'https://api.openai.com/v1';
    process.env.AI_API_KEY = 'sk-test';
    process.env.AI_MODEL = 'gpt-4o';
    process.env.AI_CUSTOM_HEADERS = 'invalid-json';

    const config = getServerAiConfig();
    expect(config.customHeaders).toEqual({});
  });

  it('normalizes chat completions endpoints without duplicating /chat/completions', () => {
    expect(normalizeChatEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions');
    expect(normalizeChatEndpoint('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/chat/completions');
    expect(normalizeChatEndpoint('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
    expect(normalizeChatEndpoint('https://api.openai.com/v1/chat/completions/')).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('throws 503 AiServiceError when unconfigured', async () => {
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL;

    await expect(callVisionChatCompletion([{ role: 'user', content: 'hello' }]))
      .rejects.toThrow(/not configured/i);
  });

  it('sends vision messages with Bearer auth and parses string content', async () => {
    process.env.AI_BASE_URL = 'https://api.openai.com/v1';
    process.env.AI_API_KEY = 'sk-test-secret';
    process.env.AI_MODEL = 'gpt-4o';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"items":[{"name":"Oatmeal","grams":60,"per100g":{"calories":389,"protein":16.9,"carbs":66.3,"fat":6.9}}]}',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callVisionChatCompletion([{ role: 'user', content: 'test' }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test-secret');
    expect(result).toContain('Oatmeal');
  });

  it('supports message.content returned as array of text parts', async () => {
    process.env.AI_BASE_URL = 'https://api.openai.com/v1';
    process.env.AI_API_KEY = 'sk-test-secret';
    process.env.AI_MODEL = 'gpt-4o';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: '{"items":[{"name":"Apple","grams":150,' },
                { type: 'text', text: '"per100g":{"calories":52,"protein":0.3,"carbs":13.8,"fat":0.2}}]}' },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callVisionChatCompletion([{ role: 'user', content: 'test' }]);
    expect(result).toContain('Apple');
  });

  it('falls back seamlessly if provider returns 400 rejecting response_format', async () => {
    process.env.AI_BASE_URL = 'https://ollama.local/v1';
    process.env.AI_API_KEY = 'ollama';
    process.env.AI_MODEL = 'llava';

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      callCount++;
      const body = JSON.parse(init.body);
      if (body.response_format) {
        // Provider rejects response_format
        return {
          ok: false,
          status: 400,
          text: async () => 'Provider error: response_format is not supported',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: '{"items":[{"name":"Banana","grams":118,"per100g":{"calories":89,"protein":1.1,"carbs":22.8,"fat":0.3}}]}',
              },
            },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callVisionChatCompletion([{ role: 'user', content: 'test' }]);
    expect(callCount).toBe(2);
    expect(result).toContain('Banana');
  });

  it('NEVER leaks AI_API_KEY in error messages', async () => {
    const SECRET = 'sk-super-secret-high-entropy-token-xyz987';
    process.env.AI_BASE_URL = 'https://broken-proxy.local/v1';
    process.env.AI_API_KEY = SECRET;
    process.env.AI_MODEL = 'test-model';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => `Upstream error with Authorization token ${SECRET} failed`,
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(callVisionChatCompletion([{ role: 'user', content: 'ping' }]))
      .rejects.toThrowError(expect.not.stringContaining(SECRET));
  });

  it('redacts both AI_API_KEY and sensitive AI_CUSTOM_HEADERS values in error responses', async () => {
    const SECRET_API_KEY = 'sk-upstream-secret-key-99999';
    const GATEWAY_SECRET = 'gateway-bearer-secret-token-88888';
    process.env.AI_BASE_URL = 'https://proxy.local/v1';
    process.env.AI_API_KEY = SECRET_API_KEY;
    process.env.AI_MODEL = 'test-model';
    process.env.AI_CUSTOM_HEADERS = JSON.stringify({
      'X-Gateway-Auth': GATEWAY_SECRET,
      'X-Short': 'abc',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => `Upstream error: ${SECRET_API_KEY} rejected by gateway ${GATEWAY_SECRET}`,
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(callVisionChatCompletion([{ role: 'user', content: 'test' }]))
      .rejects.toThrowError(expect.not.stringContaining(SECRET_API_KEY));

    await expect(callVisionChatCompletion([{ role: 'user', content: 'test' }]))
      .rejects.toThrowError(expect.not.stringContaining(GATEWAY_SECRET));
  });

  it('caches 400 response_format rejection per endpoint+model to skip duplicate retries', async () => {
    process.env.AI_BASE_URL = 'https://no-json-mode.local/v1';
    process.env.AI_API_KEY = 'sk-test';
    process.env.AI_MODEL = 'legacy-vision-v1';

    let fetchCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      fetchCount++;
      const body = JSON.parse(init.body);
      if (body.response_format) {
        return {
          ok: false,
          status: 400,
          text: async () => 'response_format json_object is not supported',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"items":[]}' } }],
        }),
      };
    });
    vi.stubGlobal('fetch', mockFetch);

    // Call 1 probes response_format -> 400 -> fallback without response_format (2 fetches)
    await callVisionChatCompletion([{ role: 'user', content: 'meal 1' }]);
    expect(fetchCount).toBe(2);

    // Call 2 remembers incompatibility and skips response_format directly (1 fetch)
    await callVisionChatCompletion([{ role: 'user', content: 'meal 2' }]);
    expect(fetchCount).toBe(3);
  });

  it('deduplicates concurrent identical requests and serves cached responses when enableCache is true', async () => {
    process.env.AI_BASE_URL = 'https://cache-test.local/v1';
    process.env.AI_API_KEY = 'sk-test';
    process.env.AI_MODEL = 'gemini-flash-lite';

    let resolveUpstream!: (val: unknown) => void;
    const mockFetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpstream = resolve;
        })
    );
    vi.stubGlobal('fetch', mockFetch);

    const messages = [{ role: 'user' as const, content: 'same meal image' }];
    const p1 = callVisionChatCompletion(messages, { enableCache: true });
    const p2 = callVisionChatCompletion(messages, { enableCache: true });

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    resolveUpstream({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"items":[{"name":"Egg"}]}' } }],
      }),
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toContain('Egg');
    expect(r2).toBe(r1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Subsequent call hits in-memory response cache with 0 extra fetches
    const r3 = await callVisionChatCompletion(messages, { enableCache: true });
    expect(r3).toBe(r1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Clearing caches forces a fresh upstream call
    clearAiRuntimeCaches();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"items":[{"name":"Egg v2"}]}' } }],
        }),
      })
    );
    const r4 = await callVisionChatCompletion(messages, { enableCache: true });
    expect(r4).toContain('Egg v2');
  });

  it('retries transient 503/429 responses and succeeds on subsequent attempt', async () => {
    process.env.AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
    process.env.AI_API_KEY = 'AQ.test-key';
    process.env.AI_MODEL = 'gemini-3.8-flash';

    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        return {
          ok: false,
          status: 503,
          text: async () => 'This model is currently experiencing high demand.',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'OK' } }],
        }),
      };
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callVisionChatCompletion(
      [{ role: 'user', content: 'Respond with OK' }],
      { responseFormat: false }
    );
    expect(attempts).toBe(2);
    expect(result).toBe('OK');
  });

  it('builds priority-ordered candidates from AI_FALLBACK_API_KEYS and AI_FALLBACK_MODELS', () => {
    process.env.AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
    process.env.AI_API_KEY = 'key-1';
    process.env.AI_FALLBACK_API_KEYS = 'key-2';
    process.env.AI_MODEL = 'gemini-3.8-flash';
    process.env.AI_FALLBACK_MODELS = 'gemma-4-31b-it, gemini-3.5-flash-lite';

    const config = getServerAiConfig();
    expect(config.isConfigured).toBe(true);
    expect(config.apiKeys).toEqual(['key-1', 'key-2']);
    expect(config.models).toEqual(['gemini-3.8-flash', 'gemma-4-31b-it', 'gemini-3.5-flash-lite']);
    expect(config.candidates.map((c) => `${c.apiKey}:${c.model}`)).toEqual([
      'key-1:gemini-3.8-flash',
      'key-1:gemma-4-31b-it',
      'key-1:gemini-3.5-flash-lite',
      'key-2:gemini-3.8-flash',
      'key-2:gemma-4-31b-it',
      'key-2:gemini-3.5-flash-lite',
    ]);
  });

  it('pings all candidates in parallel and selects highest-priority healthy model', async () => {
    process.env.AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
    process.env.AI_API_KEY = 'key-1';
    process.env.AI_FALLBACK_API_KEYS = 'key-2';
    process.env.AI_MODEL = 'gemini-3.8-flash';
    process.env.AI_FALLBACK_MODELS = 'gemma-4-31b-it,gemini-3.5-flash-lite';

    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      const body = JSON.parse(init.body as string);
      const isPing = body.max_tokens === 1 && body.messages?.[0]?.content === 'OK';

      if (isPing) {
        // key-1 primary is 503, key-1 secondary (gemma-4-31b-it) is healthy!
        if (auth === 'Bearer key-1' && body.model === 'gemini-3.8-flash') {
          return { ok: false, status: 503, text: async () => 'UNAVAILABLE' };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
        };
      }

      // Actual vision/chat request
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: `served-by:${auth}:${body.model}` } }],
        }),
      };
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callVisionChatCompletion([{ role: 'user', content: 'Scan meal' }]);
    expect(result).toBe('served-by:Bearer key-1:gemma-4-31b-it');

    // Subsequent call reuses cached healthy candidate without re-pinging
    const callCountAfterFirst = mockFetch.mock.calls.length;
    const result2 = await callVisionChatCompletion([{ role: 'user', content: 'Scan meal 2' }]);
    expect(result2).toBe('served-by:Bearer key-1:gemma-4-31b-it');
    expect(mockFetch.mock.calls.length).toBe(callCountAfterFirst + 1);
  });

  it('falls back to second API key when all first-key models fail ping, without leaking keys', async () => {
    const KEY1 = 'AQ.secret-primary-key-11111';
    const KEY2 = 'AQ.secret-fallback-key-22222';
    process.env.AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
    process.env.AI_API_KEY = KEY1;
    process.env.AI_FALLBACK_API_KEYS = KEY2;
    process.env.AI_MODEL = 'gemini-3.8-flash';
    process.env.AI_FALLBACK_MODELS = 'gemma-4-31b-it';

    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      const body = JSON.parse(init.body as string);
      const isPing = body.max_tokens === 1 && body.messages?.[0]?.content === 'OK';

      if (auth === `Bearer ${KEY1}`) {
        return { ok: false, status: 429, text: async () => `Quota exceeded for ${KEY1}` };
      }
      if (isPing) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: `ok:${body.model}` } }],
        }),
      };
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callVisionChatCompletion([{ role: 'user', content: 'Scan meal' }]);
    expect(result).toBe('ok:gemini-3.8-flash');
  });

  it('redacts all primary and fallback API keys if every candidate fails', async () => {
    const KEY1 = 'AQ.secret-primary-key-33333';
    const KEY2 = 'AQ.secret-fallback-key-44444';
    process.env.AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
    process.env.AI_API_KEY = KEY1;
    process.env.AI_FALLBACK_API_KEYS = KEY2;
    process.env.AI_MODEL = 'gemini-3.8-flash';
    process.env.AI_FALLBACK_MODELS = 'gemma-4-31b-it';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url, init) => {
        const auth = (init.headers as Record<string, string>).Authorization;
        return { ok: false, status: 503, text: async () => `Error with ${auth}` };
      })
    );

    const promise = callVisionChatCompletion([{ role: 'user', content: 'Scan meal' }]);
    await expect(promise).rejects.toThrowError(expect.not.stringContaining(KEY1));
    await expect(promise).rejects.toThrowError(expect.not.stringContaining(KEY2));
  });
});

describe('Task 9: Route Handlers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    clearAiRuntimeCaches();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('GET /api/ai/health', () => {
    it('exports dynamic = "force-dynamic" to ensure fresh runtime evaluation', () => {
      expect(dynamic).toBe('force-dynamic');
    });

    it('returns 200 { configured: false, model: "", reachable: false } when unconfigured', async () => {
      delete process.env.AI_BASE_URL;
      delete process.env.AI_API_KEY;
      delete process.env.AI_MODEL;

      const res = await getHealth();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ configured: false, model: '', reachable: false });
      expect(res.headers.get('Cache-Control')).toContain('no-store');
      expect(JSON.stringify(data)).not.toContain('API_KEY');
    });

    it('returns reachable: true when upstream responds ok', async () => {
      process.env.AI_BASE_URL = 'https://api.openai.com/v1';
      process.env.AI_API_KEY = 'sk-secret';
      process.env.AI_MODEL = 'gpt-4o';

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'OK' } }],
        }),
      }));

      const res = await getHealth();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.configured).toBe(true);
      expect(data.model).toBe('gpt-4o');
      expect(data.reachable).toBe(true);
    });

    it('returns reachable: false without leaking secret when upstream fails', async () => {
      const SECRET = 'sk-super-secret-key-456';
      process.env.AI_BASE_URL = 'https://api.openai.com/v1';
      process.env.AI_API_KEY = SECRET;
      process.env.AI_MODEL = 'gpt-4o';

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => `Invalid key ${SECRET}`,
      }));

      const res = await getHealth();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.configured).toBe(true);
      expect(data.reachable).toBe(false);
      expect(data.error).toBeDefined();
      expect(data.error).not.toContain(SECRET);
    });
  });

  describe('POST /api/ai/meal-scan', () => {
    it('returns 400 when imageDataUrl is missing', async () => {
      const req = new Request('http://localhost/api/ai/meal-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const res = await postMealScan(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it('returns 503 when server AI is unconfigured', async () => {
      delete process.env.AI_BASE_URL;
      delete process.env.AI_API_KEY;
      delete process.env.AI_MODEL;

      const req = new Request('http://localhost/api/ai/meal-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl: 'data:image/jpeg;base64,abc123' }),
      });
      const res = await postMealScan(req);
      expect(res.status).toBe(503);
    });

    it('decomposes composite meal into non-overlapping items with per100g density and grams', async () => {
      process.env.AI_BASE_URL = 'https://api.openai.com/v1';
      process.env.AI_API_KEY = 'sk-key';
      process.env.AI_MODEL = 'gpt-4o';

      const mockResponse = {
        items: [
          {
            name: 'Grilled Salmon Fillet',
            grams: 200,
            per100g: { calories: 208, protein: 20, carbs: 0, fat: 13, fiber: 0 },
          },
          {
            name: 'Steamed Asparagus',
            grams: 100,
            per100g: { calories: 20, protein: 2.2, carbs: 3.9, fat: 0.1, fiber: 2.1 },
          },
        ],
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(mockResponse) } }],
        }),
      }));

      const req = new Request('http://localhost/api/ai/meal-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl: 'data:image/jpeg;base64,salmon-asparagus',
          contextPrompt: 'cooked in 1 tsp olive oil',
        }),
      });

      const res = await postMealScan(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.items).toHaveLength(2);
      expect(data.items[0].name).toBe('Grilled Salmon Fillet');
      expect(data.items[0].grams).toBe(200);
      expect(data.items[1].name).toBe('Steamed Asparagus');
    });

    it('instructs AI to estimate fiber and all 12 micronutrients and returns microsPer100g', async () => {
      process.env.AI_BASE_URL = 'https://api.openai.com/v1';
      process.env.AI_API_KEY = 'sk-key';
      process.env.AI_MODEL = 'gpt-4o';

      const mockMicros = {
        sodiumMg: 59,
        potassiumMg: 363,
        calciumMg: 9,
        ironMg: 0.3,
        magnesiumMg: 27,
        zincMg: 0.4,
        vitaminAMcg: 12,
        vitaminCMg: 0,
        vitaminDMcg: 11,
        vitaminB6Mg: 0.6,
        vitaminB12Mcg: 3.2,
        folateMcg: 25,
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      name: 'Grilled Salmon',
                      grams: 150,
                      per100g: { calories: 208, protein: 20, carbs: 0, fat: 13, fiber: 0 },
                      microsPer100g: mockMicros,
                    },
                  ],
                }),
              },
            },
          ],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const req = new Request('http://localhost/api/ai/meal-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl: 'data:image/jpeg;base64,salmon' }),
      });

      const res = await postMealScan(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.items[0].microsPer100g).toEqual(mockMicros);

      // Verify prompt includes fiber and all 12 micronutrient keys
      const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      const promptText = sentBody.messages[0].content[0].text as string;
      for (const key of [
        'fiber',
        'sodiumMg',
        'potassiumMg',
        'calciumMg',
        'ironMg',
        'magnesiumMg',
        'zincMg',
        'vitaminAMcg',
        'vitaminCMg',
        'vitaminDMcg',
        'vitaminB6Mg',
        'vitaminB12Mcg',
        'folateMcg',
      ]) {
        expect(promptText).toContain(key);
      }
    });

    it('accepts text-only contextPrompt without imageDataUrl, returns 400 when both are empty or imageDataUrl is invalid, and preserves extended nutrients', async () => {
      process.env.AI_BASE_URL = 'https://api.openai.com/v1';
      process.env.AI_API_KEY = 'sk-key';
      process.env.AI_MODEL = 'gpt-4o';

      // 1) Both missing/whitespace -> 400
      const emptyReq = new Request('http://localhost/api/ai/meal-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl: '   ', contextPrompt: '   ' }),
      });
      const emptyRes = await postMealScan(emptyReq);
      expect(emptyRes.status).toBe(400);

      // 2) Invalid non-empty imageDataUrl -> 400 even if contextPrompt is provided
      const badImgReq = new Request('http://localhost/api/ai/meal-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl: 'https://example.com/not-a-data-url.jpg',
          contextPrompt: '200g chicken adobo',
        }),
      });
      const badImgRes = await postMealScan(badImgReq);
      expect(badImgRes.status).toBe(400);

      // 3) Valid text-only request with no imageDataUrl
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      name: 'Chicken Adobo',
                      grams: 200,
                      per100g: { calories: 195, protein: 24, carbs: 3.5, fat: 9.2, fiber: 0.2 },
                      microsPer100g: {
                        sodiumMg: 680,
                        sugarG: 2.4,
                        addedSugarG: 1.5,
                        saturatedFatG: 2.9,
                        cholesterolMg: 78,
                      },
                    },
                    {
                      name: 'Brewed Black Coffee',
                      grams: 240,
                      per100g: { calories: 2, protein: 0.2, carbs: 0, fat: 0, fiber: 0 },
                      microsPer100g: {
                        potassiumMg: 49,
                        caffeineMg: 45,
                      },
                    },
                  ],
                }),
              },
            },
          ],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const textOnlyReq = new Request('http://localhost/api/ai/meal-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contextPrompt: '200g chicken adobo with 1 cup black coffee',
        }),
      });

      const res = await postMealScan(textOnlyReq);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.items).toHaveLength(2);
      expect(data.items[0].name).toBe('Chicken Adobo');
      expect(data.items[0].microsPer100g.sugarG).toBe(2.4);
      expect(data.items[0].microsPer100g.addedSugarG).toBe(1.5);
      expect(data.items[0].microsPer100g.saturatedFatG).toBe(2.9);
      expect(data.items[0].microsPer100g.cholesterolMg).toBe(78);
      expect(data.items[1].microsPer100g.caffeineMg).toBe(45);

      const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      const userContent = sentBody.messages[0].content;
      const promptText =
        typeof userContent === 'string' ? userContent : userContent[0].text;

      // Text-only request must not send an image_url block
      if (Array.isArray(userContent)) {
        expect(userContent.some((part: { type?: string }) => part.type === 'image_url')).toBe(false);
      } else {
        expect(typeof userContent).toBe('string');
      }

      for (const extKey of [
        'sugarG',
        'addedSugarG',
        'saturatedFatG',
        'cholesterolMg',
        'caffeineMg',
        'alcoholG',
      ]) {
        expect(promptText).toContain(extKey);
      }
    });
  });

  describe('POST /api/ai/refine', () => {
    it('returns 400 when items or instruction is missing', async () => {
      const req = new Request('http://localhost/api/ai/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [] }),
      });
      const res = await postRefine(req);
      expect(res.status).toBe(400);
    });

    it('refines meal draft items based on user instruction', async () => {
      process.env.AI_BASE_URL = 'https://api.openai.com/v1';
      process.env.AI_API_KEY = 'sk-key';
      process.env.AI_MODEL = 'gpt-4o';

      const updatedDraft = {
        items: [
          {
            name: 'Grilled Salmon Fillet',
            grams: 250, // updated from 200
            per100g: { calories: 208, protein: 20, carbs: 0, fat: 13, fiber: 0 },
          },
        ],
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(updatedDraft) } }],
        }),
      }));

      const req = new Request('http://localhost/api/ai/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              name: 'Grilled Salmon Fillet',
              grams: 200,
              per100g: { calories: 208, protein: 20, carbs: 0, fat: 13, fiber: 0 },
            },
          ],
          instruction: 'Increase salmon portion to 250g',
        }),
      });

      const res = await postRefine(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.items[0].grams).toBe(250);
    });

    it('instructs AI to include fiber and all 12 micronutrients on refine', async () => {
      process.env.AI_BASE_URL = 'https://api.openai.com/v1';
      process.env.AI_API_KEY = 'sk-key';
      process.env.AI_MODEL = 'gpt-4o';

      const mockMicros = {
        sodiumMg: 79,
        potassiumMg: 558,
        calciumMg: 99,
        ironMg: 2.7,
        magnesiumMg: 79,
        zincMg: 0.5,
        vitaminAMcg: 469,
        vitaminCMg: 28,
        vitaminDMcg: 0,
        vitaminB6Mg: 0.2,
        vitaminB12Mcg: 0,
        folateMcg: 194,
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      name: 'Steamed Spinach',
                      grams: 100,
                      per100g: { calories: 23, protein: 2.9, carbs: 3.6, fat: 0.4, fiber: 2.2 },
                      microsPer100g: mockMicros,
                    },
                  ],
                }),
              },
            },
          ],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const req = new Request('http://localhost/api/ai/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              name: 'Steamed Spinach',
              grams: 50,
              per100g: { calories: 23, protein: 2.9, carbs: 3.6, fat: 0.4, fiber: 2.2 },
            },
          ],
          instruction: 'Double the spinach to 100g',
        }),
      });

      const res = await postRefine(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.items[0].per100g.fiber).toBe(2.2);
      expect(data.items[0].microsPer100g).toEqual(mockMicros);

      const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      const promptText = sentBody.messages[0].content as string;
      for (const key of [
        'fiber',
        'sodiumMg',
        'potassiumMg',
        'calciumMg',
        'ironMg',
        'magnesiumMg',
        'zincMg',
        'vitaminAMcg',
        'vitaminCMg',
        'vitaminDMcg',
        'vitaminB6Mg',
        'vitaminB12Mcg',
        'folateMcg',
        'sugarG',
        'addedSugarG',
        'saturatedFatG',
        'cholesterolMg',
        'caffeineMg',
        'alcoholG',
      ]) {
        expect(promptText).toContain(key);
      }
    });
  });

  describe('POST /api/ai/label-ocr', () => {
    it('returns 400 on missing imageDataUrl', async () => {
      const req = new Request('http://localhost/api/ai/label-ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const res = await postLabelOcr(req);
      expect(res.status).toBe(400);
    });

    it('extracts nutrition label facts matching Task 8 consumer contract', async () => {
      process.env.AI_BASE_URL = 'https://api.openai.com/v1';
      process.env.AI_API_KEY = 'sk-key';
      process.env.AI_MODEL = 'gpt-4o';

      const labelData = {
        name: 'Whey Protein Isolate',
        brand: 'Optimum Nutrition',
        servingSize: 30.4,
        servingUnit: 'g',
        calories: 120,
        protein: 24,
        carbs: 3,
        fat: 1,
        fiber: 0,
        sodiumMg: 130,
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(labelData) } }],
        }),
      }));

      const req = new Request('http://localhost/api/ai/label-ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl: 'data:image/jpeg;base64,nutrition-label',
        }),
      });

      const res = await postLabelOcr(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe('Whey Protein Isolate');
      expect(data.servingSize).toBe(30.4);
      expect(data.servingUnit).toBe('g');
      expect(data.protein).toBe(24);
      expect(data.sodiumMg).toBe(130);
    });
  });
});

describe('Task 9: AiHealthStatusCard Component', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders card, displays status, and allows testing connection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        configured: true,
        model: 'gpt-4o',
        reachable: true,
      }),
    }));

    render(React.createElement(AiHealthStatusCard));

    expect(screen.getByText(/ai meal & label scanning/i)).toBeInTheDocument();
    expect(screen.getByText(/\.env\.local/i)).toBeInTheDocument();

    // Wait for initial health check to complete
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /test ai connection/i })).toBeInTheDocument();
      expect(screen.getByText(/gpt-4o/i)).toBeInTheDocument();
      expect(screen.getByText(/reachable/i)).toBeInTheDocument();
    });

    // Verify NO client BYOK API key input field exists
    expect(screen.queryByPlaceholderText(/api key/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();

    const testBtn = screen.getByRole('button', { name: /test ai connection/i });
    fireEvent.click(testBtn);

    await waitFor(() => {
      expect(screen.getByText(/gpt-4o/i)).toBeInTheDocument();
    });
  });
});
