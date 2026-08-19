
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_PROVIDER = 'fake';          // deterministic, offline
process.env.SEROS_SIGNING_SECRET = 'test-secret-that-is-long-enough';

const dir = mkdtempSync(join(tmpdir(), 'seros-limits-test-'));
process.env.SEROS_DB = join(dir, 'test.db');

import { migrateDb, openDb } from '../src/db/client';
import { WorkspaceScope, UnknownWorkspace } from '../src/db/scope';
import { drafts, confirmations, tasks, auditEvents, jobs } from '../src/db/schema';
import {
  DAY_MS, DEFAULT_DRAFT_TTL_DAYS, DEFAULT_MAX_QUEUED_JOBS, DEFAULT_MAX_PENDING_DRAFTS,
  draftTtlDays, maxQueuedJobs, maxPendingDrafts,
  queuedJobCount, pendingDraftCount, workspaceLimitCounts, allWorkspaceLimitCounts,
  checkQueuedJobs, checkPendingDrafts, enforceLimits,
  expireDrafts, expireDraftsAllWorkspaces, runMaintenance, draftsHaveExpiresAt,
} from '../src/limits';
import { and, eq, sql } from 'drizzle-orm';

migrateDb();
const db = openDb();

const NOW = Date.now();
const daysLater = (n: number) => NOW + n * DAY_MS;

function auditFor(workspaceId: string, event: string) {
  return db.select().from(auditEvents).where(and(
    eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.event, event),
  )).all();
}
function draftRow(workspaceId: string, id: string) {
  return db.select().from(drafts).where(and(
    eq(drafts.workspaceId, workspaceId), eq(drafts.id, id))).get();
}

/** A pending draft whose age we control, so the TTL is testable without waiting 14 days. */
let seq = 0;
function seedPendingDraft(s: WorkspaceScope, ageDays: number): string {
  seq += 1;
  const { row } = s.ingestMessage({
    channelId: 'C1', ts: `${1000 + seq}.${seq}`, authorId: 'u-ana',
    body: "I'll ship the migration by Friday.",
  });
  const id = s.createDraft({
    sourceMessageId: row.id, title: 'Ship the migration', outcome: 'migration shipped',
    kind: 'commitment', confidence: 90, suggestedOwner: 'u-me', suggestedDueDate: null,
    provider: 'fake',
  });
  db.update(drafts).set({ createdAt: NOW - ageDays * DAY_MS })
    .where(and(eq(drafts.workspaceId, s.workspaceId), eq(drafts.id, id))).run();
  return id;
}

// ---------------------------------------------------------------------------
// M7 — draft expiry
// ---------------------------------------------------------------------------

test('expiry: a pending draft older than the window becomes expired', () => {
  const s = WorkspaceScope.ensure(db, 'L-old');
  const id = seedPendingDraft(s, 20);                 // older than the 14 day default

  const r = expireDrafts(db, 'L-old', { now: NOW });
  assert.equal(r.ttlDays, DEFAULT_DRAFT_TTL_DAYS);
  assert.equal(r.counts.drafts_expired, 1);
  assert.deepEqual(r.draftIds, [id]);
  assert.equal(r.cutoffAt, NOW - DEFAULT_DRAFT_TTL_DAYS * DAY_MS);
  assert.equal(draftRow('L-old', id)!.state, 'expired');
  assert.equal(r.counts.pending_remaining, 0);
});

test('expiry: a pending draft inside the window is left alone', () => {
  const s = WorkspaceScope.ensure(db, 'L-young');
  const id = seedPendingDraft(s, 13);                 // inside the 14 day default

  const r = expireDrafts(db, 'L-young', { now: NOW });
  assert.equal(r.counts.drafts_expired, 0);
  assert.deepEqual(r.draftIds, []);
  assert.equal(draftRow('L-young', id)!.state, 'pending');
  assert.equal(r.counts.pending_remaining, 1);

  // and it still expires once the window has actually passed
  const later = expireDrafts(db, 'L-young', { now: daysLater(2) });
  assert.equal(later.counts.drafts_expired, 1);
  assert.equal(draftRow('L-young', id)!.state, 'expired');
});

