/**
 * ADR 0004 boundary: ONE operation, no streaming, no tools, no vendor type escapes here.
 * Tiers are named by role, mapped to concrete models in config, changeable without a deploy.
 *
 * Order of preference:
 *   1. local Qwen (Ollama on this machine)  -- primary in dev, and the BACKUP everywhere
 *   2. deterministic fake                   -- always available, keeps the app offline-safe
 */
import { z } from 'zod';

export type Tier = 'cheap' | 'standard' | 'careful';
export type Purpose = 'detect' | 'draft' | 'route' | 'replay' | 'other';
export type MeterOutcome = 'ok' | 'timeout' | 'invalid_output' | 'provider_error' | 'budget_blocked';

export interface CompleteRequest {
  tier: Tier;
  purpose: Purpose;
  system: string;
  user: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
}
export interface CompleteResult<T> {
  value: T;
  provider: string;
  outcome: MeterOutcome;
  latencyMs: number;
}

export const TIERS: Record<Tier, string> = {
  cheap: process.env.SEROS_MODEL_CHEAP || 'qwen2.5:7b-instruct',
  standard: process.env.SEROS_MODEL_STANDARD || 'qwen2.5:7b-instruct',
  careful: process.env.SEROS_MODEL_CAREFUL || 'qwen2.5:7b-instruct',
};

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const DEFAULT_TIMEOUT = Number(process.env.SEROS_TIMEOUT_MS || 20000);

export class ProviderTimeout extends Error { readonly kind = 'timeout' as const; }
export class ProviderError extends Error { readonly kind = 'provider_error' as const; }
export class InvalidOutput extends Error { readonly kind = 'invalid_output' as const; }

/** Local Qwen through Ollama. Bounded, JSON-mode, no unbounded call is permitted. */
async function callQwen(req: CompleteRequest): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model: TIERS[req.tier],
        stream: false,
        format: 'json',
        options: { temperature: 0, num_predict: req.maxOutputTokens ?? 512 },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
    });
    if (!r.ok) throw new ProviderError(`ollama http ${r.status}`);
    const j = (await r.json()) as { message?: { content?: string } };
    const text = j.message?.content;
    if (!text) throw new ProviderError('ollama returned no content');
    return text;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new ProviderTimeout('ollama timeout');
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(String(e?.message ?? e));
  } finally {
    clearTimeout(t);
  }
}

/**
 * The deterministic fallback. No network, no keys, same answer every time.
 * Used when Qwen is unreachable, and by every test.
 */
function fakeComplete(req: CompleteRequest): string {
  const text = req.user;
  const committed = /\b(i(?:'| a)?ll|i will|we will|we'll|by (mon|tue|wed|thu|fri|sat|sun|tomorrow)|send|ship|write|fix|review|follow up|get back)\b/i.test(text);
  const question = /\?\s*$/.test(text.trim());
  const isCommitment = committed && !question;
  if (req.purpose === 'detect') {
    return JSON.stringify({ isCommitment, confidence: isCommitment ? 78 : 12, reason: isCommitment ? 'first-person future intent' : 'no explicit undertaking' });
  }
  const first = text.split(/[.!?\n]/)[0]?.trim().slice(0, 110) || 'Untitled';
  return JSON.stringify({
    title: first.charAt(0).toUpperCase() + first.slice(1),
    outcome: first,
    proposedOwner: null,
    dueDate: null,
    confidence: isCommitment ? 72 : 30,
  });
}

/** The only way the app talks to a model. Always returns; never throws past the caller. */
export async function complete<T>(req: CompleteRequest, schema: z.ZodType<T>): Promise<CompleteResult<T>> {
  const started = Date.now();
  const forceFake = process.env.SEROS_PROVIDER === 'fake';
  let raw: string | null = null;
  let provider = 'fake';
  let outcome: MeterOutcome = 'ok';

  if (!forceFake) {
    try {
      raw = await callQwen(req);
      provider = `ollama:${TIERS[req.tier]}`;
    } catch (e: any) {
      outcome = e?.kind === 'timeout' ? 'timeout' : 'provider_error';
      raw = null;
    }
  }
  if (raw === null) {
    raw = fakeComplete(req);           // BACKUP PATH
    provider = forceFake ? 'fake' : `fake(after:${outcome})`;
    // outcome is deliberately NOT reset to 'ok': the request was served, but the
    // meter must record that the model failed, or an outage looks like a good day.
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { 
    const fb = schema.safeParse(JSON.parse(fakeComplete(req)));
    if (!fb.success) throw new InvalidOutput('fallback failed schema');
    return { value: fb.data, provider: `${provider}->fake(invalid_json)`, outcome: 'invalid_output', latencyMs: Date.now() - started };
  }
  const check = schema.safeParse(parsed);
  if (!check.success) {
    const fb = schema.safeParse(JSON.parse(fakeComplete(req)));
    if (!fb.success) throw new InvalidOutput('fallback failed schema');
    return { value: fb.data, provider: `${provider}->fake(schema)`, outcome: 'invalid_output', latencyMs: Date.now() - started };
  }
  return { value: check.data, provider, outcome, latencyMs: Date.now() - started };
}

export const DetectionSchema = z.object({
  isCommitment: z.boolean(),
  confidence: z.number().min(0).max(100),
  reason: z.string().max(200).optional().default(''),
});
export const DraftSchema = z.object({
  title: z.string().min(1).max(160),
  outcome: z.string().min(1).max(400),
  proposedOwner: z.string().nullable().default(null),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  confidence: z.number().min(0).max(100),
});
