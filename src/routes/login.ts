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
import { randomUUID } from 'node:crypto';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { accountForEmail } from '../db/system';
import {
  clearSession, startSession, csrfToken, csrfOk, currentSession,
} from '../auth';
import {
  MemberCredentials, hashPassword, verifyPassword, needsRehash, passwordPolicyError,
  passwordMinLength, newInviteToken, normaliseEmail, lockoutPolicy, inviteTtlMs,
} from '../password';
import { page, esc, notice } from '../views';
import { issueCaptcha, consumeCaptcha } from '../captcha';
import type { PageContext } from '../views';

const WS = () => process.env.SEROS_WORKSPACE || 'demo';

/** The one sentence every failed sign-in gets, whatever actually went wrong. */
const DENIED = 'Sign-in failed. Check your details and try again.';

/**
 * The same non-answer, written as help rather than as a verdict. It must not
 * narrow anything down: it lists what the visitor can check, and never which of
 * those things was actually wrong.
 */
const DENIED_HELP =
  'Check the address or member id, and the password. Repeated failures lock the account for a while.';

/** Vendor marks, kept out of the page body so the markup stays readable. */

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

export async function loginPage(req: Request, res: Response) {
  const err = flash(req, 'err');
  const msg = flash(req, 'msg');
  const captcha = await issueCaptcha(openDb(), 'login', req.ip ?? '');

  // Every failure the visitor can cause says the same sentence (see DENIED).
  const errBanner =
      err === 'captcha_failed'
    ? notice('warn', 'That verification did not go through',
        'The answer was wrong or the challenge expired. A fresh one is below.')
    : err
    ? notice('bad', 'Sign-in failed', DENIED_HELP)
    : '';

  const msgBanner = msg ? notice('good', msg) : '';

  const body = `<h1>Sign in</h1>
  <p class="sub">Seros drafts the work; you confirm it.</p>
  ${errBanner}
  ${msgBanner}
  <form class="card" method="post" action="/login">
    <label for="identifier">Email or member id</label>
    <input id="identifier" type="text" name="identifier" autocomplete="username"
           autocapitalize="none" spellcheck="false" value="" required autofocus>

    <label for="password">Password</label>
    <input id="password" type="password" name="password" autocomplete="current-password" value="" required>

    <div class="captcha">
      <label for="captchaAnswer">Human check &mdash; add the two numbers</label>
      <div class="cap-row">
        ${captcha.svg}
        <input id="captchaAnswer" type="text" name="captchaAnswer" inputmode="numeric"
               placeholder="Answer" required autocomplete="off" aria-describedby="cap-help">
      </div>
      <input type="hidden" name="captchaId" value="${esc(captcha.id)}">
    </div>
    <p class="meta" id="cap-help">The challenge expires after a few minutes. A new one loads with the page.</p>

    <div class="row"><button class="primary" type="submit">Sign in &rarr;</button></div>
  </form>

  <p class="meta authhelp">No account yet? <a href="/signup">Create a workspace</a>.</p>`;

  res.type('html').send(page('Sign in', '/login', body, { chrome: 'auth' }));
}

// ---------------------------------------------------------------------------
// GET/POST /signup - create a new workspace and its first owner
// ---------------------------------------------------------------------------

export async function signupPage(req: Request, res: Response) {
  const err = flash(req, 'err');
  const captcha = await issueCaptcha(openDb(), 'signup', req.ip ?? '');
  const body = `<h1>Create your workspace</h1>
  <p class="sub">Start with one owner. You can invite your team after you sign in.</p>
  ${err ? notice('bad', 'We could not create that account', err) : ''}
  <form class="card" method="post" action="/signup">
    <label for="name">Your name</label>
    <input id="name" type="text" name="name" autocomplete="name" maxlength="120" required autofocus>

    <label for="email">Email address</label>
    <input id="email" type="email" name="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" required>

    <label for="workspace">Workspace name</label>
    <input id="workspace" type="text" name="workspace" autocomplete="organization" maxlength="120" required>
    <p class="meta">Use your team or company name. You can connect Slack after you sign in.</p>

    <label for="password">Password</label>
    <input id="password" type="password" name="password" autocomplete="new-password" required aria-describedby="password-help">
    <p class="meta" id="password-help">Use at least ${passwordMinLength()} characters and four distinct characters.</p>

    <div class="captcha">
      <label for="captchaAnswer">Human check &mdash; add the two numbers</label>
      <div class="cap-row">
        ${captcha.svg}
        <input id="captchaAnswer" type="text" name="captchaAnswer" inputmode="numeric" placeholder="Answer" required autocomplete="off">
      </div>
      <input type="hidden" name="captchaId" value="${esc(captcha.id)}">
    </div>
    <div class="row"><button class="primary" type="submit">Create account &rarr;</button></div>
  </form>
  <p class="meta authhelp">Already have an account? <a href="/login">Sign in</a>.</p>`;
  return res.type('html').send(page('Create account', '/signup', body, { chrome: 'auth' }));
}

