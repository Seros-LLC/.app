import type { Request, Response } from 'express';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { setSession, clearSession } from '../auth';
import { page, esc } from '../views';

const WS = () => process.env.SEROS_WORKSPACE || 'demo';

export function loginPage(_req: Request, res: Response) {
  const db = openDb();
  const roster = WorkspaceScope.ensure(db, WS()).rosterWithRoles();
  const body = `<h1>Sign in</h1>
  <p class="sub">There is no password yet, and that is a known hole — but a confirmation is
  now attributable to whoever holds this session, and nothing can be confirmed without one.</p>
  ${roster.length === 0 ? `<div class="empty">No members in workspace <b>${esc(WS())}</b>. Run <code>npm run seed</code>.</div>` :
  `<form class="card" method="post" action="/login">
    <label for="m">Sign in as</label>
    <select id="m" name="memberId">
      ${roster.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} — ${esc(m.role)}</option>`).join('')}
    </select>
    <div class="row"><button class="primary" type="submit">Continue</button></div>
  </form>`}`;
  res.type('html').send(page('Sign in', '/login', body));
}

export function loginPost(req: Request, res: Response) {
  const db = openDb();
  const memberId = String(req.body?.memberId ?? '');
  const scope = WorkspaceScope.open(db, WS());
  const m = scope.member(memberId);
  if (!m || m.status !== 'active') return res.status(403).send('no such active member');
  setSession(res, { workspaceId: WS(), memberId: m.id, issuedAt: Date.now() });
  scope.audit('session.started', 'ok', { member_id: m.id });
  return res.redirect(303, '/queue');
}

export function logoutPost(_req: Request, res: Response) {
  clearSession(res);
  return res.redirect(303, '/login');
}