test('expiry: an expired draft has no Confirmation and no Task, and can never be confirmed', () => {
  const s = WorkspaceScope.ensure(db, 'L-nowrite');
  s.addMember('u-me', 'Me');
  const id = seedPendingDraft(s, 30);

  const r = expireDrafts(db, 'L-nowrite', { now: NOW });
  assert.equal(r.counts.drafts_expired, 1);
  assert.equal(r.confirmationsCreated, 0);
  assert.equal(r.tasksCreated, 0);
  assert.equal(draftRow('L-nowrite', id)!.state, 'expired');

  // nothing downstream was manufactured by the expiry itself
  assert.equal(db.select().from(confirmations)
    .where(eq(confirmations.workspaceId, 'L-nowrite')).all().length, 0);
  assert.equal(db.select().from(tasks)
    .where(eq(tasks.workspaceId, 'L-nowrite')).all().length, 0);

  // and `expired` is terminal: confirmation is refused, still no confirmation, no task
  const attempt = s.confirm(id, 'confirmed', 'u-me');
  assert.equal(attempt.ok, false);
  if (!attempt.ok) assert.equal(attempt.reason, 'not_pending');
  assert.equal(draftRow('L-nowrite', id)!.state, 'expired');   // never 'confirmed'
  assert.equal(db.select().from(confirmations)
    .where(eq(confirmations.workspaceId, 'L-nowrite')).all().length, 0);
  assert.equal(db.select().from(tasks)
    .where(eq(tasks.workspaceId, 'L-nowrite')).all().length, 0);
  assert.equal(db.select().from(jobs)
    .where(and(eq(jobs.workspaceId, 'L-nowrite'), eq(jobs.queue, 'tracker_write'))).all().length, 0);
});

test('expiry: running it twice changes nothing the second time (idempotent)', () => {
  const s = WorkspaceScope.ensure(db, 'L-idem');
  const id = seedPendingDraft(s, 40);

  const first = expireDrafts(db, 'L-idem', { now: NOW });
  const afterFirst = draftRow('L-idem', id)!;
  const auditAfterFirst = auditFor('L-idem', 'draft.expired').length;
  assert.equal(first.counts.drafts_expired, 1);

  const second = expireDrafts(db, 'L-idem', { now: daysLater(1) });
  const afterSecond = draftRow('L-idem', id)!;

  assert.equal(second.counts.drafts_expired, 0);            // nothing left to do
  assert.deepEqual(second.draftIds, []);
  assert.deepEqual(afterSecond, afterFirst);                // row-for-row identical
  assert.equal(auditFor('L-idem', 'draft.expired').length, auditAfterFirst);  // no noise
});

test('expiry: writes a draft.expired audit row carrying counts and ids only', () => {
  const s = WorkspaceScope.ensure(db, 'L-audit');
  const id = seedPendingDraft(s, 21);

  const before = auditFor('L-audit', 'draft.expired').length;
  expireDrafts(db, 'L-audit', { now: NOW });
  const rows = auditFor('L-audit', 'draft.expired');
  assert.equal(rows.length, before + 1);

  const last = rows[rows.length - 1]!;
  assert.equal(last.outcome, 'ok');
  const detail = JSON.parse(last.detail!) as Record<string, string | number>;
  assert.equal(detail.drafts_expired, 1);
  assert.equal(detail.ttl_days, DEFAULT_DRAFT_TTL_DAYS);
  assert.equal(detail.confirmations_created, 0);
  assert.equal(detail.tasks_created, 0);
  assert.equal(detail.draft_ids, id);                       // ids are metadata
  assert.equal(detail.draft_ids_omitted, 0);
  // counts and ids only: no title, no outcome text, no owner handle, no message body
  assert.ok(!/migration|Friday|Ship|u-ana/i.test(last.detail!));
  for (const [k, v] of Object.entries(detail)) {
    if (k === 'draft_ids') assert.equal(typeof v, 'string');
    else assert.equal(typeof v, 'number');
  }
});

