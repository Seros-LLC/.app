/**
 * Sign in, sign out, redeem an invite, change your own password.
 *
 * What used to be here: a dropdown of every member in the workspace, and a POST
 * that trusted whichever one you picked. That is gone. Three things went with it:
 * the roster is no longer readable by an anonymous visitor, a session now costs a
 * secret, and every outcome - good or bad - lands in the audit log.
 *
 * The rule this file is written around: A FAILED SIGN-IN MUST NOT SAY WHY.
 * Unknown member id, unknown address, wrong password, no password set, locked out
 * - all of them return the same status, the same sentence and, because the unknown
 * paths still pay for a full scrypt, a comparable amount of time. The reason is
 * recorded in the audit log, where the operator can see it and the attacker cannot.
 */
import type { Request, Response } from 'express';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import {
  clearSession, startSession, csrfToken, csrfOk, currentSession,
} from '../auth';
import {
  MemberCredentials, hashPassword, verifyPassword, needsRehash, passwordPolicyError,
  passwordMinLength, newInviteToken, normaliseEmail, lockoutPolicy, inviteTtlMs,
} from '../password';
import { page, esc } from '../views';
import type { PageContext } from '../views';

const WS = () => process.env.SEROS_WORKSPACE || 'demo';

/** The one sentence every failed sign-in gets, whatever actually went wrong. */
const DENIED = 'Sign-in failed. Check your details and try again.';

type Reason = 'unknown_identifier' | 'not_active' | 'no_password' | 'bad_password' | 'locked';

const ctxFor = async (req: Request, scope: WorkspaceScope): Promise<PageContext> => {
  const s = req.serosSession ?? currentSession(req);
  const m = s ? await scope.member(s.memberId) : undefined;
  return {
    member: m ? { id: m.id, name: m.name, role: m.role } : undefined,
    csrf: s ? csrfToken(s) : undefined,
  };
};

const flash = (req: Request, key: string) =>
  (typeof req.query[key] === 'string' ? String(req.query[key]).slice(0, 200) : '');

// ---------------------------------------------------------------------------
// GET /login
// ---------------------------------------------------------------------------

export function loginPage(req: Request, res: Response) {
  // The page reads nothing about who works here, and says nothing about it either.
  const err = flash(req, 'err');
  const msg = flash(req, 'msg');

  const body = `<h1>Sign in</h1>
  <p class="sub">Your email address or your member id, and your password.</p>
  <div class="empty">${DENIED}</div>
  <form class="card" method="post" action="/login">
    <label for="identifier">Email or member id</label>
    <input id="identifier" type="text" name="identifier" size="34" autocomplete="username" value="">
    <label for="password">Password</label>
    <input id="password" type="password" name="password" size="34" autocomplete="current-password">
    <div class="row"><button class="primary" type="submit">Sign in</button></div>
  </form>
  <div class="oauth-buttons">
    ${process.env.GOOGLE_CLIENT_ID ? `<a href="/auth/google" class="oauth-btn google-btn">Sign in with Google</a>` : ''}
    ${process.env.GITHUB_CLIENT_ID ? `<a href="/auth/github" class="oauth-btn github-btn">Sign in with GitHub</a>` : ''}
  </div>`;
  res.type('html').send(page('Sign in', '/login', body));
}

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------

