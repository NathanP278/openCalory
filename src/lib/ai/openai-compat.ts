import { createHash } from 'crypto';

export interface AiCandidate {
  apiKey: string;
  model: string;
  keyIndex: number;
  modelIndex: number;
}

export interface ServerAiConfig {
  isConfigured: boolean;
  baseUrl: string;
  apiKey: string;
  apiKeys: string[];
  model: string;
  models: string[];
  candidates: AiCandidate[];
  customHeaders: Record<string, string>;
}

const AI_CACHE_MAX_ENTRIES = 64;
const AI_CACHE_TTL_MS = 5 * 60 * 1000;
const PING_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_PING_TIMEOUT_MS = 4500;

const unsupportedJsonFormatModels = new Set<string>();
const inFlightRequests = new Map<string, Promise<string>>();
const responseCache = new Map<string, { value: string; expiresAt: number }>();
const candidateHealthCache = new Map<string, { healthy: boolean; expiresAt: number }>();

let cachedCustomHeadersRaw: string | undefined;
let cachedCustomHeadersParsed: Record<string, string> = {};

/**
 * Clears runtime AI caches (unsupported response_format registry, in-flight map, LRU cache, and ping health cache).
 * Primarily intended for deterministic unit testing.
 */
export function clearAiRuntimeCaches(): void {
  unsupportedJsonFormatModels.clear();
  inFlightRequests.clear();
  responseCache.clear();
  candidateHealthCache.clear();
}

export class AiServiceError extends Error {
  public readonly status: number;

  constructor(message: string, status: number = 500) {
    super(message);
    this.name = 'AiServiceError';
    this.status = status;
  }
}

/**
 * Strips secret API keys and sensitive custom headers from error messages or logs
 * to prevent credential leakage.
 */
export function sanitizeError(
  message: string,
  apiKeyOrKeys?: string | string[],
  customHeaders?: Record<string, string>
): string {
  if (!message) return '';
  let sanitized = message;

  const keys = Array.isArray(apiKeyOrKeys)
    ? apiKeyOrKeys
    : apiKeyOrKeys
      ? [apiKeyOrKeys]
      : [];

  for (const key of keys) {
    if (typeof key === 'string' && key.trim()) {
      sanitized = sanitized.replaceAll(key.trim(), '[REDACTED]');
    }
  }

  if (customHeaders) {
    for (const val of Object.values(customHeaders)) {
      if (typeof val === 'string' && val.trim().length >= 6) {
        sanitized = sanitized.replaceAll(val.trim(), '[REDACTED]');
      }
    }
  }

  return sanitized;
}

/**
 * Normalizes OpenAI-compatible chat completions URL.
 * Handles trailing slashes and ensures /chat/completions is not duplicated.
 */
export function normalizeChatEndpoint(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  if (clean.endsWith('/chat/completions')) {
    return clean;
  }
  return `${clean}/chat/completions`;
}

function parseCsvEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Reads server-side AI configuration strictly from environment variables.
 * Supports primary + fallback API keys (`AI_API_KEY`, `AI_FALLBACK_API_KEYS`)
 * and primary + fallback models (`AI_MODEL`, `AI_FALLBACK_MODELS`).
 * Never exposes these variables to client code.
 */