test('expiry: only pending drafts transition; confirmed and rejected drafts are untouched', () => {
  const s = WorkspaceScope.ensure(db, 'L-states');
  s.addMember('u-me', 'Me');
  const confirmedId = seedPendingDraft(s, 60);
  const rejectedId = seedPendingDraft(s, 60);
  const pendingId = seedPendingDraft(s, 60);

  const c = s.confirm(confirmedId, 'confirmed', 'u-me');
  assert.equal(c.ok, true);
  const rj = s.confirm(rejectedId, 'rejected', 'u-me');
  assert.equal(rj.ok, true);
  const tasksBefore = db.select().from(tasks).where(eq(tasks.workspaceId, 'L-states')).all().length;

  const r = expireDrafts(db, 'L-states', { now: NOW });
  assert.equal(r.counts.drafts_expired, 1);
  assert.deepEqual(r.draftIds, [pendingId]);
  assert.equal(draftRow('L-states', confirmedId)!.state, 'confirmed');   // still confirmed
  assert.equal(draftRow('L-states', rejectedId)!.state, 'rejected');
  assert.equal(draftRow('L-states', pendingId)!.state, 'expired');
  // the already-confirmed draft keeps its task; expiry created none of its own
  assert.equal(db.select().from(tasks).where(eq(tasks.workspaceId, 'L-states')).all().length, tasksBefore);
  assert.equal(tasksBefore, 1);
});

test('expiry: SEROS_DRAFT_TTL_DAYS configures the window', () => {
  const s = WorkspaceScope.ensure(db, 'L-ttl');
  const id = seedPendingDraft(s, 3);
  process.env.SEROS_DRAFT_TTL_DAYS = '2';
  try {
    assert.equal(draftTtlDays(), 2);
    const r = expireDrafts(db, 'L-ttl', { now: NOW });
    assert.equal(r.ttlDays, 2);
    assert.equal(r.counts.drafts_expired, 1);
    assert.equal(draftRow('L-ttl', id)!.state, 'expired');
  } finally {
    delete process.env.SEROS_DRAFT_TTL_DAYS;
  }
  assert.equal(draftTtlDays(), DEFAULT_DRAFT_TTL_DAYS);
  assert.equal(draftTtlDays({ ttlDays: 5 }), 5);
});

test('expiry: refuses an unknown workspace and covers every known one', () => {
  assert.throws(() => expireDrafts(db, 'L-does-not-exist'), UnknownWorkspace);
  const s = WorkspaceScope.ensure(db, 'L-all');
  const id = seedPendingDraft(s, 90);
  const results = expireDraftsAllWorkspaces(db, { now: NOW });
  assert.ok(results.length > 0);
  assert.ok(results.some((r) => r.workspaceId === 'L-all'));
  assert.equal(draftRow('L-all', id)!.state, 'expired');
  for (const r of results) assert.equal(r.confirmationsCreated, 0);
});

// ---------------------------------------------------------------------------
// M3 — growth limits
// ---------------------------------------------------------------------------