export async function signupPost(req: Request, res: Response) {
  const captchaAnswer = String(req.body?.captchaAnswer ?? '');
  const captchaId = String(req.body?.captchaId ?? '');
  if (!(await consumeCaptcha(openDb(), captchaId, captchaAnswer, 'signup', req.ip ?? ''))) {
    return res.redirect(303, '/signup?err=' + encodeURIComponent('That verification did not go through. Try the new challenge.'));
  }

  const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const workspaceName = String(req.body?.workspace ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const email = normaliseEmail(req.body?.email);
  const password = String(req.body?.password ?? '');
  const problem = !name ? 'Enter your name.'
    : !workspaceName ? 'Enter a workspace name.'
    : !email ? 'Enter a valid email address.'
    : passwordPolicyError(password);
  if (problem) return res.redirect(303, '/signup?err=' + encodeURIComponent(problem));

  // A signup may create exactly one new random workspace. It never opens, seeds,
  // or grants access to the configured workspace, so anonymous traffic cannot
  // take over an existing tenant.
  const db = openDb();
  if (await accountForEmail(db, email!)) {
    return res.redirect(303, '/login?msg=' + encodeURIComponent('An account already exists for that email. Sign in instead.'));
  }
  const workspaceId = `ws-${randomUUID()}`;
  const memberId = `m-${randomUUID()}`;
  const scope = await WorkspaceScope.ensure(db, workspaceId, workspaceName);
  const creds = MemberCredentials.for(db, scope);
  await scope.addMember(memberId, name, 'owner');
  await creds.setEmail(memberId, email!);
  await creds.setPassword(memberId, await hashPassword(password));
  await scope.audit('workspace.signup', 'ok', { member_id: memberId },
                    { actorType: 'member', actorId: memberId, objectType: 'workspace', objectId: workspaceId });
  const pv = await creds.passwordVersion(memberId);
  startSession(res, { workspaceId, memberId, pv });
  return res.redirect(303, '/queue?msg=' + encodeURIComponent('Workspace created. Connect Slack when you are ready.'));
}

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------

export async function loginPost(req: Request, res: Response) {
  const captchaAnswer = String(req.body?.captchaAnswer ?? '');
  const captchaId = String(req.body?.captchaId ?? '');

  if (!(await consumeCaptcha(openDb(), captchaId, captchaAnswer, 'login', req.ip ?? ''))) {
    return res.redirect(303, '/login?err=captcha_failed');
  }

  const identifier = String(req.body?.identifier ?? req.body?.memberId ?? req.body?.email ?? '').trim().slice(0, 320);
  const password = String(req.body?.password ?? '');
  const db = openDb();
  const configuredWorkspace = WS();
  const email = normaliseEmail(identifier);
  // Email may belong to any self-created workspace. A bare member id remains
  // scoped to the operator-configured workspace because ids are not globally
  // meaningful and must never become a cross-tenant discovery feature.
  const account = email ? await accountForEmail(db, email) : null;
  const workspaceId = account?.workspaceId ?? configuredWorkspace;
  let scope: WorkspaceScope;
  try {
    scope = await WorkspaceScope.open(db, workspaceId);
  } catch {
    await verifyPassword(password, null);
    return deny(req, res, null, null, 'unknown_identifier');
  }
  const creds = MemberCredentials.for(db, scope);
  const now = Date.now();
  const memberId = account?.memberId ?? (email ? '' : identifier);
  const member = memberId ? await scope.member(memberId) : undefined;

  if (!member || member.status !== 'active') {
    // Pay for a hash we will not use, so "no such member" costs what "wrong password" costs.
    await verifyPassword(password, null);
    return deny(req, res, scope, member?.id ?? null, member ? 'not_active' : 'unknown_identifier');
  }

  const row = await creds.get(member.id);

  if (row?.lockedUntil && row.lockedUntil > now) {
    await verifyPassword(password, null);                     // the lock is not a shortcut
    return deny(req, res, scope, member.id, 'locked');
  }

  // A member without a credential cannot sign in AT ALL: not with an empty password,
  // not on a workspace where nobody has one, not with any environment variable set
  // any way. The only cure is an invite or the CLI, both of which need the host.
  if (!row?.passwordHash) {
    await verifyPassword(password, null);
    return deny(req, res, scope, member.id, 'no_password');
  }

  if (!(await verifyPassword(password, row.passwordHash))) {
    const after = await creds.recordFailure(member.id, now);
    const locked = !!after?.lockedUntil && after.lockedUntil > now;
    return deny(req, res, scope, member.id, locked ? 'locked' : 'bad_password', after?.failedAttempts ?? 0);
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
  startSession(res, { workspaceId, memberId: member.id, pv });
  await scope.audit('session.started', 'ok', { member_id: member.id, mode: 'password' },
                    { actorType: 'member', actorId: member.id, objectType: 'member', objectId: member.id });
  return res.redirect(303, '/queue');
}

/** Identical body, identical status, for every reason. The reason goes to the audit log. */
async function deny(req: Request, res: Response, scope: WorkspaceScope | null, memberId: string | null, reason: Reason, attempts = 0) {
  if (scope) {
    // awaited: on Postgres this insert is a promise, and a denial nobody waits for
    // is a failed sign-in that never reaches the audit log.
    await scope.audit('session.failed', 'denied',
      memberId ? { member_id: memberId, reason, attempts } : { reason },
      memberId ? { actorType: 'member', actorId: memberId, objectType: 'member', objectId: memberId } : {});
  }
  // A 401 cannot redirect, so the form is rendered again here. It carries a fresh
  // CAPTCHA, because the one the visitor just used has now been spent.
  const captcha = await issueCaptcha(openDb(), 'login', req.ip ?? '');
  const body = `<h1>Sign in</h1>
  <p class="sub">Seros drafts the work; you confirm it.</p>
  ${notice('bad', 'Sign-in failed', DENIED_HELP)}
  <form class="card" method="post" action="/login">
    <label for="identifier">Email or member id</label>
    <input id="identifier" type="text" name="identifier" autocomplete="username"
           autocapitalize="none" spellcheck="false" value="" required autofocus>
    <label for="password">Password</label>
    <input id="password" type="password" name="password" autocomplete="current-password" required>
    <div class="captcha">
      <label for="captchaAnswer">Human check &mdash; add the two numbers</label>
      <div class="cap-row">
        ${captcha.svg}
        <input id="captchaAnswer" type="text" name="captchaAnswer" inputmode="numeric"
               placeholder="Answer" required autocomplete="off">
      </div>
      <input type="hidden" name="captchaId" value="${esc(captcha.id)}">
    </div>
    <div class="row"><button class="primary" type="submit">Sign in &rarr;</button></div>
  </form>`;
  return res.status(401).type('html').send(page('Sign in', '/login', body, { chrome: 'auth' }));
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
  let scope: WorkspaceScope | null = null;
  try { scope = await WorkspaceScope.open(db, WS()); } catch { /* invalid link */ }
  const creds = scope ? MemberCredentials.for(db, scope) : null;
  const ok = token.length > 0 && !!creds && await creds.inviteValid(token);
  const err = flash(req, 'err');

  const body = ok
    ? `<h1>Choose a password</h1>
       <p class="sub">This is the last step. You will be signed in straight afterwards.</p>
       ${err ? notice('bad', 'That password was not accepted', err) : ''}
       <form class="card" method="post" action="/set-password">
         <input type="hidden" name="token" value="${esc(token)}">
         <label for="password">New password</label>
         <input id="password" type="password" name="password" autocomplete="new-password" required autofocus
                minlength="${esc(String(passwordMinLength()))}" aria-describedby="pw-rule">
         <p class="meta" id="pw-rule">At least ${esc(String(passwordMinLength()))} characters. Longer beats complicated.</p>
         <label for="confirm">New password again</label>
         <input id="confirm" type="password" name="confirm" autocomplete="new-password" required
                minlength="${esc(String(passwordMinLength()))}">
         <div class="row"><button class="primary" type="submit">Set password and sign in &rarr;</button></div>
       </form>
       <p class="meta authhelp">This link works once, then stops working.</p>`
    : `<h1>That invite link has expired</h1>
       <p class="sub">Nothing is wrong with your account.</p>
       ${notice('warn', 'An invite works once, and not forever',
          'This one has already been used or has passed its expiry. An owner or admin of your workspace can issue another in a few seconds.')}
       <div class="row"><a class="button" href="/login">Back to sign in</a></div>`;
  res.type('html').send(page('Choose a password', '/login', body, { chrome: 'auth' }));
}

export async function setPasswordPost(req: Request, res: Response) {
  const token = String(req.body?.token ?? '');
  const password = String(req.body?.password ?? '');
  const confirm = String(req.body?.confirm ?? '');
  const db = openDb();
  const ws = WS();
  let scope: WorkspaceScope;
  try { scope = await WorkspaceScope.open(db, ws); }
  catch { return res.redirect(303, '/set-password'); }
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

  const body = `<h1>Your password</h1>
  <p class="sub">${has
      ? 'Changing it signs out every other session, including one someone else is holding.'
      : 'You have no password yet. Setting one is how you sign in without an invite link.'}</p>
  ${err ? notice('bad', 'That change was not made', err) : ''}
  ${msg ? notice('good', msg) : ''}
  <form class="card" method="post" action="/password">
    <input type="hidden" name="csrf" value="${esc(csrfToken(s))}">
    ${has ? `<label for="current">Current password</label>
    <input id="current" type="password" name="current" size="34" autocomplete="current-password" required>` : ''}
    <label for="password">New password</label>
    <input id="password" type="password" name="password" size="34" autocomplete="new-password" required
           minlength="${esc(String(passwordMinLength()))}" aria-describedby="pw-rule">
    <p class="meta" id="pw-rule">At least ${esc(String(passwordMinLength()))} characters. Longer beats complicated.</p>
    <label for="confirm">New password again</label>
    <input id="confirm" type="password" name="confirm" size="34" autocomplete="new-password" required
           minlength="${esc(String(passwordMinLength()))}">
    <div class="row"><button class="primary" type="submit">${has ? 'Change password' : 'Set password'}</button></div>
  </form>
  ${has ? '' : notice('info', 'Until you set one, an invite link is your only way in',
      'Invite links expire, so a password is what keeps the account reachable.')}`;
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

/**
 * An invite is useless as a bare path. The owner sees this string once and has to
 * paste it into Slack or email, so it must be the whole absolute URL: a relative
 * `/set-password?token=...` is easy to send and impossible for the invitee to open.
 */
function inviteUrl(req: Request, token: string): string {
  const base = (process.env.SEROS_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/set-password?token=${encodeURIComponent(token)}`;
}

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
  const body = `<h1>Members</h1>
  <p class="sub">Who can sign in, and whether they have a credential yet. No hashes, no tokens.</p>
  ${token ? `<div class="card"><p class="meta">Invite for ${esc(issuedFor)} — shown once, not stored, expires in
      ${esc(String(Math.round(inviteTtlMs() / 3_600_000)))}h</p>
      <p><a href="${esc(inviteUrl(req, token))}">${esc(inviteUrl(req, token))}</a></p>
      <label class="meta" for="invite-url">Copy the whole link — a partial one will not work</label>
      <input id="invite-url" type="text" readonly size="60" value="${esc(inviteUrl(req, token))}"
             aria-describedby="invite-note">
      <p class="meta" id="invite-note">Select and copy this full link, then send it to ${esc(issuedFor)}. It is not shown again.</p></div>` : ''}
  <div class="tablewrap"><table>
    <tr><th>Member</th><th>Role</th><th>Status</th><th>Password</th><th>Locked</th>${mayInvite ? '<th></th>' : ''}</tr>
    ${rows.map((m) => `<tr>
      <td>${esc(m.name)}<br><span class="meta">${esc(m.id)}</span></td>
      <td>${esc(m.role)}</td><td>${esc(m.status)}</td>
      <td>${m.cred.has_password ? '<span class="pill ok">set</span>' : (m.cred.invite_outstanding ? '<span class="pill">invited</span>' : '<span class="pill">none</span>')}</td>
      <td>${m.cred.locked_until && m.cred.locked_until > Date.now() ? '<span class="pill">locked</span>' : ''}</td>
      ${mayInvite ? `<td><form method="post" action="/members/invite">
        <input type="hidden" name="csrf" value="${esc(csrfToken(s))}">
        <input type="hidden" name="memberId" value="${esc(m.id)}">
        <button type="submit">Invite</button></form></td>` : ''}
    </tr>`).join('')}
  </table></div>`;
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
      `<h1>Members</h1>${notice('bad', 'You cannot issue an invite',
        'Only an owner or an admin can invite members to this workspace.')}`));
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