export function getServerAiConfig(): ServerAiConfig {
  const baseUrl = process.env.AI_BASE_URL?.trim() || '';
  const primaryApiKey = process.env.AI_API_KEY?.trim() || '';
  const primaryModel = process.env.AI_MODEL?.trim() || '';

  const apiKeys = Array.from(
    new Set([primaryApiKey, ...parseCsvEnv(process.env.AI_FALLBACK_API_KEYS)].filter(Boolean))
  );
  const models = Array.from(
    new Set([primaryModel, ...parseCsvEnv(process.env.AI_FALLBACK_MODELS)].filter(Boolean))
  );

  const candidates: AiCandidate[] = [];
  for (let keyIndex = 0; keyIndex < apiKeys.length; keyIndex++) {
    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
      candidates.push({
        apiKey: apiKeys[keyIndex],
        model: models[modelIndex],
        keyIndex,
        modelIndex,
      });
    }
  }

  const rawCustomHeaders = process.env.AI_CUSTOM_HEADERS;
  if (rawCustomHeaders !== cachedCustomHeadersRaw) {
    cachedCustomHeadersRaw = rawCustomHeaders;
    let parsedHeaders: Record<string, string> = {};
    if (rawCustomHeaders) {
      try {
        const parsed = JSON.parse(rawCustomHeaders);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsedHeaders = parsed as Record<string, string>;
        }
      } catch {
        // Gracefully ignore malformed custom headers JSON
      }
    }
    cachedCustomHeadersParsed = parsedHeaders;
  }

  const isConfigured = Boolean(baseUrl && candidates.length > 0);
  return {
    isConfigured,
    baseUrl,
    apiKey: apiKeys[0] || '',
    apiKeys,
    model: models[0] || '',
    models,
    candidates,
    customHeaders: { ...cachedCustomHeadersParsed },
  };
}

export interface CallVisionOptions {
  timeoutMs?: number;
  pingTimeoutMs?: number;
  skipPing?: boolean;
  responseFormat?: boolean;
  enableCache?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface VisionCompletionResult {
  content: string;
  model: string;
  keyIndex: number;
}

const TRANSIENT_RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_TRANSIENT_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 350;
const MAX_SERVER_RETRY_DELAY_MS = 4000;

function parseRetryAfterMs(
  headers: Headers | undefined,
  fallbackMs: number,
  maxMs: number
): number {
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  if (raw) {
    const seconds = Number(raw.trim());
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(maxMs, Math.max(250, Math.round(seconds * 1000)));
    }
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - Date.now();
      if (delta > 0) {
        return Math.min(maxMs, Math.max(250, delta));
      }
    }
  }
  return Math.min(maxMs, fallbackMs);
}

function isRetryableFetchError(err: unknown, externalSignal?: AbortSignal): boolean {
  if (externalSignal?.aborted) {
    return false;
  }
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return true;
  }
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError') {
      return true;
    }
    if (/timeout|timed out|network|fetch failed|econnreset|etimedout/i.test(err.message)) {
      return true;
    }
  }
  return false;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function buildAbortSignal(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!externalSignal) {
    return timeoutSignal;
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timeoutSignal, externalSignal]);
  }
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (externalSignal.aborted || timeoutSignal.aborted) {
    controller.abort();
    return controller.signal;
  }
  externalSignal.addEventListener('abort', forwardAbort, { once: true });
  timeoutSignal.addEventListener('abort', forwardAbort, { once: true });
  return controller.signal;
}

function buildCacheKey(
  endpoint: string,
  models: string[],
  messages: unknown[],
  responseFormat: boolean | undefined,
  temperature: number | undefined,
  maxTokens: number | undefined
): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      endpoint,
      models,
      messages,
      responseFormat: responseFormat !== false,
      temperature,
      maxTokens,
    })
  );
  return hash.digest('hex');
}

function getCachedCompletion(key: string): string | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  // Refresh LRU order
  responseCache.delete(key);
  responseCache.set(key, entry);
  return entry.value;
}

function setCachedCompletion(key: string, value: string): void {
  if (responseCache.has(key)) {
    responseCache.delete(key);
  } else if (responseCache.size >= AI_CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey !== undefined) {
      responseCache.delete(oldestKey);
    }
  }
  responseCache.set(key, {
    value,
    expiresAt: Date.now() + AI_CACHE_TTL_MS,
  });
}

function getCandidateHealthKey(endpoint: string, candidate: AiCandidate): string {
  return `${endpoint}|${candidate.keyIndex}|${candidate.model}`;
}

