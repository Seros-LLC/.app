/**
 * Connecting Slack, and choosing what we may read.
 *
 * business/ROADMAP.md, "Admin and trust": OAuth connect and disconnect with the
 * scopes listed, a channel picker with an explicit "we only read these"
 * statement, and data deletion on disconnect. This file is those three things.
 *
 * Nothing here is a background job. An admin clicks, Slack answers, and the
 * result is a row plus an audit entry.
 */
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { slackClient } from '../slack/client';
import { seal, open as openSecret, encryptionConfigured } from '../crypto';
import { csrfToken } from '../auth';
import { page, esc, empty, notice, setupRail } from '../views';

/** Read-only, and the narrowest set that supports v0. Shown to the admin verbatim. */
export const SLACK_SCOPES = [
  'channels:read',      // list public channels for the picker
  'channels:history',   // read messages in the channels the admin ticks
  'groups:read',        // private channels the app is invited to
  'groups:history',
  'chat:write',         // reply into the source thread with the tracker link
  'users:read',         // map an author to a workspace member
];

const state = new Map<string, { workspaceId: string; memberId: string; at: number }>();
const STATE_TTL_MS = 10 * 60 * 1000;

function redirectUri(req: Request): string {
  const base = process.env.SEROS_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/connect/slack/callback`;
}

function requireAdmin(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** GET /connect - what is connected, and the button that changes it. */
export async function connectPage(req: Request, res: Response) {
  const s = req.serosSession!;
  const db = openDb();
  const scope = await WorkspaceScope.open(db, s.workspaceId);
  const me = await scope.member(s.memberId);
  const conn = await scope.connection();
  const selected = conn ? await scope.selectedChannels() : [];
  const csrf = csrfToken(s);

  const scopeList = SLACK_SCOPES.map((x) => `<li><code>${esc(x)}</code></li>`).join('');
  const body = conn
    ? `<h1>Slack is connected</h1>
       <p class="sub">${esc(conn.teamName ?? conn.teamId)} is connected. You stay in control of what Seros may read.</p>
       ${setupRail(selected.length ? 'queue' : 'channels', new Set<import('../views').SetupStep>(
          selected.length ? ['connect', 'channels'] : ['connect']
        ))}
       ${selected.length
          ? notice('good', `${selected.length} channel${selected.length === 1 ? '' : 's'} selected`,
              'Seros reads those channels and nothing else. Drafts still wait for a person to confirm them.')
          : notice('info', 'The next step is choosing channels',
              'Slack is connected, but Seros has not been allowed to read any channels yet.')}
       <div class="card">
         <h3>Channel permission</h3>
         <p class="sub">The channel picker is the permission record. You can change or remove that permission at any time.</p>
         <div class="row">
           <a class="button primary" href="/channels">${selected.length ? 'Manage channels' : 'Choose channels &rarr;'}</a>
           <form method="post" action="/connect/slack/disconnect">
             <input type="hidden" name="csrf" value="${esc(csrf)}">
             <button class="danger" type="submit">Disconnect Slack</button>
           </form>
         </div>
       </div>
       <div class="card"><h3>Scopes granted</h3><p class="meta">These are the Slack permissions granted at connection time.</p><ul>${scopeList}</ul></div>`
    : `<h1>Connect Slack</h1>
       <p class="sub">Choose the Slack workspace, then choose the exact channels Seros may read. Seros drafts work; it never writes without your confirmation.</p>
       ${setupRail('connect', new Set())}
       ${requireAdmin(me?.role)
          ? `<div class="card">
               <h3>Connect, then choose channels</h3>
               <p class="sub">Slack will show its own consent screen. After it returns you here, no channel is read until you select it yourself.</p>
               <div class="row"><form method="post" action="/connect/slack">
                 <input type="hidden" name="csrf" value="${esc(csrf)}">
                 <button class="primary" type="submit">Continue to Slack &rarr;</button>
               </form></div>
             </div>`
          : notice('info', 'An owner or admin connects Slack',
              'Ask a workspace owner or admin to complete this step. You will be able to review drafts once the channels are selected.')}
       <div class="card"><h3>What Seros asks Slack for</h3>
         <p class="sub">The permissions below let Seros list channels, read the ones you select, and return a confirmed tracker link to the source thread.</p>
         <ul>${scopeList}</ul>
       </div>`;
  res.type('html').send(page('Slack', '/connect', body, { member: me as any, csrf }));
}

/** POST /connect/slack - start the install. */
export async function connectStart(req: Request, res: Response) {
  const s = req.serosSession!;
  const db = openDb();
  const scope = await WorkspaceScope.open(db, s.workspaceId);
  const me = await scope.member(s.memberId);
  if (!requireAdmin(me?.role)) {
    await scope.audit('slack.connect_denied', 'denied', { member_id: s.memberId });
    return res.status(403).type('html').send(page('Slack', '/connect', '<h1>Not allowed</h1><p class="sub">An owner or admin connects Slack.</p>'));
  }
  if (!encryptionConfigured()) {
    await scope.audit('slack.connect_denied', 'failed', { reason_code: 'no_encryption_key' });
    return res.status(500).type('html').send(page('Slack', '/connect',
      '<h1>Not configured</h1><p class="sub">SEROS_ENCRYPTION_KEY is not set, so a Slack token cannot be stored safely. Nothing was connected.</p>'));
  }
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    return res.status(500).type('html').send(page('Slack', '/connect',
      '<h1>Not configured</h1><p class="sub">SLACK_CLIENT_ID is not set.</p>'));
  }

  const nonce = crypto.randomBytes(16).toString('base64url');
  state.set(nonce, { workspaceId: s.workspaceId, memberId: s.memberId, at: Date.now() });
  for (const [k, v] of state) if (Date.now() - v.at > STATE_TTL_MS) state.delete(k);

  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', SLACK_SCOPES.join(','));
  url.searchParams.set('redirect_uri', redirectUri(req));
  url.searchParams.set('state', nonce);
  await scope.audit('slack.connect_started', 'ok', { member_id: s.memberId });
  return res.redirect(303, url.toString());
}

/** GET /connect/slack/callback - Slack returns here with a code. */
export async function connectCallback(req: Request, res: Response) {
  const nonce = String(req.query.state ?? '');
  const entry = state.get(nonce);
  state.delete(nonce);
  if (!entry || Date.now() - entry.at > STATE_TTL_MS) {
    // An unmatched state is a forged or stale callback. Nothing is stored.
    return res.status(400).type('html').send(page('Slack', '/connect',
      '<h1>That link expired</h1><p class="sub">Start the connection again from the Slack page.</p>'));
  }
  const code = String(req.query.code ?? '');
  if (!code) return res.redirect(303, '/connect?err=no_code');

  const db = openDb();
  const scope = await WorkspaceScope.open(db, entry.workspaceId);
  try {
    const install = await slackClient().exchangeCode(code, redirectUri(req));
    await scope.saveConnection({
      teamId: install.teamId, teamName: install.teamName, botUserId: install.botUserId,
      tokenEnc: seal(install.botToken), scopes: install.scopes, installedBy: entry.memberId,
    });
    // OPERATIONS-CHECKLIST section 7: source_connected.
    await scope.audit('source_connected', 'ok',
      { provider: 'slack', team_id: install.teamId, member_id: entry.memberId, scopes: install.scopes });
    return res.redirect(303, '/channels?msg=connected');
  } catch (e: any) {
    await scope.audit('slack.connect_failed', 'failed', { reason_code: String(e?.message ?? 'error').slice(0, 60) });
    return res.redirect(303, '/connect?err=exchange_failed');
  }
}

/** POST /connect/slack/disconnect - the token is destroyed and reading stops. */
export async function disconnect(req: Request, res: Response) {
  const s = req.serosSession!;
  const db = openDb();
  const scope = await WorkspaceScope.open(db, s.workspaceId);
  const me = await scope.member(s.memberId);
  if (!requireAdmin(me?.role)) return res.status(403).send('not allowed');
  await scope.revokeConnection();
  await scope.audit('source_disconnected', 'ok', { provider: 'slack', member_id: s.memberId });
  return res.redirect(303, '/connect?msg=disconnected');
}

/** GET /channels - the picker, with the sentence that states the promise. */
export async function channelsPage(req: Request, res: Response) {
  const s = req.serosSession!;
  const db = openDb();
  const scope = await WorkspaceScope.open(db, s.workspaceId);
  const me = await scope.member(s.memberId);
  const conn = await scope.connection();
  const csrf = csrfToken(s);
  if (!conn) return res.redirect(303, '/connect');

  // Refresh the list from Slack, best effort: a Slack outage must not empty the
  // picker and make it look as though the admin de-selected everything.
  try {
    const token = openSecret(conn.tokenEnc);
    if (token) await scope.recordChannels(await slackClient().listChannels(token));
  } catch { /* keep the stored list */ }

  const rows = await scope.channels();
  const items = rows.map((c: any) => `
    <label class="pick">
      <input type="checkbox" name="channel" value="${esc(c.channelId)}"${c.selected ? ' checked' : ''}>
      <span>#${esc(c.name)}</span>
      ${c.isPrivate ? '<span class="pill">private</span>' : ''}
    </label>`).join('');

  const body = `<h1>Choose channels</h1>
    <p class="sub">This is your permission list. Seros reads only the channels you tick, and stores nothing from the rest of Slack.</p>
    ${setupRail('channels', new Set<import('../views').SetupStep>(['connect']))}
    ${items
      ? `<form method="post" action="/channels">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <div class="card">
            <h3>Channels Seros may read</h3>
            <p class="meta">Tick a channel to allow it. Untick it to stop future reads.</p>
            ${items}
          </div>
          <div class="row"><button class="primary" type="submit">Save selection &rarr;</button>
            <a class="button" href="/connect">Back to Slack</a></div>
        </form>`
      : empty('No channels are visible yet',
          'Invite the Seros app to a Slack channel, then return here. We keep the current permission list untouched if Slack is unavailable.',
          '<a class="button" href="/connect">Back to Slack</a>')}`;
  res.type('html').send(page('Channels', '/channels', body, { member: me as any, csrf,
    flash: req.query.msg === 'connected' ? 'Slack connected. Choose the channels Seros may read.' : undefined }));
}

/** POST /channels - the selection is the record of consent. */
export async function channelsSave(req: Request, res: Response) {
  const s = req.serosSession!;
  const db = openDb();
  const scope = await WorkspaceScope.open(db, s.workspaceId);
  const me = await scope.member(s.memberId);
  if (!requireAdmin(me?.role)) return res.status(403).send('not allowed');

  const raw = (req.body ?? {}).channel;
  const ids = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
  await scope.setSelectedChannels(ids);
  await scope.audit('channels_selected', 'ok', { member_id: s.memberId, count: ids.length });
  return res.redirect(303, '/channels?msg=saved');
}
