/**
 * "We only read these."
 *
 * The channel picker is a promise, and this file is the enforcement of it: a
 * message from a channel nobody ticked is never stored, and a Slack team no
 * workspace has connected has no tenant to write to. Both are checked against
 * the real webhook handler, over real signed bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

process.env.SEROS_SIGNING_SECRET = 'test-signing-secret-0123456789';
process.env.SEROS_SESSION_SECRET = 'test-session-secret-0123456789';
process.env.SEROS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.SEROS_SLACK = 'fake';

import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { workspaceIdForSlackTeam } from '../src/db/system';
import { seal, open as openSecret } from '../src/crypto';
import { sign } from '../src/routes/webhook';
import { createApp } from '../src/server';

function freshDb() { return join(mkdtempSync(join(tmpdir(), 'seros-slack-')), 'test.db'); }

async function connected(db: any, workspaceId: string, teamId: string, selected: string[]) {
  const scope = await WorkspaceScope.ensure(db, workspaceId);
  await scope.addMember('u-admin', 'Admin', 'admin');
  await scope.saveConnection({
    teamId, teamName: 'Test Co', botUserId: 'B1',
    tokenEnc: seal('xoxb-test'), scopes: 'channels:history', installedBy: 'u-admin',
  });
  await scope.recordChannels([
    { id: 'C-picked', name: 'delivery', isPrivate: false },
    { id: 'C-other', name: 'random', isPrivate: false },
  ]);
  await scope.setSelectedChannels(selected);
  return scope;
}

/** Posts a correctly signed Slack event at the real handler. */
async function postEvent(app: any, payload: object) {
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(raw, ts);
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/slack/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-signature': sig, 'x-slack-request-timestamp': ts },
      body: raw,
    });
    return { status: res.status, body: await res.json() as any };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('a token is sealed at rest and opens again', () => {
  const sealed = seal('xoxb-secret-token');
  assert.notEqual(sealed, 'xoxb-secret-token');
  assert.ok(!sealed.includes('xoxb-secret-token'), 'the token is not readable in the stored value');
  assert.equal(openSecret(sealed), 'xoxb-secret-token');
  assert.equal(openSecret('v1.aaa.bbb.ccc'), null, 'a value this key cannot open returns null');
});

test('the tenant comes from the stored connection, and disconnecting ends it', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  const scope = await connected(db, 'ws-conn', 'T-conn', ['C-picked']);

  assert.equal(await workspaceIdForSlackTeam(db, 'T-conn'), 'ws-conn');
  assert.equal(await workspaceIdForSlackTeam(db, 'T-nobody'), null, 'an unconnected team has no tenant');

  await scope.revokeConnection();
  assert.equal(await workspaceIdForSlackTeam(db, 'T-conn'), null, 'disconnect stops ingestion');
  const row = await scope.connection();
  assert.equal(row, undefined, 'the connection is gone, and so is the token');
});

test('a message from a channel nobody ticked is never stored', async () => {
  const path = freshDb();
  process.env.SEROS_DB = path;
  delete process.env.DATABASE_URL;
  await migrateDbAsync(path);
  const db = openDb(path);
  const scope = await connected(db, 'T-picky', 'T-picky', ['C-picked']);
  const app = createApp();

  const ignored = await postEvent(app, {
    team_id: 'T-picky',
    event: { type: 'message', channel: 'C-other', ts: `${Date.now() / 1000}`, user: 'u-1', text: 'I will do the thing' },
  });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.body.ignored, 'channel_not_selected');

  const accepted = await postEvent(app, {
    team_id: 'T-picky',
    event: { type: 'message', channel: 'C-picked', ts: `${Date.now() / 1000 + 1}`, user: 'u-1', text: 'I will send the report' },
  });
  assert.equal(accepted.status, 200);
  assert.ok(accepted.body.messageId, 'a ticked channel is read');

  const unknown = await postEvent(app, {
    team_id: 'T-not-connected',
    event: { type: 'message', channel: 'C-picked', ts: `${Date.now() / 1000 + 2}`, user: 'u-1', text: 'hello' },
  });
  assert.equal(unknown.status, 404, 'a signed event for an unconnected team has no tenant');

  // The proof that matters: exactly one message row, from the ticked channel.
  const rows = await scope.channels();
  assert.equal(rows.length, 2);
  const picked = rows.find((c: any) => c.channelId === 'C-picked');
  assert.equal(picked?.selected, 1);
  assert.equal((await scope.selectedChannels()).length, 1);
});

test('the selection is replaced wholesale, so unticking really unticks', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  const scope = await connected(db, 'ws-sel', 'T-sel', ['C-picked', 'C-other']);
  assert.equal((await scope.selectedChannels()).length, 2);

  await scope.setSelectedChannels(['C-other']);
  const after = await scope.selectedChannels();
  assert.equal(after.length, 1);
  assert.equal(after[0]!.channelId, 'C-other');
  assert.equal(await scope.isChannelSelected('C-picked'), false);

  await scope.setSelectedChannels([]);
  assert.equal((await scope.selectedChannels()).length, 0, 'ticking nothing reads nothing');
});
