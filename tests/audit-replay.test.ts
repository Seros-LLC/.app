/**
 * tests/audit-replay.test.ts — the seven-day capture-rate replay.
 *
 * This is the demo the founder runs in front of a prospect, so the tests are
 * about the three things that would make it a liability rather than an asset:
 *
 *   1. it reads ONLY the channels the admin ticked (the permission promise),
 *   2. it writes NO drafts, confirmations or tasks (ADR 0002: a task exists
 *      only downstream of a human confirmation), and
 *   3. the counts it prints are arithmetic over what it actually scanned.
 *
 * Everything runs offline: SEROS_PROVIDER=fake for the detector, and the fake
 * Slack client for history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

process.env.SEROS_PROVIDER = 'fake';
process.env.SEROS_SLACK = 'fake';
process.env.SEROS_ENCRYPTION_KEY = process.env.SEROS_ENCRYPTION_KEY ?? crypto.randomBytes(32).toString('base64');

import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { seal } from '../src/crypto';
import { FakeSlackClient, setSlackClient } from '../src/slack/client';
import type { SlackMessage } from '../src/slack/client';
import { drafts, confirmations, tasks } from '../src/db/schema';
import { replayCapture, parseArgs } from '../src/audit-replay';

function freshDb() { return join(mkdtempSync(join(tmpdir(), 'seros-replay-')), 'test.db'); }

const NOW = 1_700_000_000_000;                 // fixed, so the window is not a race
const secAgo = (days: number) => String(Math.floor(NOW / 1000) - Math.round(days * 86_400));

function msg(ts: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage {
  return { ts, user: 'u-1', text, ...extra };
}

/** A workspace with a sealed token, two channels recorded, and a stated selection. */
async function workspace(db: any, id: string, selected: string[]) {
  const scope = await WorkspaceScope.ensure(db, id);
  await scope.addMember('u-admin', 'Admin', 'admin');
  await scope.saveConnection({
    teamId: `T-${id}`, teamName: 'Prospect Co', botUserId: 'B1',
    tokenEnc: seal('xoxb-test'), scopes: 'channels:history', installedBy: 'u-admin',
  });
  await scope.recordChannels([
    { id: 'C-picked', name: 'delivery', isPrivate: false },
    { id: 'C-other', name: 'random', isPrivate: false },
  ]);
  await scope.setSelectedChannels(selected);
  return scope;
}

/** A fake Slack that also records which channels were actually asked for. */
function recordingSlack(history: Record<string, SlackMessage[]>) {
  const fake = new FakeSlackClient();
  for (const [ch, ms] of Object.entries(history)) fake.messages.set(ch, ms);
  const asked: string[] = [];
  const inner = fake.history.bind(fake);
  fake.history = async (t: string, channelId: string, oldest: number) => {
    asked.push(channelId);
    return inner(t, channelId, oldest);
  };
  setSlackClient(fake);
  return { fake, asked };
}

test('--days parses, defaults to 7, and refuses a window it cannot honour', () => {
  assert.deepEqual(parseArgs(['ws-1']), { workspaceId: 'ws-1', days: 7 });
  assert.deepEqual(parseArgs(['ws-1', '--days', '30']), { workspaceId: 'ws-1', days: 30 });
  assert.deepEqual(parseArgs(['ws-1', '--days=1']), { workspaceId: 'ws-1', days: 1 });
  for (const bad of [['ws', '--days', 'seven'], ['ws', '--days', '0'], ['ws', '--days', '-3'], ['ws', '--days']]) {
    assert.throws(() => parseArgs(bad), /--days/, `${JSON.stringify(bad)} must be refused, not silently defaulted`);
  }
});

test('only the selected channels are ever read', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  await workspace(db, 'ws-scope', ['C-picked']);

  const { asked } = recordingSlack({
    'C-picked': [msg(secAgo(1), "I'll send the report tomorrow")],
    'C-other': [msg(secAgo(1), "I'll rewrite the whole billing system")],
  });

  const report = await replayCapture(db, 'ws-scope', { days: 7, now: NOW });

  assert.deepEqual(asked, ['C-picked'], 'an unticked channel is never asked for');
  assert.equal(report.channelsScanned, 1);
  assert.equal(report.channels.length, 1);
  assert.equal(report.channels[0]!.channelId, 'C-picked');

  // And with nothing ticked, nothing at all is read.
  const scope = await WorkspaceScope.open(db, 'ws-scope');
  await scope.setSelectedChannels([]);
  asked.length = 0;
  const empty = await replayCapture(db, 'ws-scope', { days: 7, now: NOW });
  assert.deepEqual(asked, []);
  assert.equal(empty.messagesScanned, 0);
  assert.equal(empty.commitmentsDetected, 0);

  setSlackClient(undefined);
});