function setCandidateHealth(endpoint: string, candidate: AiCandidate, healthy: boolean): void {
  candidateHealthCache.set(getCandidateHealthKey(endpoint, candidate), {
    healthy,
    expiresAt: Date.now() + PING_CACHE_TTL_MS,
  });
}

function getCachedHealthyCandidates(endpoint: string, candidates: AiCandidate[]): AiCandidate[] | null {
  const now = Date.now();
  const healthy: AiCandidate[] = [];
  let allKnown = true;

  for (const candidate of candidates) {
    const entry = candidateHealthCache.get(getCandidateHealthKey(endpoint, candidate));
    if (!entry || now > entry.expiresAt) {
      allKnown = false;
      break;
    }
    if (entry.healthy) {
      healthy.push(candidate);
    }
  }

  if (allKnown && healthy.length > 0) {
    return healthy;
  }
  return null;
}

/**
 * Pings all configured (API key, model) candidates in parallel with a minimal text prompt.
 * Resolves as soon as the highest-priority candidate is confirmed healthy (all higher-priority
 * candidates have settled), avoiding waiting on slower fallback models when primary is healthy.
 */
async function pingAndSelectCandidates(
  endpoint: string,
  config: ServerAiConfig,
  pingTimeoutMs: number,
  externalSignal?: AbortSignal
): Promise<AiCandidate[]> {
  const { candidates, apiKeys, customHeaders } = config;
  const cached = getCachedHealthyCandidates(endpoint, candidates);
  if (cached) {
    return cached;
  }

  return new Promise<AiCandidate[]>((resolve, reject) => {
    const settled = new Array<boolean>(candidates.length).fill(false);
    const ok = new Array<boolean>(candidates.length).fill(false);
    const errors = new Array<string>(candidates.length).fill('');
    let done = false;

    const tryResolveEarly = () => {
      if (done) return;

      // Scan in strict priority order: stop at first unsettled higher-priority candidate
      for (let i = 0; i < candidates.length; i++) {
        if (!settled[i]) {
          return;
        }
        if (ok[i]) {
          done = true;
          const passing = candidates.filter((_, idx) => ok[idx]);
          resolve(passing);
          return;
        }
      }

      // All candidates settled and none succeeded
      if (settled.every(Boolean)) {
        done = true;
        const firstErr = errors.find(Boolean) || 'All AI candidates failed health ping';
        reject(
          new AiServiceError(
            `All AI fallback candidates unavailable: ${firstErr}`,
            503
          )
        );
      }
    };

    candidates.forEach((candidate, index) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${candidate.apiKey}`,
        ...customHeaders,
      };
      const payload = {
        model: candidate.model,
        messages: [{ role: 'user', content: 'OK' }],
        max_tokens: 1,
      };

      fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: buildAbortSignal(pingTimeoutMs, externalSignal),
      })
        .then(async (res) => {
          if (res.ok) {
            setCandidateHealth(endpoint, candidate, true);
            ok[index] = true;
          } else {
            const rawErr = await res.text().catch(() => res.statusText);
            setCandidateHealth(endpoint, candidate, false);
            errors[index] = `(${res.status}) ${sanitizeError(rawErr, apiKeys, customHeaders)}`;
          }
        })
        .catch((err: unknown) => {
          const rawMsg = err instanceof Error ? err.message : String(err);
          setCandidateHealth(endpoint, candidate, false);
          errors[index] = sanitizeError(rawMsg, apiKeys, customHeaders);
        })
        .finally(() => {
          settled[index] = true;
          tryResolveEarly();
        });
    });
  });
}

async function executeCandidateCompletion(
  endpoint: string,
  candidate: AiCandidate,
  config: ServerAiConfig,
  messages: unknown[],
  options?: CallVisionOptions,
  allowTransientRetry: boolean = config.candidates.length === 1
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 45000;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${candidate.apiKey}`,
    ...config.customHeaders,
  };

  const modelFormatKey = `${endpoint}|${candidate.model}`;

  const executeFetch = async (useJsonFormat: boolean) => {
    const payload: Record<string, unknown> = {
      model: candidate.model,
      messages,
    };
    if (options?.temperature !== undefined) {
      payload.temperature = options.temperature;
    }
    if (options?.maxTokens !== undefined) {
      payload.max_tokens = options.maxTokens;
    }
    if (useJsonFormat) {
      payload.response_format = { type: 'json_object' };
    }

    return fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: buildAbortSignal(timeoutMs, options?.signal),
    });
  };

  const fetchWithRetry = async (useJsonFormat: boolean): Promise<Response> => {
    let attempt = 0;
    while (true) {
      try {
        const response = await executeFetch(useJsonFormat);
        // Retry inline on single-candidate setups or on the last remaining fallback candidate
        if (
          allowTransientRetry &&
          !response.ok &&
          TRANSIENT_RETRY_STATUSES.has(response.status) &&
          attempt < MAX_TRANSIENT_RETRIES &&
          !options?.signal?.aborted
        ) {
          const fallbackDelayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
          const delayMs = parseRetryAfterMs(
            response.headers,
            fallbackDelayMs,
            MAX_SERVER_RETRY_DELAY_MS
          );
          attempt += 1;
          await sleepWithSignal(delayMs, options?.signal);
          continue;
        }
        return response;
      } catch (err: unknown) {
        if (
          allowTransientRetry &&
          attempt < MAX_TRANSIENT_RETRIES &&
          isRetryableFetchError(err, options?.signal)
        ) {
          const delayMs = Math.min(
            MAX_SERVER_RETRY_DELAY_MS,
            INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt)
          );
          attempt += 1;
          await sleepWithSignal(delayMs, options?.signal);
          continue;
        }
        throw err;
      }
    }
  };

  const wantsJsonFormat =
    options?.responseFormat !== false && !unsupportedJsonFormatModels.has(modelFormatKey);
  let res = await fetchWithRetry(wantsJsonFormat);

  // Some providers/models reject response_format with a 400 Bad Request.
  // Fall back to calling without response_format and cache model incompatibility.
  if (!res.ok && res.status === 400 && wantsJsonFormat) {
    const fallbackRes = await fetchWithRetry(false);
    if (fallbackRes.ok) {
      unsupportedJsonFormatModels.add(modelFormatKey);
      res = fallbackRes;
    }
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => res.statusText);
    const safeMsg = sanitizeError(errorText, config.apiKeys, config.customHeaders);
    throw new AiServiceError(
      `Upstream AI service error (${res.status}): ${safeMsg}`,
      res.status >= 500 ? 502 : res.status
    );
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;

  let textResult: string | null = null;
  if (typeof content === 'string') {
    textResult = content;
  } else if (Array.isArray(content)) {
    textResult = content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('\n');
  }

  if (textResult !== null && textResult.trim().length > 0) {
    return textResult;
  }

  throw new AiServiceError('AI returned empty message content', 502);
}

