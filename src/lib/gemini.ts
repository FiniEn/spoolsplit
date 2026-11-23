import { ApiError, GoogleGenAI } from '@google/genai';

/**
 * Server-only: calls Gemini for a JSON answer, retrying and falling back to other models when
 * the first one is overloaded ("high demand", HTTP 503) or rate-limited (429).
 *
 * Order: GEMINI_MODEL (default gemini-3.8-flash), then GEMINI_FALLBACK_MODELS
 * (comma-separated; default gemini-3.5-flash, gemini-3.5-flash-lite).
 */

const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_FALLBACKS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];
/** Tries per model before moving on (only for overload errors). */
const ATTEMPTS_PER_MODEL = 2;
/** Stop starting new tries after this long, to stay inside the serverless time limit. */
const TIME_BUDGET_MS = 45_000;

export function geminiModels(): string[] {
  const primary = (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const fallbacks = process.env.GEMINI_FALLBACK_MODELS
    ? process.env.GEMINI_FALLBACK_MODELS.split(',').map((m) => m.trim()).filter(Boolean)
    : DEFAULT_FALLBACKS;
  return [primary, ...fallbacks.filter((m) => m !== primary)];
}

/** True for "try again / try another model" errors: overloaded, rate-limited, timed out. */
function isOverloaded(err: unknown): boolean {
  if (err instanceof ApiError && [429, 500, 503, 504].includes(err.status)) return true;
  const msg = String((err as any)?.message || '');
  return /high demand|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED/i.test(msg);
}

/** Gemini errors arrive as a JSON string; pull out the human-readable message. */
export function readableGeminiError(err: unknown): string {
  const raw = String((err as any)?.message || '');
  try {
    const parsed = JSON.parse(raw);
    const msg = parsed?.error?.message || parsed?.message;
    if (msg) return `Gemini: ${msg}`;
  } catch {
    // not JSON
  }
  return raw;
}

export async function generateJsonWithFallback(opts: {
  parts: any[];
  responseSchema: any;
}): Promise<{ data: any; model: string }> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const started = Date.now();
  const tried: string[] = [];
  let lastError: unknown;

  for (const model of geminiModels()) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: opts.parts }],
          config: { responseMimeType: 'application/json', responseSchema: opts.responseSchema },
        });
        return { data: JSON.parse(response.text || '{}'), model };
      } catch (err) {
        lastError = err;
        if (!isOverloaded(err)) throw err; // a real error (bad key, bad file...): don't retry
        tried.push(model);
        if (attempt < ATTEMPTS_PER_MODEL) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  const models = [...new Set(tried)].join(', ');
  throw new Error(
    `All Gemini models are busy right now (tried ${models}). Please try again in a minute. (${readableGeminiError(lastError)})`
  );
}