export async function loginPost(req: Request, res: Response) {
  const db = openDb();
  const ws = WS();
  let scope: WorkspaceScope;
  try {
    scope = await WorkspaceScope.open(db, ws);
  } catch {
    return deny(res, null, null, 'unknown_identifier');       // no workspace: same answer as always
  }
  const creds = MemberCredentials.for(db, scope);
  const now = Date.now();

  const identifier = String(req.body?.identifier ?? req.body?.memberId ?? req.body?.email ?? '').trim().slice(0, 320);
  const password = String(req.body?.password ?? '');

  // email OR member id: an address wins if it resolves, otherwise it is an id.
  const email = normaliseEmail(identifier);
  const byEmailResult = email ? await creds.byEmail(email) : undefined;
  const memberId = (byEmailResult?.memberId) ?? (email ? '' : identifier);
  const member = memberId ? await scope.member(memberId) : undefined;

  if (!member || member.status !== 'active') {
    // Pay for a hash we will not use, so "no such member" costs what "wrong password" costs.
    await verifyPassword(password, null);
    return deny(res, scope, member?.id ?? null, member ? 'not_active' : 'unknown_identifier');
  }

  const row = await creds.get(member.id);

  if (row?.lockedUntil && row.lockedUntil > now) {
    await verifyPassword(password, null);                     // the lock is not a shortcut
    return deny(res, scope, member.id, 'locked');
  }

  // A member without a credential cannot sign in AT ALL: not with an empty password,
  // not on a workspace where nobody has one, not with any environment variable set
  // any way. The only cure is an invite or the CLI, both of which need the host.
  if (!row?.passwordHash) {
    await verifyPassword(password, null);
    return deny(res, scope, member.id, 'no_password');
  }

  if (!(await verifyPassword(password, row.passwordHash))) {
    const after = await creds.recordFailure(member.id, now);
    const locked = !!after?.lockedUntil && after.lockedUntil > now;
    return deny(res, scope, member.id, locked ? 'locked' : 'bad_password', after?.failedAttempts ?? 0);
  }

  // Correct. Upgrade the stored parameters if they have moved on; this does NOT
  // count as a password change, so other sessions are left alone.
  if (needsRehash(row.passwordHash)) {
    try { await creds.updateHash(member.id, await hashPassword(password)); } catch { /* not worth failing a sign-in */ }
  }
  await creds.recordSuccess(member.id, now);

  // Rotation: a brand new session id and issue time, so nothing that existed before
  // this request is the session that exists after it.
  // The session id itself is deliberately NOT recorded: the audit page is readable by
  // every member, and a session identifier is not theirs to read.
  const pv = await creds.passwordVersion(member.id);
  startSession(res, { workspaceId: ws, memberId: member.id, pv });
  await scope.audit('session.started', 'ok', { member_id: member.id, mode: 'password' },
                    { actorType: 'member', actorId: member.id, objectType: 'member', objectId: member.id });
  return res.redirect(303, '/queue');
}

/** Identical body, identical status, for every reason. The reason goes to the audit log. */
async function deny(res: Response, scope: WorkspaceScope | null, memberId: string | null, reason: Reason, attempts = 0) {
  if (scope) {
    // awaited: on Postgres this insert is a promise, and a denial nobody waits for
    // is a failed sign-in that never reaches the audit log.
    await scope.audit('session.failed', 'denied',
      memberId ? { member_id: memberId, reason, attempts } : { reason },
      memberId ? { actorType: 'member', actorId: memberId, objectType: 'member', objectId: memberId } : {});
  }
  const body = `<h1>Sign in</h1>
  <p class="sub">Your email address or your member id, and your password.</p>
  <div class="empty">${DENIED}</div>
  <form class="card" method="post" action="/login">
    <label for="identifier">Email or member id</label>
    <input id="identifier" type="text" name="identifier" size="34" autocomplete="username" value="">
    <label for="password">Password</label>
    <input id="password" type="password" name="password" size="34" autocomplete="current-password">
    <div class="row"><button class="primary" type="submit">Sign in</button></div>
  </form>`;
  return res.status(401).type('html').send(page('Sign in', '/login', body));
}

// ---------------------------------------------------------------------------
// POST /logout
// ---------------------------------------------------------------------------

/**
 * Mounted before requireSession/requireCsrf in server.ts, so it checks its own
 * token: signing someone out across origins is small, but it is still a write.
 */
export async function logoutPost(req: Request, res: Response) {
  const s = currentSession(req);
  if (s && !csrfOk(s, (req.body ?? {}).csrf)) {
    console.log(JSON.stringify({ level: 'warn', event: 'csrf.rejected', path: '/logout' }));
    return res.status(403).send('bad csrf token');
  }
  if (s) {
    try {
      const scope = await WorkspaceScope.open(openDb(), s.workspaceId);
      await scope.audit('session.ended', 'ok', { member_id: s.memberId },
                        { actorType: 'member', actorId: s.memberId });
    } catch { /* a session for a workspace that no longer exists still gets signed out */ }
  }
  clearSession(res);
  return res.redirect(303, '/login');
}

// ---------------------------------------------------------------------------
// GET/POST /set-password  - redeem a single-use invite
// ---------------------------------------------------------------------------

export async function setPasswordPage(req: Request, res: Response) {
  const token = String(req.query.token ?? req.body?.token ?? '');
  const db = openDb();
  const scope = await WorkspaceScope.ensure(db, WS());
  const creds = MemberCredentials.for(db, scope);
  const ok = token.length > 0 && await creds.inviteValid(token);
  const err = flash(req, 'err');

  const body = `<h1>Sign in</h1>
  <p class="sub">Your email address or your member id, and your password.</p>
  <div class="empty">${DENIED}</div>
  <form class="card" method="post" action="/login">
    <label for="identifier">Email or member id</label>
    <input id="identifier" type="text" name="identifier" size="34" autocomplete="username" value="">
    <label for="password">Password</label>
    <input id="password" type="password" name="password" size="34" autocomplete="current-password">
    <div class="row"><button class="primary" type="submit">Sign in</button></div>
  </form>`;
  res.type('html').send(page('Choose a password', '/login', body));
}

