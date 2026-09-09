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
import { page, esc, empty, notice, setupRail, errorPage } from '../views';
import type { ErrorAction, PageContext } from '../views';

/**
 * What a failed Slack return actually means, in the words of the admin who
 * pressed the button. The callback redirects here with `?err=<code>` rather than
 * rendering, so without this map the page came back looking like nothing had
 * happened at all.
 *
 * The codes are a closed set matched exactly. A value that is not one of them
 * gets the generic entry, so a provider string or an injected query value is
 * never the source of the words on the page - only ever the trigger for a
 * sentence written here.
 */
const CONNECT_ERR: Record<string, [string, string]> = {
  no_code: [
    'Slack returned without granting access',
    'The consent screen was cancelled or closed before it finished. Nothing was connected and no token was stored. Start the connection again when you are ready.',
  ],
  exchange_failed: [
    'Slack was reached, but the connection could not be completed',
    'Slack did not issue a usable token, so nothing was stored and no channel is being read. Try again; if it keeps failing, an owner should confirm the Slack app is still installed and that its redirect URL matches this site.',
  ],
  denied: [
    'That Slack workspace declined the request',
    'A Slack administrator has to approve the Seros app before it can be connected. Nothing was stored.',
  ],
};
const CONNECT_ERR_FALLBACK: [string, string] = [
  'The Slack connection did not complete',
  'Nothing was connected and no token was stored. Start the connection again from this page.',
];

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

/** A one-shot query value, bounded, exactly as the sign-in pages read theirs. */
const flash = (req: Request, key: string) =>
  (typeof req.query[key] === 'string' ? String(req.query[key]).slice(0, 200) : '');

/**
 * The banner for a failed return from Slack. `role="alert"` comes from
 * notice('bad'), so it is announced rather than only drawn, and the retry is a
 * link to this same page - the connect button lives here, and a person who has
 * just been bounced back should not have to find it again.
 */
/**
 * The page an admin-only mutation gives a role that may not perform it. Kept
 * beside the other refusals so /connect, /channels and the disconnect control all
 * refuse in the same words and with the same way back. The 403 is the caller's;
 * this only writes the body.
 */
function adminOnly(
  res: Response, cause: string, detail: string,
  opts: { title: string; active: string; back: ErrorAction; ctx: PageContext },
) {
  return res.status(403).type('html').send(errorPage(403, cause, detail, {
    title: opts.title, active: opts.active, ctx: opts.ctx,
    actions: [opts.back, { href: '/queue', label: 'Go to the queue' }],
  }));
}

function connectErrBanner(err: string): string {
  if (!err) return '';
  const [cause, detail] = CONNECT_ERR[err] ?? CONNECT_ERR_FALLBACK;
  return notice('bad', cause, detail,
    `<p><a href="/connect">Try connecting Slack again</a></p>`);
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
  // A failed callback comes back here as ?err=..., not as a rendered page. Show it,
  // or the person sees the page they started on and no reason for being there.
  const errBanner = connectErrBanner(flash(req, 'err'));

  const scopeList = SLACK_SCOPES.map((x) => `<li><code>${esc(x)}</code></li>`).join('');
  const body = conn
    ? `<h1>Slack is connected</h1>
       <p class="sub">${esc(conn.teamName ?? conn.teamId)} is connected. You stay in control of what Seros may read.</p>
       ${errBanner}
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
       ${errBanner}
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
  const ctx = { member: me as any, csrf: csrfToken(s) };
  if (!requireAdmin(me?.role)) {
    await scope.audit('slack.connect_denied', 'denied', { member_id: s.memberId });
    return res.status(403).type('html').send(errorPage(403,
      'Your role cannot connect Slack',
      'Only a workspace owner or admin can connect a source. Ask one of them to complete this step; you will be able to review drafts once the channels are selected.',
      { title: 'Slack', active: '/connect', ctx,
        actions: [{ href: '/connect', label: 'Back to Slack', primary: true }, { href: '/queue', label: 'Go to the queue' }] }));
  }
  if (!encryptionConfigured()) {
    await scope.audit('slack.connect_denied', 'failed', { reason_code: 'no_encryption_key' });
    return res.status(500).type('html').send(errorPage(500,
      'This deployment cannot store a Slack token safely yet',
      'Slack was not contacted and nothing was connected. An operator has to finish configuring this deployment before a source can be connected.',
      { heading: 'Slack is not configured here', title: 'Slack', active: '/connect', ctx,
        actions: [{ href: '/connect', label: 'Back to Slack', primary: true }, { href: '/queue', label: 'Go to the queue' }] }));
  }
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    return res.status(500).type('html').send(errorPage(500,
      'This deployment has no Slack application configured',
      'Slack was not contacted and nothing was connected. An operator has to finish configuring this deployment before a source can be connected.',
      { heading: 'Slack is not configured here', title: 'Slack', active: '/connect', ctx,
        actions: [{ href: '/connect', label: 'Back to Slack', primary: true }, { href: '/queue', label: 'Go to the queue' }] }));
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
  if (!requireAdmin(me?.role)) {
    return adminOnly(res,
      'Your role cannot disconnect Slack',
      'Only a workspace owner or admin can remove a source. Slack is still connected and nothing was deleted.',
      { title: 'Slack', active: '/connect', ctx: { member: me as any, csrf: csrfToken(s) },
        back: { href: '/connect', label: 'Back to Slack', primary: true } });
  }
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
  if (!requireAdmin(me?.role)) {
    return adminOnly(res,
      'Your role cannot change which channels Seros reads',
      'The channel selection is the workspace permission record, so only an owner or admin can change it. Nothing was changed and the current selection still stands.',
      { title: 'Channels', active: '/channels', ctx: { member: me as any, csrf: csrfToken(s) },
        back: { href: '/channels', label: 'Back to channels', primary: true } });
  }

  const raw = (req.body ?? {}).channel;
  const ids = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
  await scope.setSelectedChannels(ids);
  await scope.audit('channels_selected', 'ok', { member_id: s.memberId, count: ids.length });
  return res.redirect(303, '/channels?msg=saved');
}