test('limits: the queued-jobs cap refuses AT the limit and not before', () => {
  const s = WorkspaceScope.ensure(db, 'L-jobs');
  const opts = { maxQueuedJobs: 3, now: NOW } as const;

  assert.equal(queuedJobCount(db, 'L-jobs'), 0);
  for (let i = 0; i < 2; i += 1) {
    const d = checkQueuedJobs(db, 'L-jobs', opts);
    assert.equal(d.ok, true, `below the cap at ${i} queued jobs`);
    s.enqueue('detect', { messageId: `m-${i}` });
  }
  // 2 of 3 queued: still under the cap, still accepting work
  const under = checkQueuedJobs(db, 'L-jobs', opts);
  assert.equal(under.ok, true);
  assert.equal(under.count, 2);
  assert.equal(under.limit, 3);
  s.enqueue('detect', { messageId: 'm-2' });

  // 3 of 3: the cap bites, loudly and structurally
  const at = checkQueuedJobs(db, 'L-jobs', opts);
  assert.equal(at.ok, false);
  if (at.ok) return;
  assert.equal(at.kind, 'queued_jobs');
  assert.equal(at.reason, 'queued_jobs_limit');
  assert.equal(at.count, 3);
  assert.equal(at.limit, 3);
  assert.equal(at.suggestedStatus, 429);
  assert.equal(at.retryable, true);
  assert.equal(at.workspaceId, 'L-jobs');

  // refusing does not delete or mutate anything: the queue is exactly as deep as it was
  assert.equal(queuedJobCount(db, 'L-jobs'), 3);

  // draining the queue lifts the refusal — the caller may retry
  db.update(jobs).set({ status: 'done' })
    .where(and(eq(jobs.workspaceId, 'L-jobs'), eq(jobs.status, 'queued'))).run();
  assert.equal(checkQueuedJobs(db, 'L-jobs', opts).ok, true);
});

test('limits: the pending-drafts cap refuses AT the limit and not before', () => {
  const s = WorkspaceScope.ensure(db, 'L-drafts');
  const opts = { maxPendingDrafts: 2, now: NOW } as const;

  assert.equal(checkPendingDrafts(db, 'L-drafts', opts).ok, true);
  seedPendingDraft(s, 0);
  const under = checkPendingDrafts(db, 'L-drafts', opts);
  assert.equal(under.ok, true);
  assert.equal(under.count, 1);

  const expiring = seedPendingDraft(s, 0);
  const at = checkPendingDrafts(db, 'L-drafts', opts);
  assert.equal(at.ok, false);
  if (at.ok) return;
  assert.equal(at.kind, 'pending_drafts');
  assert.equal(at.reason, 'pending_drafts_limit');
  assert.equal(at.count, 2);
  assert.equal(at.limit, 2);
  assert.equal(at.suggestedStatus, 429);

  // nothing was dropped to make room: both drafts are still pending
  assert.equal(pendingDraftCount(db, 'L-drafts'), 2);

  // and expiring one frees the headroom back up (M7 feeds M3)
  db.update(drafts).set({ state: 'expired' })
    .where(and(eq(drafts.workspaceId, 'L-drafts'), eq(drafts.id, expiring))).run();
  assert.equal(checkPendingDrafts(db, 'L-drafts', opts).ok, true);
});

test('limits: a refusal is audited with outcome denied, counts only', () => {
  const s = WorkspaceScope.ensure(db, 'L-denied');
  seedPendingDraft(s, 0);
  const before = auditFor('L-denied', 'limit.refused').length;

  const d = enforceLimits(db, 'L-denied', { maxPendingDrafts: 1, now: NOW });
  assert.equal(d.ok, false);

  const rows = auditFor('L-denied', 'limit.refused');
  assert.equal(rows.length, before + 1);
  const last = rows[rows.length - 1]!;
  assert.equal(last.outcome, 'denied');
  const detail = JSON.parse(last.detail!) as Record<string, string | number>;
  assert.equal(detail.limit_kind, 'pending_drafts');
  assert.equal(detail.reason, 'pending_drafts_limit');
  assert.equal(detail.count, 1);
  assert.equal(detail.limit, 1);
  assert.ok(!/migration|Friday|Ship|u-ana/i.test(last.detail!));
});

test('limits: an allowed check writes no audit row, and audit:false stays silent', () => {
  const s = WorkspaceScope.ensure(db, 'L-quiet');
  seedPendingDraft(s, 0);
  const before = auditFor('L-quiet', 'limit.refused').length;

  assert.equal(enforceLimits(db, 'L-quiet', { maxPendingDrafts: 50, now: NOW }).ok, true);
  assert.equal(auditFor('L-quiet', 'limit.refused').length, before);

  // observing the cap from a dashboard must not fill the audit log
  const silent = checkPendingDrafts(db, 'L-quiet', { maxPendingDrafts: 1, audit: false, now: NOW });
  assert.equal(silent.ok, false);
  assert.equal(auditFor('L-quiet', 'limit.refused').length, before);
});

