import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';

const secret = () => process.env.SEROS_SIGNING_SECRET || 'dev-signing-secret';
const MAX_AGE_SEC = 300;

export function sign(rawBody: string, ts: string, key: string = secret()): string {
  return 'v0=' + crypto.createHmac('sha256', key).update(`v0:${ts}:${rawBody}`).digest('hex');
}

function verify(req: Request, raw: string): { ok: true } | { ok: false; why: string } {
  const sig = req.header('x-slack-signature');
  const ts = req.header('x-slack-request-timestamp');
  if (!sig || !ts) return { ok: false, why: 'missing_headers' };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, why: 'bad_timestamp' };
  if (Math.abs(Date.now() / 1000 - tsNum) > MAX_AGE_SEC) return { ok: false, why: 'stale_timestamp' };
  const expected = Buffer.from(sign(raw, ts));
  const given = Buffer.from(sig);
  if (expected.length !== given.length) return { ok: false, why: 'bad_signature' };
  if (!crypto.timingSafeEqual(expected, given)) return { ok: false, why: 'bad_signature' };
  return { ok: true };
}

export async function webhookHandler(req: Request, res: Response) {
  const raw: string = (req as any).rawBody ?? '';
  const v = verify(req, raw);
  if (!v.ok) {
    console.log(JSON.stringify({ level: 'warn', event: 'webhook.rejected', reason: v.why }));
    return res.status(401).json({ ok: false, error: v.why });
  }
  const b = req.body ?? {};
  if (b.type === 'url_verification') return res.json({ challenge: b.challenge });

  const ev = b.event ?? b;
  const workspaceId = b.team_id || b.workspace_id || 'demo';
  const channelId = ev.channel || 'unknown';
  const ts = String(ev.ts || Date.now() / 1000);
  const authorId = ev.user || 'unknown';
  const text = typeof ev.text === 'string' ? ev.text : '';
  if (!text.trim()) return res.json({ ok: true, ignored: 'empty' });
  if (ev.bot_id || ev.subtype) return res.json({ ok: true, ignored: 'bot_or_subtype' });

  const db = openDb();
  const scope = WorkspaceScope.ensure(db, workspaceId);
  const { row, created } = scope.ingestMessage({ channelId, ts, authorId, body: text });
  if (created) scope.enqueue('detect', { messageId: row.id });
  console.log(JSON.stringify({ level: 'info', event: 'webhook.accepted', workspace: workspaceId, message_id: row.id, deduped: !created }));
  return res.json({ ok: true, messageId: row.id, deduped: !created });
}