export async function setPasswordPost(req: Request, res: Response) {
  const token = String(req.body?.token ?? '');
  const password = String(req.body?.password ?? '');
  const confirm = String(req.body?.confirm ?? '');
  const db = openDb();
  const ws = WS();
  const scope = await WorkspaceScope.ensure(db, ws);
  const creds = MemberCredentials.for(db, scope);

  const problem = passwordPolicyError(password) ?? (password === confirm ? null : 'Those two passwords are not the same.');
  if (problem) {
    // The token is NOT spent on a password we refused: check it first, claim it last.
    if (!(await creds.inviteValid(token))) return res.redirect(303, '/set-password');
    return res.redirect(303, '/set-password?token=' + encodeURIComponent(token) + '&err=' + encodeURIComponent(problem));
  }

  const claimed = await creds.claimInvite(token);          // single use, atomic, time-limited
  if (!claimed) {
    await scope.audit('password.set', 'denied', { reason: 'invite_invalid' });
    return res.redirect(303, '/set-password');
  }
  const member = await scope.member(claimed.memberId);
  if (!member || member.status === 'removed') {
    await scope.audit('password.set', 'denied', { member_id: claimed.memberId, reason: 'not_a_member' });
    return res.redirect(303, '/login?err=' + encodeURIComponent(DENIED));
  }

  await creds.setPassword(member.id, await hashPassword(password));
  await scope.audit('password.set', 'ok', { member_id: member.id, method: 'invite' },
                    { actorType: 'member', actorId: member.id, objectType: 'member', objectId: member.id });

  // They proved the token and chose the secret: sign them in on a NEW session.
  const pv = await creds.passwordVersion(member.id);
  startSession(res, { workspaceId: ws, memberId: member.id, pv });
  await scope.audit('session.started', 'ok', { member_id: member.id, mode: 'invite' },
                    { actorType: 'member', actorId: member.id, objectType: 'member', objectId: member.id });
  return res.redirect(303, '/queue?msg=' + encodeURIComponent('Password set. You are signed in.'));
}

// ---------------------------------------------------------------------------
// GET/POST /password  - change your own
// ---------------------------------------------------------------------------

export async function passwordPage(req: Request, res: Response) {
  const s = req.serosSession!;                                  // requireSession guarantees this
  const db = openDb();
  const scope = await WorkspaceScope.open(db, s.workspaceId);
  const creds = MemberCredentials.for(db, scope);
  const has = !!(await creds.get(s.memberId))?.passwordHash;
  const err = flash(req, 'err');
  const msg = flash(req, 'msg');

  const body = `<h1>Sign in</h1>
  <p class="sub">Your email address or your member id, and your password.</p>
  <div class="empty">${DENIED}</div>
  <form class="card" method="post" action="/login">
    <label for="identifier">Email or member id</label>
    <input id="identifier" type="text" name="identifier" size="34" autocomplete="username" value="">
    <label for="password">Password</label>
    <input id="password" type="password" name="password" size="34" autocomplete="current-password">
    <div class="row"><button class="primary" type="submit">Sign in</button></div>
  </form>`;
  res.type('html').send(page('Your password', '/password', body, await ctxFor(req, scope)));
}