/**
 * Calls an OpenAI-compatible vision/chat completion endpoint and returns both text and metadata.
 * When multiple (API key, model) candidates are configured, runs a fast parallel ping first
 * to pick the highest-priority healthy candidate and falls back automatically on errors.
 */
export async function callVisionChatCompletionWithMeta(
  messages: unknown[],
  options?: CallVisionOptions
): Promise<VisionCompletionResult> {
  const config = getServerAiConfig();
  if (!config.isConfigured) {
    throw new AiServiceError(
      'AI service is not configured. Missing AI_BASE_URL, AI_API_KEY, or AI_MODEL in server environment.',
      503
    );
  }

  const endpoint = normalizeChatEndpoint(config.baseUrl);
  const pingTimeoutMs = options?.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  const shouldPing = !options?.skipPing && config.candidates.length > 1;

  const selectedCandidates = shouldPing
    ? await pingAndSelectCandidates(endpoint, config, pingTimeoutMs, options?.signal)
    : config.candidates;

  // Build ordered list: selected healthy candidates first, then any remaining candidates not yet tried
  const triedKeys = new Set<string>();
  const orderedToTry: AiCandidate[] = [...selectedCandidates];
  if (shouldPing) {
    const selectedSet = new Set(selectedCandidates.map((c) => getCandidateHealthKey(endpoint, c)));
    for (const c of config.candidates) {
      if (!selectedSet.has(getCandidateHealthKey(endpoint, c))) {
        // Only append candidates that weren't explicitly marked unhealthy in this cycle
        const cached = candidateHealthCache.get(getCandidateHealthKey(endpoint, c));
        if (!cached || cached.healthy || Date.now() > cached.expiresAt) {
          orderedToTry.push(c);
        }
      }
    }
  }

  const uniqueOrdered: AiCandidate[] = [];
  for (const candidate of orderedToTry) {
    const cKey = getCandidateHealthKey(endpoint, candidate);
    if (triedKeys.has(cKey)) continue;
    triedKeys.add(cKey);
    uniqueOrdered.push(candidate);
  }

  let lastError: AiServiceError | null = null;
  for (let i = 0; i < uniqueOrdered.length; i++) {
    const candidate = uniqueOrdered[i];
    const isLastCandidate = i === uniqueOrdered.length - 1;

    try {
      const content = await executeCandidateCompletion(
        endpoint,
        candidate,
        config,
        messages,
        options,
        isLastCandidate
      );
      setCandidateHealth(endpoint, candidate, true);
      return {
        content,
        model: candidate.model,
        keyIndex: candidate.keyIndex,
      };
    } catch (err: unknown) {
      if (options?.signal?.aborted) {
        throw err instanceof AiServiceError
          ? err
          : new AiServiceError('AI completion request aborted', 499);
      }

      setCandidateHealth(endpoint, candidate, false);
      if (err instanceof AiServiceError) {
        lastError = err;
      } else {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const safeMsg = sanitizeError(rawMsg, config.apiKeys, config.customHeaders);
        lastError = new AiServiceError(`AI completion request failed: ${safeMsg}`, 502);
      }
    }
  }

  throw lastError ?? new AiServiceError('AI completion request failed', 502);
}