test('limits: enforceLimits returns the first refusal and leaves the status to the caller', () => {
  const s = WorkspaceScope.ensure(db, 'L-entry');
  s.enqueue('detect', { messageId: 'm-1' });
  seedPendingDraft(s, 0);

  const ok = enforceLimits(db, 'L-entry', { maxQueuedJobs: 9, maxPendingDrafts: 9, now: NOW });
  assert.equal(ok.ok, true);

  // queue depth is checked first
  const both = enforceLimits(db, 'L-entry', { maxQueuedJobs: 1, maxPendingDrafts: 1, now: NOW });
  assert.equal(both.ok, false);
  if (both.ok) return;
  assert.equal(both.kind, 'queued_jobs');
  assert.equal(both.suggestedStatus, 429);          // advice, not an action
  assert.equal(typeof both.message, 'string');

  // and a caller may check one cap on its own
  const draftsOnly = enforceLimits(db, 'L-entry', {
    kinds: ['pending_drafts'], maxQueuedJobs: 1, maxPendingDrafts: 1, now: NOW,
  });
  assert.equal(draftsOnly.ok, false);
  if (draftsOnly.ok) return;
  assert.equal(draftsOnly.kind, 'pending_drafts');

  assert.throws(() => enforceLimits(db, 'L-not-a-workspace'), UnknownWorkspace);
});

test('limits: counts are reported per workspace, with no cross-tenant leakage', () => {
  const a = WorkspaceScope.ensure(db, 'L-tenant-a');
  const b = WorkspaceScope.ensure(db, 'L-tenant-b');
  a.enqueue('detect', { messageId: 'a-1' });
  a.enqueue('detect', { messageId: 'a-2' });
  seedPendingDraft(a, 0);
  b.enqueue('detect', { messageId: 'b-1' });
  seedPendingDraft(b, 0);
  seedPendingDraft(b, 0);
  seedPendingDraft(b, 0);

  const ca = workspaceLimitCounts(db, 'L-tenant-a', { now: NOW });
  const cb = workspaceLimitCounts(db, 'L-tenant-b', { now: NOW });
  assert.deepEqual(ca.counts, { queued_jobs: 2, pending_drafts: 1 });
  assert.deepEqual(cb.counts, { queued_jobs: 1, pending_drafts: 3 });
  assert.deepEqual(ca.limits, { queued_jobs: DEFAULT_MAX_QUEUED_JOBS, pending_drafts: DEFAULT_MAX_PENDING_DRAFTS });
  assert.deepEqual(ca.exceeded, []);
  assert.ok(ca.usage.queued_jobs > 0 && ca.usage.queued_jobs < 1);

  // one tenant at its cap does not refuse the other
  const denied = enforceLimits(db, 'L-tenant-b', { maxPendingDrafts: 3, now: NOW });
  assert.equal(denied.ok, false);
  assert.equal(enforceLimits(db, 'L-tenant-a', { maxPendingDrafts: 3, now: NOW }).ok, true);

  // the cross-tenant report is per workspace and consistent with the scoped reads
  const all = allWorkspaceLimitCounts(db, { now: NOW });
  const rowA = all.find((r) => r.workspaceId === 'L-tenant-a')!;
  const rowB = all.find((r) => r.workspaceId === 'L-tenant-b')!;
  assert.deepEqual(rowA.counts, ca.counts);
  assert.deepEqual(rowB.counts, cb.counts);
  assert.equal(queuedJobCount(db, 'L-tenant-a'), 2);
  assert.equal(pendingDraftCount(db, 'L-tenant-a'), 1);
  assert.ok(all.length >= 2);
});

