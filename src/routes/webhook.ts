import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { checkAndRecordReplay } from '../replay';
import { workspaceIdForSlackTeam } from '../db/system';
import { enforceLimits } from '../limits';

/** No default. A signing secret that ships in the source is not a signing secret. */
export const secret = () => {
  const s = process.env.SEROS_SIGNING_SECRET;
  if (!s || s.length < 16) {
    throw new Error('SEROS_SIGNING_SECRET is unset or too short (>=16 chars required)');
  }
  return s;
};
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
  const skew = Date.now() / 1000 - tsNum;
  if (skew > MAX_AGE_SEC) return { ok: false, why: 'stale_timestamp' };
  if (skew < -60) return { ok: false, why: 'future_timestamp' };
  const expected = Buffer.from(sign(raw, ts));
  const given = Buffer.from(sig);
  if (expected.length !== given.length) return { ok: false, why: 'bad_signature' };
  if (!crypto.timingSafeEqual(expected, given)) return { ok: false, why: 'bad_signature' };
  return { ok: true };
}

export async function webhookHandler(req: Request, res: Response) {
  // The bytes we verify MUST be the bytes we parse. This route is mounted with
  // express.raw, so req.body is a Buffer and nothing has re-serialised it.
  const raw: string = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const v = verify(req, raw);
  if (!v.ok) {
    console.log(JSON.stringify({ level: 'warn', event: 'webhook.rejected', reason: v.why }));
    return res.status(401).json({ ok: false, error: v.why });
  }
  let b: any;
  try { b = JSON.parse(raw); } catch { return res.status(400).json({ ok: false, error: 'bad_json' }); }
  if (!b || typeof b !== 'object') return res.status(400).json({ ok: false, error: 'bad_json' });
  if (b.type === 'url_verification') return res.json({ challenge: b.challenge });

  const ev = b.event ?? b;
  const teamId: string = b.team_id || b.workspace_id || '';
  const channelId = ev.channel || 'unknown';
  if (typeof ev.ts !== 'string' || !ev.ts) return res.status(400).json({ ok: false, error: 'missing_event_ts' });
  const ts = ev.ts;
  const authorId = ev.user || 'unknown';
  const text = typeof ev.text === 'string' ? ev.text : '';
  if (!text.trim()) return res.json({ ok: true, ignored: 'empty' });
  if (ev.bot_id || ev.subtype) return res.json({ ok: true, ignored: 'bot_or_subtype' });

  // open(), never ensure(): a signed event for an unknown workspace must not be able
  // to conjure a tenant into existence.
  const db = openDb();

  // A signature may be spent exactly once. Without this, anything inside the
  // freshness window can be sent again and again.
  const sigHeader = req.header('x-slack-signature')!;
  const tsHeader = Number(req.header('x-slack-request-timestamp'));
  const replay = await checkAndRecordReplay(db, sigHeader, tsHeader);
  if (!replay.fresh) {
    console.log(JSON.stringify({ level: 'warn', event: 'webhook.replayed' }));
    return res.status(409).json({ ok: false, error: 'replayed_signature' });
  }

  // The tenant is resolved from the stored connection, never from the payload.
  // A team id that no workspace has connected - or one that was disconnected -
  // has no tenant here, so a signed event cannot conjure or reach a workspace.
  const workspaceId = await workspaceIdForSlackTeam(db, teamId);
  if (!workspaceId) {
    console.log(JSON.stringify({ level: 'warn', event: 'webhook.no_connection' }));
    return res.status(404).json({ ok: false, error: 'unknown_workspace' });
  }

  let scope;
  try { scope = await WorkspaceScope.open(db, workspaceId); }
  catch {
    console.log(JSON.stringify({ level: 'warn', event: 'webhook.unknown_workspace', workspace: workspaceId }));
    return res.status(404).json({ ok: false, error: 'unknown_workspace' });
  }

  // "We only read these." A message from a channel the admin has not ticked is
  // dropped before it is stored, not filtered later: the promise on the channel
  // picker is that nothing else is read, and a row in source_messages would
  // already have broken it.
  if (!(await scope.isChannelSelected(channelId))) {
    console.log(JSON.stringify({ level: 'info', event: 'webhook.channel_not_selected', workspace: workspaceId }));
    return res.json({ ok: true, ignored: 'channel_not_selected' });
  }
  // A tenant at its backlog cap is refused loudly rather than quietly dropped.
  const lim = await enforceLimits(db, workspaceId);
  if (!lim.ok) {
    console.log(JSON.stringify({ level: 'warn', event: 'webhook.at_limit', workspace: workspaceId, kind: lim.kind }));
    return res.status(lim.suggestedStatus).json({ ok: false, error: lim.reason, count: lim.count, limit: lim.limit });
  }

  const { row, created } = await scope.ingestMessage({ channelId, ts, authorId, body: text });
  if (created) await scope.enqueue('detect', { messageId: row.id });
  console.log(JSON.stringify({ level: 'info', event: 'webhook.accepted', workspace: workspaceId, message_id: row.id, deduped: !created }));
  return res.json({ ok: true, messageId: row.id, deduped: !created });
}