/**
 * Calls an OpenAI-compatible vision/chat completion endpoint.
 * Handles Bearer auth, custom headers, parallel ping & fallback across keys/models,
 * timeout, response_format with cached fallback, in-flight deduplication, and bounded LRU caching.
 */
export async function callVisionChatCompletion(
  messages: unknown[],
  options?: CallVisionOptions
): Promise<string> {
  const config = getServerAiConfig();
  if (!config.isConfigured) {
    throw new AiServiceError(
      'AI service is not configured. Missing AI_BASE_URL, AI_API_KEY, or AI_MODEL in server environment.',
      503
    );
  }

  const endpoint = normalizeChatEndpoint(config.baseUrl);
  const useCache = options?.enableCache ?? process.env.NODE_ENV !== 'test';
  const cacheKey = useCache
    ? buildCacheKey(
        endpoint,
        config.models,
        messages,
        options?.responseFormat,
        options?.temperature,
        options?.maxTokens
      )
    : null;

  if (cacheKey) {
    const cached = getCachedCompletion(cacheKey);
    if (cached !== null) {
      return cached;
    }
    const existingInFlight = inFlightRequests.get(cacheKey);
    if (existingInFlight) {
      return existingInFlight;
    }
  }

  const runCompletion = async (): Promise<string> => {
    const result = await callVisionChatCompletionWithMeta(messages, options);
    if (cacheKey) {
      setCachedCompletion(cacheKey, result.content);
    }
    return result.content;
  };

  if (!cacheKey) {
    return runCompletion();
  }

  const promise = runCompletion().finally(() => {
    inFlightRequests.delete(cacheKey);
  });
  inFlightRequests.set(cacheKey, promise);
  return promise;
}