test('limits: env caps are read, and a malformed cap is a loud error, not a removed limit', () => {
  assert.equal(maxQueuedJobs(), DEFAULT_MAX_QUEUED_JOBS);
  assert.equal(maxPendingDrafts(), DEFAULT_MAX_PENDING_DRAFTS);

  process.env.SEROS_MAX_QUEUED_JOBS = '2';
  process.env.SEROS_MAX_PENDING_DRAFTS = '1';
  try {
    assert.equal(maxQueuedJobs(), 2);
    assert.equal(maxPendingDrafts(), 1);
    const s = WorkspaceScope.ensure(db, 'L-env');
    s.enqueue('detect', { messageId: 'e-1' });
    s.enqueue('detect', { messageId: 'e-2' });
    const d = enforceLimits(db, 'L-env', { now: NOW });
    assert.equal(d.ok, false);
    if (!d.ok) assert.equal(d.limit, 2);
  } finally {
    delete process.env.SEROS_MAX_QUEUED_JOBS;
    delete process.env.SEROS_MAX_PENDING_DRAFTS;
  }

  for (const bad of ['ten', '0', '-5', '1.5']) {
    process.env.SEROS_MAX_QUEUED_JOBS = bad;
    try {
      assert.throws(() => maxQueuedJobs(), /SEROS_MAX_QUEUED_JOBS/, `bad value ${bad}`);
    } finally {
      delete process.env.SEROS_MAX_QUEUED_JOBS;
    }
  }
  assert.equal(maxQueuedJobs(), DEFAULT_MAX_QUEUED_JOBS);
});

test('maintenance: one pass expires stale drafts and then reports every workspace', () => {
  const s = WorkspaceScope.ensure(db, 'L-maint');
  const stale = seedPendingDraft(s, 30);
  const fresh = seedPendingDraft(s, 1);

  const r = runMaintenance(db, { now: NOW });
  const mine = r.expired.find((e) => e.workspaceId === 'L-maint')!;
  assert.equal(mine.counts.drafts_expired, 1);
  assert.equal(draftRow('L-maint', stale)!.state, 'expired');
  assert.equal(draftRow('L-maint', fresh)!.state, 'pending');
  const counts = r.counts.find((c) => c.workspaceId === 'L-maint')!;
  assert.equal(counts.counts.pending_drafts, 1);
  assert.deepEqual(counts.exceeded, []);
});

// This one mutates the schema, so it runs LAST: it proves the file already honours the
// `expires_at` column the brief asks for (§1.5), for whenever schema.ts grows one.
test('expiry: a per-draft expires_at column is honoured as soon as it exists', () => {
  const s = WorkspaceScope.ensure(db, 'L-expat');
  const early = seedPendingDraft(s, 1);      // young, but with an explicit early deadline
  const late = seedPendingDraft(s, 100);     // ancient, but explicitly kept alive

  // works whether the column already exists (schema.ts grew one) or not
  if (!draftsHaveExpiresAt(db)) db.run(sql`ALTER TABLE drafts ADD COLUMN expires_at INTEGER`);
  assert.equal(draftsHaveExpiresAt(db), true);
  db.run(sql`UPDATE drafts SET expires_at = ${NOW - DAY_MS} WHERE id = ${early}`);
  db.run(sql`UPDATE drafts SET expires_at = ${NOW + 30 * DAY_MS} WHERE id = ${late}`);

  const r = expireDrafts(db, 'L-expat', { now: NOW });
  assert.deepEqual(r.draftIds, [early]);
  assert.equal(draftRow('L-expat', early)!.state, 'expired');
  assert.equal(draftRow('L-expat', late)!.state, 'pending');   // per-draft deadline wins

  // a draft with no explicit deadline still falls back to created_at + TTL
  const legacy = seedPendingDraft(s, 40);
  const r2 = expireDrafts(db, 'L-expat', { now: NOW });
  assert.deepEqual(r2.draftIds, [legacy]);
  assert.equal(draftRow('L-expat', legacy)!.state, 'expired');
});
