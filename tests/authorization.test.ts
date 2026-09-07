/**
 * tests/authorization.test.ts — role enforcement for state-changing routes.
 *
 * TESTING-STRATEGY §1 requires each role to do exactly what the permission
 * matrix says, with viewer unable to confirm. Before this file, route behavior
 * was only inspected manually. These tests call the actual route handlers and
 * verify both the HTTP decision and the durable database side effect.
 *
 * Matrix exercised here:
 *   owner/admin     invite members, change selected channels, disconnect Slack,
 *                   and confirm drafts
 *   confirmer       confirm drafts, but not administrative mutations
 *   viewer          read-only, including no confirmation
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

process.env.SEROS_SESSION_SECRET = 'test-session-secret-for-authz-123456';
process.env.SEROS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.SEROS_SLACK = 'fake';

import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { actionMeter, confirmations, jobs, tasks, memberCredentials } from '../src/db/schema';
import { seal } from '../src/crypto';
import { csrfToken, type Session } from '../src/auth';
import { confirmHandler } from '../src/routes/confirm';
import { invitePost } from '../src/routes/login';
import { channelsSave, disconnect } from '../src/routes/connect';
import { and, eq } from 'drizzle-orm';

const WS = 'ws-authz';
const roles = ['owner', 'admin', 'confirmer', 'viewer'] as const;
type Role = typeof roles[number];

function pathFor(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `seros-authz-${label}-`)), 'test.db');
}

async function fresh(role: Role, label: string = role) {
  const path = pathFor(label);
  await migrateDbAsync(path);
  process.env.SEROS_DB = path;
  const db = openDb(path);
  const scope = await WorkspaceScope.ensure(db, WS);
  for (const r of roles) await scope.addMember(`u-${r}`, r[0]!.toUpperCase() + r.slice(1), r);
  const session: Session = { workspaceId: WS, memberId: `u-${role}`, issuedAt: Date.now(), sid: `sid-${role}`, pv: 0 };
  return { db, scope, session, path };
}

function request(session: Session, body: Record<string, unknown>): any {
  return { serosSession: session, body };
}

function response() {
  let statusCode = 200;
  let body = '';
  let redirectTo = '';
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    type(_type: string) { return res; },
    send(value: unknown) { body = String(value); return res; },
    redirect(code: number, location: string) { statusCode = code; redirectTo = location; return res; },
    setHeader() { return res; },
  };
  return { res, get status() { return statusCode; }, get body() { return body; }, get redirect() { return redirectTo; } };
}

async function draftFor(scope: WorkspaceScope, authorId = 'u-owner') {
  const message = await scope.ingestMessage({
    channelId: 'C-authz', ts: `${Date.now()}.1`, authorId, body: 'I will complete the access review tomorrow',
  });
  const draftId = await scope.createDraft({
    sourceMessageId: message.row.id, title: 'Complete access review', outcome: 'Review access',
    kind: 'commitment', confidence: 90, suggestedOwner: null, suggestedDueDate: null,
    provider: 'fake',
  });
  return draftId;
}

async function count(db: any, table: any, workspaceId = WS) {
  return (await db.select().from(table).where(eq(table.workspaceId, workspaceId))).length;
}

// ------------------------------------------------------------- confirmation gate

for (const role of roles) {
  test(`${role} confirmation permission matches the matrix`, async () => {
    const { db, scope, session } = await fresh(role, `confirm-${role}`);
    const draftId = await draftFor(scope);
    const beforeConfirmations = await count(db, confirmations);
    const beforeTasks = await count(db, tasks);
    const out = response();

    await confirmHandler(request(session, {
      draftId, decision: 'confirm', csrf: csrfToken(session),
      title: 'Complete access review', outcome: 'Review access', owner: '', due: '',
    }), out.res);

    const allowed = role !== 'viewer';
    assert.equal(out.status, allowed ? 303 : 403);
    assert.equal(await count(db, confirmations), beforeConfirmations + (allowed ? 1 : 0));
    assert.equal(await count(db, tasks), beforeTasks + (allowed ? 1 : 0));
    if (!allowed) {
      assert.match(out.body, /cannot confirm/);
      const denied = await scope.auditRows();
      assert.ok(denied.some((r) => r.event === 'draft.confirm_denied' && r.outcome === 'denied'),
        'viewer denial is auditable without creating a confirmation');
    }
  });
}

// --------------------------------------------------------------- invite mutation

for (const role of roles) {
  test(`${role} invite permission matches the matrix`, async () => {
    const { db, scope, session } = await fresh(role, `invite-${role}`);
    const out = response();

    await invitePost(request(session, { memberId: 'u-confirmer', csrf: csrfToken(session) }), out.res);

    const allowed = role === 'owner' || role === 'admin';
    assert.equal(out.status, allowed ? 303 : 403);
    const target = await scope.member('u-confirmer');
    assert.ok(target);
    const inviteRows = await db.select().from(memberCredentials)
      .where(and(eq(memberCredentials.workspaceId, WS), eq(memberCredentials.memberId, 'u-confirmer')));
    assert.equal(inviteRows.length, allowed ? 1 : 0, allowed ? 'admin mutation issued one invite' : 'non-admin issued no invite');
    assert.equal(await count(db, jobs), 0, 'inviting never queues customer work');
  });
}

// ------------------------------------------------------------ channel mutation

for (const role of roles) {
  test(`${role} channel-selection permission matches the matrix`, async () => {
    const { db, scope, session } = await fresh(role, `channels-${role}`);
    await scope.recordChannels([{ id: 'C-one', name: 'one', isPrivate: false }, { id: 'C-two', name: 'two', isPrivate: false }]);
    const out = response();

    await channelsSave(request(session, { channel: 'C-one', csrf: csrfToken(session) }), out.res);

    const allowed = role === 'owner' || role === 'admin';
    assert.equal(out.status, allowed ? 303 : 403);
    const selected = await scope.selectedChannels();
    assert.deepEqual(selected.map((c: any) => c.channelId), allowed ? ['C-one'] : [],
      'a denied role cannot change the read consent');
    const rows = await scope.auditRows();
    assert.equal(rows.some((r) => r.event === 'channels_selected' && r.outcome === 'ok'), allowed);
  });
}

// ----------------------------------------------------------- disconnect mutation

for (const role of roles) {
  test(`${role} Slack-disconnect permission matches the matrix`, async () => {
    const { db, scope, session } = await fresh(role, `disconnect-${role}`);
    await scope.saveConnection({
      teamId: `T-${role}`, teamName: 'Authz Co', botUserId: 'B1', tokenEnc: seal('xoxb-test'),
      scopes: 'channels:history', installedBy: 'u-owner',
    });
    const out = response();

    await disconnect(request(session, { csrf: csrfToken(session) }), out.res);

    const allowed = role === 'owner' || role === 'admin';
    assert.equal(out.status, allowed ? 303 : 403);
    const connection = await scope.connection();
    assert.equal(connection !== undefined, !allowed, 'denied roles leave the connection active');
    const rows = await scope.auditRows();
    assert.equal(rows.some((r) => r.event === 'source_disconnected' && r.outcome === 'ok'), allowed);
  });
}

// ----------------------------------------------------------- session boundary

test('a session member from another workspace cannot confirm this workspace draft', async () => {
  const { db, scope } = await fresh('confirmer', 'cross-workspace');
  const draftId = await draftFor(scope);
  const other = await WorkspaceScope.ensure(db, 'ws-other');
  await other.addMember('u-other', 'Other', 'confirmer');
  const foreign: Session = { workspaceId: 'ws-other', memberId: 'u-other', issuedAt: Date.now(), sid: 'sid-other', pv: 0 };
  const out = response();

  await confirmHandler(request(foreign, {
    draftId, decision: 'confirm', csrf: csrfToken(foreign), title: 'wrong', outcome: 'wrong', owner: '', due: '',
  }), out.res);

  assert.equal(out.status, 404, 'scope lookup cannot see a draft from another workspace');
  assert.equal(await count(db, confirmations, WS), 0);
  assert.equal(await count(db, tasks, WS), 0);
});