export async function passwordChangePost(req: Request, res: Response) {
  const s = req.serosSession!;
  const db = openDb();
  const scope = await WorkspaceScope.open(db, s.workspaceId);
  const creds = MemberCredentials.for(db, scope);
  const member = await scope.member(s.memberId);
  if (!member || member.status !== 'active') {
    await scope.audit('password.changed', 'denied', { member_id: s.memberId, reason: 'not_active' });
    clearSession(res);
    return res.redirect(303, '/login');
  }

  const row = await creds.get(member.id);
  const current = String(req.body?.current ?? '');
  const password = String(req.body?.password ?? '');
  const confirm = String(req.body?.confirm ?? '');
  const bad = (why: string) => res.redirect(303, '/password?err=' + encodeURIComponent(why));

  // Proving you hold the session is not enough to replace the secret; you must
  // also hold the secret, so a borrowed browser cannot lock the owner out.
  if (row?.passwordHash) {
    if (!(await verifyPassword(current, row.passwordHash))) {
      await creds.recordFailure(member.id);
      await scope.audit('password.changed', 'denied', { member_id: member.id, reason: 'bad_current' },
                        { actorType: 'member', actorId: member.id, objectType: 'member', objectId: member.id });
      return bad('That current password is not right.');
    }
  }

  const problem = passwordPolicyError(password) ?? (password === confirm ? null : 'Those two passwords are not the same.');
  if (problem) return bad(problem);
  if (row?.passwordHash && await verifyPassword(password, row.passwordHash)) {
    return bad('That is the password you already have.');
  }

  await creds.setPassword(member.id, await hashPassword(password));
  const first = !row?.passwordHash;
  await scope.audit(first ? 'password.set' : 'password.changed', 'ok',
                    { member_id: member.id, method: 'self_service' },
                    { actorType: 'member', actorId: member.id, objectType: 'member', objectId: member.id });

  // password_set_at moved, so every session issued against the old password - every
  // one but this one - stops being a session at the next request it makes.
  const pv = await creds.passwordVersion(member.id);
  startSession(res, { workspaceId: s.workspaceId, memberId: member.id, pv });
  await scope.audit('session.rotated', 'ok', { member_id: member.id, reason: 'password_change' },
                    { actorType: 'member', actorId: member.id });
  return res.redirect(303, '/password?msg=' + encodeURIComponent('Password changed. Other sessions were signed out.'));
}

// ---------------------------------------------------------------------------
// GET /members, POST /members/invite  - an admin issues a single-use invite
// ---------------------------------------------------------------------------

const CAN_INVITE = new Set(['owner', 'admin']);

export async function membersPage(req: Request, res: Response) {
  const s = req.serosSession!;
  const db = openDb();
  const scope = await WorkspaceScope.open(db, s.workspaceId);
  const creds = MemberCredentials.for(db, scope);
  const me = await scope.member(s.memberId);
  const mayInvite = !!me && me.status === 'active' && CAN_INVITE.has(me.role);
  const issuedFor = flash(req, 'member');
  const token = flash(req, 'token');            // shown once, from the POST that made it

  const rows = await Promise.all((await scope.rosterWithRoles())
    .map(async (m) => ({ ...m, cred: await creds.status(m.id) })));
  const body = `<h1>Sign in</h1>
  <p class="sub">Your email address or your member id, and your password.</p>
  <div class="empty">${DENIED}</div>
  <form class="card" method="post" action="/login">
    <label for="identifier">Email or member id</label>
    <input id="identifier" type="text" name="identifier" size="34" autocomplete="username" value="">
    <label for="password">Password</label>
    <input id="password" type="password" name="password" size="34" autocomplete="current-password">
    <div class="row"><button class="primary" type="submit">Sign in</button></div>
  </form>`;
  res.type('html').send(page('Members', '/members', body, await ctxFor(req, scope)));
}

export async function invitePost(req: Request, res: Response) {
  const s = req.serosSession!;
  const db = openDb();
  const scope = await WorkspaceScope.open(db, s.workspaceId);
  const creds = MemberCredentials.for(db, scope);
  const me = await scope.member(s.memberId);
  const target = await scope.member(String(req.body?.memberId ?? ''));

  if (!me || me.status !== 'active' || !CAN_INVITE.has(me.role)) {
    await scope.audit('invite.issued', 'denied', { member_id: s.memberId, reason: 'role' },
                      { actorType: 'member', actorId: s.memberId });
    return res.status(403).type('html').send(page('Members', '/members',
      '<h1>Members</h1><div class="empty">Only an owner or an admin can issue an invite.</div>'));
  }
  if (!target || target.status === 'removed') {
    await scope.audit('invite.issued', 'denied', { reason: 'no_such_member' },
                      { actorType: 'member', actorId: s.memberId });
    return res.redirect(303, '/members');
  }

  const { token, hash } = newInviteToken();
  const expiresAt = await creds.issueInvite(target.id, hash);
  // The RAW token is never written down: not here, not in the log, not in the audit row.
  await scope.audit('invite.issued', 'ok', { member_id: target.id, expires_at: expiresAt },
                    { actorType: 'member', actorId: me.id, objectType: 'member', objectId: target.id });
  return res.redirect(303, '/members?member=' + encodeURIComponent(target.id) +
                           '&token=' + encodeURIComponent(token));
}

/** Kept for the tests and the CLI: the lockout numbers actually in force. */
export const lockout = lockoutPolicy;
export { DENIED as SIGN_IN_DENIED };