test('the replay writes no draft, no confirmation and no task', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  await workspace(db, 'ws-readonly', ['C-picked', 'C-other']);

  recordingSlack({
    'C-picked': [
      msg(secAgo(1), "I'll send the deck by Thursday"),
      msg(secAgo(2), "I'll fix the export bug"),
    ],
    'C-other': [msg(secAgo(1), "I'll ship the migration")],
  });

  const report = await replayCapture(db, 'ws-readonly', { days: 7, now: NOW });
  assert.ok(report.commitmentsDetected > 0, 'the demo has to actually find something');

  // The three tables a write would land in. Read directly rather than through
  // the scope: the point is that NOTHING is there, by any path.
  assert.equal((await db.select().from(drafts)).length, 0, 'a replay must not create drafts');
  assert.equal((await db.select().from(confirmations)).length, 0, 'a replay must not create confirmations');
  assert.equal((await db.select().from(tasks)).length, 0, 'a replay must not create tasks');

  // Nor does it ingest the history it read, and nor does it queue detect jobs.
  const scope = await WorkspaceScope.open(db, 'ws-readonly');
  assert.equal((await scope.pendingDrafts()).length, 0);
  assert.equal((await scope.recentTasks()).length, 0);

  setSlackClient(undefined);
});

test('the counts are arithmetic over what was scanned, per channel and in total', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  await workspace(db, 'ws-math', ['C-picked', 'C-other']);

  recordingSlack({
    'C-picked': [
      msg(secAgo(1), "I'll send the report"),          // commitment
      msg(secAgo(2), "I'll review the PR"),            // commitment
      msg(secAgo(3), 'thanks, looks great'),           // not a commitment
      msg(secAgo(1), 'deploy finished', { botId: 'B-ci' }),   // bot: skipped
      msg(secAgo(1), '   '),                           // empty: skipped
      msg(secAgo(20), "I'll do the thing"),            // outside the window
    ],
    'C-other': [msg(secAgo(2), "I'll write the changelog")],
  });

  const report = await replayCapture(db, 'ws-math', { days: 7, now: NOW });

  const picked = report.channels.find((c) => c.channelId === 'C-picked')!;
  const other = report.channels.find((c) => c.channelId === 'C-other')!;

  assert.equal(picked.messagesScanned, 3, 'bot, empty and out-of-window messages are not scanned');
  assert.equal(picked.messagesSkipped, 2, 'the bot post and the empty line are counted as skipped');
  assert.equal(picked.commitmentsDetected, 2);
  assert.equal(picked.detectedTs.length, picked.commitmentsDetected, 'one id per detection');
  assert.equal(other.messagesScanned, 1);
  assert.equal(other.commitmentsDetected, 1);

  assert.equal(report.messagesScanned, picked.messagesScanned + other.messagesScanned);
  assert.equal(report.commitmentsDetected, picked.commitmentsDetected + other.commitmentsDetected);
  assert.equal(report.commitmentsDetected, 3);
  assert.equal(report.detectorUnavailable, 0);
  assert.ok(report.commitmentsDetected <= report.messagesScanned, 'detections cannot exceed messages');

  // The window is derived from the requested days, not from wall-clock drift.
  assert.equal(report.oldestEpochSec, Math.floor(NOW / 1000) - 7 * 86_400);
  assert.equal(report.days, 7);

  setSlackClient(undefined);
});

test('a workspace with no live Slack connection is refused, not silently empty', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  const scope = await workspace(db, 'ws-gone', ['C-picked']);
  recordingSlack({ 'C-picked': [msg(secAgo(1), "I'll send the report")] });

  await scope.revokeConnection();
  await assert.rejects(() => replayCapture(db, 'ws-gone', { days: 7, now: NOW }), /no live Slack connection/);

  setSlackClient(undefined);
});

test('the replay is recorded in the audit log as counts, never content', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  const scope = await workspace(db, 'ws-audit', ['C-picked']);
  recordingSlack({ 'C-picked': [msg(secAgo(1), "I'll send the confidential merger deck")] });

  await replayCapture(db, 'ws-audit', { days: 7, now: NOW });

  const rows = await scope.auditRows();
  const row = rows.find((r: any) => r.event === 'replay.capture');
  assert.ok(row, 'reading a customer history is an audited act');
  assert.equal(row!.outcome, 'ok');
  assert.ok(!JSON.stringify(rows).includes('merger'), 'no message content reaches the audit log');

  setSlackClient(undefined);
});
