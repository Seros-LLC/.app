/**
 * The transports. This module is the ONLY place in the codebase that opens a
 * socket to a model API (invariant 16), and it is reachable only through
 * `complete()`, which will not run without a meter context.
 *
 * Every call is bounded: timeout, max output tokens, and a cap on the response
 * body we are willing to read (L6).
 */
import { ProviderError, ProviderTimeout } from './types';
import type { CompleteRequest } from './types';

export interface TransportResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  provider: string;
}

export const DEFAULT_TIMEOUT_MS = () => Number(process.env.SEROS_TIMEOUT_MS || 20000);
export const OLLAMA_HOST = () => process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
/** Bytes of provider response we are willing to buffer. */
export const MAX_RESPONSE_BYTES = () => Number(process.env.SEROS_MAX_RESPONSE_BYTES || 256 * 1024);

/** Cheap, deterministic token estimate; replaced by provider counts when reported. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** True when the deterministic fake is the configured provider (offline-safe, tests). */
export function fakeIsConfigured(): boolean {
  return process.env.SEROS_PROVIDER === 'fake';
}

/** Local Qwen through Ollama. Bounded, JSON-mode; an unbounded call is a bug. */
export async function callQwen(req: CompleteRequest, model: string): Promise<TransportResult> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS());
  try {
    const r = await fetch(`${OLLAMA_HOST()}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model,
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
    const raw = await readBounded(r, MAX_RESPONSE_BYTES());
    let j: any;
    try { j = JSON.parse(raw); } catch { throw new ProviderError('ollama envelope was not json'); }
    const text = j?.message?.content;
    if (typeof text !== 'string' || text.length === 0) throw new ProviderError('ollama returned no content');
    return {
      text,
      inputTokens: Number(j?.prompt_eval_count ?? estimateTokens(req.system + req.user)),
      outputTokens: Number(j?.eval_count ?? estimateTokens(text)),
      cachedInputTokens: 0,
      provider: `ollama:${model}`,
    };
  } catch (e: any) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') throw new ProviderTimeout('ollama timeout');
    if (e instanceof ProviderError || e instanceof ProviderTimeout) throw e;
    // Error CLASS only: a provider body can contain customer content (invariant 13).
    throw new ProviderError(e?.name ? String(e.name) : 'unknown provider failure');
  } finally {
    clearTimeout(t);
  }
}

async function readBounded(r: Response, limit: number): Promise<string> {
  const body = r.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); throw new ProviderError('provider response exceeded byte cap'); }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
}

/**
 * The deterministic fake. No network, no keys, same answer every time. It is a
 * PROVIDER, chosen by configuration (SEROS_PROVIDER=fake) - never a silent
 * substitute for a provider that failed (H2).
 */
export function fakeComplete(req: CompleteRequest): TransportResult {
  const text = req.user;
  const committed = /\b(i(?:'| a)?ll|i will|we will|we'll|by (mon|tue|wed|thu|fri|sat|sun|tomorrow)|send|ship|write|fix|review|follow up|get back)\b/i.test(text);
  const question = /\?\s*$/.test(text.trim());
  const isCommitment = committed && !question;
  let out: string;
  if (req.purpose === 'detect') {
    out = JSON.stringify({ isCommitment, confidence: isCommitment ? 78 : 12, reason: isCommitment ? 'first-person future intent' : 'no explicit undertaking' });
  } else {
    const first = text.split(/[.!?\n]/)[0]?.trim().slice(0, 110) || 'Untitled';
    out = JSON.stringify({
      title: first.charAt(0).toUpperCase() + first.slice(1),
      outcome: first,
      proposedOwner: null,
      dueDate: null,
      confidence: isCommitment ? 72 : 30,
    });
  }
  return {
    text: out,
    inputTokens: estimateTokens(req.system + req.user),
    outputTokens: estimateTokens(out),
    cachedInputTokens: 0,
    provider: 'fake',
  };
}
