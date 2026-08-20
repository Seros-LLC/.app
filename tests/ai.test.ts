/**
 * The AI read-and-explain features: ASK, EXPLAIN, DIGEST.
 *
 * Two providers are used here, both offline and both deterministic:
 *
 *   SEROS_PROVIDER=fake      the repository's own deterministic transport. It only
 *                            knows how to answer `detect` and `draft`, so for these
 *                            purposes it returns the WRONG SHAPE - which is exactly
 *                            what is wanted to prove a schema failure degrades.
 *   a loopback http stub     the real `http` transport in src/provider/transports.ts
 *                            pointed at 127.0.0.1, so a well-formed answer can be
 *                            exercised through the real metered path rather than a
 *                            mock of it. Still no network, still deterministic.
 *
 * Nothing here calls a model except through `complete()`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_PROVIDER = 'fake';
process.env.SEROS_SIGNING_SECRET = 'ai-test-signing-secret-long-enough';
process.env.SEROS_SESSION_SECRET = 'ai-test-session-secret-long-enough';
const dir = mkdtempSync(join(tmpdir(), 'seros-ai-'));
process.env.SEROS_DB = join(dir, 'ai.db');

import { migrateDb, openDb } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { actionMeter, auditEvents, confirmations, draftReasons as draftReasonRows, drafts, tasks } from '../src/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { requireCsrf, requireSession, csrfToken } from '../src/auth';
import type { Session } from '../src/auth';
import { askPage, askPost } from '../src/routes/ask';
import { digestPage } from '../src/routes/digest';
import { ask, citationsWithin } from '../src/ai/ask';
import { clearDigestCache, digest, statesANumber } from '../src/ai/digest';
import { explainCommitment, explainDraft, reasonLine, tidy } from '../src/ai/explain';
import type { ReasonScope } from '../src/ai/explain';
import { MODEL_ROW_CAP, factsBlock, idSet, retrieve } from '../src/ai/retrieve';

// Mock fetch for Ollama embedding endpoint to avoid 404 in tests
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  const urlString = typeof url === 'string' ? url : String(url);
  // Only mock calls to Ollama embedding endpoint
  if (urlString.includes('/api/embeddings')) {
    return new Response(JSON.stringify({ embedding: new Array(768).fill(0.0) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // For all other requests, use the original fetch
  return originalFetch(url, options);
};

migrateDb();
const db = openDb();

// ---- the loopback model stub ----------------------------------------------
let NEXT_CONTENT = '{}';
const modelStub = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: NEXT_CONTENT } }],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    }));
  });
});
modelStub.listen(0);
const stubPort = () => (modelStub.address() as any).port;

/** Run `fn` with the real http transport answering `content`. */
async function withModel<T>(content: unknown, fn: () => Promise<T>): Promise<T> {
  NEXT_CONTENT = typeof content === 'string' ? content : JSON.stringify(content);
  delete process.env.SEROS_PROVIDER;                       // fake would win otherwise
  process.env.SEROS_PROVIDER_CHAIN = 'http';
  process.env.SEROS_PROVIDER_BASE_URL = `http://127.0.0.1:${stubPort()}/v1`;
  process.env.SEROS_PROVIDER_API_KEY = 'test-key';
  try {
    return await fn();
  } finally {
    process.env.SEROS_PROVIDER = 'fake';
    delete process.env.SEROS_PROVIDER_CHAIN;
    delete process.env.SEROS_PROVIDER_BASE_URL;
    delete process.env.SEROS_PROVIDER_API_KEY;
    NEXT_CONTENT = '{}';
  }
}

// ---- fixtures --------------------------------------------------------------
let seq = 0;
async function seedDraft(scope: WorkspaceScope, opts: { title?: string; owner?: string | null; due?: string | null; body?: string } = {}) {
  seq += 1;
  const body = opts.body ?? `I'll ${opts.title ?? 'do the thing'} soon.`;
  const { row } = await scope.ingestMessage({ channelId: 'C1', ts: `${seq}.${Math.random()}`, authorId: 'u-ana', body });
  const id = await scope.createDraft({
    sourceMessageId: row.id,
    title: opts.title ?? `Draft ${seq}`,
    outcome: 'the thing is done',
    kind: 'commitment',
    confidence: 80,
    suggestedOwner: opts.owner === undefined ? 'u-ana' : opts.owner,
    suggestedDueDate: opts.due === undefined ? null : opts.due,
    provider: 'fixture',
  });
  return id;
}

async function seedTask(scope: WorkspaceScope, memberId: string, opts: { title?: string; due?: string | null } = {}) {
  const draftId = await seedDraft(scope, opts);
  const r = await scope.confirm(draftId, 'confirmed', memberId);
  assert.equal(r.ok, true);
  return draftId;
}

const meterRows = (workspaceId: string) =>
  db.select().from(actionMeter).where(eq(actionMeter.workspaceId, workspaceId)).all();
const auditRows = (workspaceId: string) =>
  db.select().from(auditEvents).where(eq(auditEvents.workspaceId, workspaceId)).all();

// ---- an app with only the two routes under test ----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(requireSession);
app.get('/ask', askPage);
app.post('/ask', requireCsrf, askPost);
app.get('/digest', digestPage);
const server = app.listen(0);
const url = (p: string) => `http://127.0.0.1:${(server.address() as any).port}${p}`;

function sessionFor(workspaceId: string, memberId: string) {
  const s: Session = { workspaceId, memberId, issuedAt: Date.now() };
  const body = Buffer.from(JSON.stringify(s)).toString('base64url');
  const mac = crypto.createHmac('sha256', process.env.SEROS_SESSION_SECRET!).update(body).digest('base64url');
  return { session: s, cookie: `seros_session=${encodeURIComponent(`${body}.${mac}`)}`, csrf: csrfToken(s) };
}

// ===========================================================================
// ASK
// ===========================================================================

test('ask: an empty workspace is answered without calling the model at all', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-empty');
  const before = meterRows('ai-empty').length;
  const r = await ask(db, s, 'what is overdue?');
  assert.equal(r.outcome.kind, 'no_data');
  assert.equal(r.modelCalled, false);
  assert.equal(r.meterId, null);
  assert.equal(meterRows('ai-empty').length, before, 'no rows retrieved must mean no metered call');
  assert.ok(auditRows('ai-empty').some((a) => a.event === 'ask.no_data'));
});

test('ask: a blank question never reaches the model either', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-blank');
  await s.addMember('u-ana', 'Ana');
  await seedDraft(s, { title: 'Send the deck' });
  const before = meterRows('ai-blank').length;
  const r = await ask(db, s, '   ');
  assert.equal(r.outcome.kind, 'no_question');
  assert.equal(meterRows('ai-blank').length, before);
});

test('ask: a well-formed answer is returned with the rows it cited', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-answer');
  await s.addMember('u-ana', 'Ana');
  const draftId = await seedDraft(s, { title: 'Send the revised deck', due: '2020-01-01' });
  const r = await withModel(
    { answer: 'The deck is still waiting for a human and its due date has passed.', citedIds: [`draft:${draftId}`] },
    () => ask(db, s, 'what is overdue?'),
  );
  assert.equal(r.outcome.kind, 'answered');
  if (r.outcome.kind !== 'answered') return;
  assert.equal(r.outcome.cited.length, 1);
  assert.equal(r.outcome.cited[0]!.id, `draft:${draftId}`);
  assert.equal(r.outcome.cited[0]!.overdue, true);
  assert.ok(auditRows('ai-answer').some((a) => a.event === 'ask.answered'));
});

test('ask: an answer citing an id outside the retrieved set is discarded whole', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-cite');
  await s.addMember('u-ana', 'Ana');
  await seedDraft(s, { title: 'Real work that exists' });
  const r = await withModel(
    { answer: 'You also committed to migrating the billing service.', citedIds: ['task:11111111-2222-3333-4444-555555555555'] },
    () => ask(db, s, 'what did I commit to?'),
  );
  assert.equal(r.outcome.kind, 'degraded');
  if (r.outcome.kind !== 'degraded') return;
  assert.equal(r.outcome.why, 'unknown_citation');
  assert.ok(auditRows('ai-cite').some((a) => a.event === 'ask.citation_rejected'));
});

test('ask: an id invented in the prose is caught even when citedIds is clean', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-cite2');
  await s.addMember('u-ana', 'Ana');
  await seedDraft(s, { title: 'Real work that exists' });
  const r = await withModel(
    { answer: 'See draft:not-a-real-draft for the migration you promised.', citedIds: [] },
    () => ask(db, s, 'what did I commit to?'),
  );
  assert.equal(r.outcome.kind, 'degraded');
  if (r.outcome.kind !== 'degraded') return;
  assert.equal(r.outcome.why, 'unknown_citation');
});

test('ask: citationsWithin is the whole rule, and it is not fooled by a prefix', () => {
  const allowed = new Set(['task:abc', 'draft:def']);
  assert.equal(citationsWithin('all good', ['task:abc'], allowed), true);
  assert.equal(citationsWithin('all good', ['task:abcd'], allowed), false);
  assert.equal(citationsWithin('see task:abcd', [], allowed), false);
  assert.equal(citationsWithin('see task:abc and draft:def', ['task:abc'], allowed), true);
});

test('ask: a schema failure degrades to the plain view instead of throwing or half-rendering', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-schema');
  await s.addMember('u-ana', 'Ana');
  await seedDraft(s, { title: 'A draft the reader can still read' });
  // SEROS_PROVIDER=fake answers every non-detect purpose with a DRAFT-shaped object,
  // which is not an answer: the provider records invalid_output and returns null.
  const r = await ask(db, s, 'what is waiting?');
  assert.equal(r.outcome.kind, 'degraded');
  if (r.outcome.kind !== 'degraded') return;
  assert.equal(r.outcome.why, 'invalid_output');

  const { cookie, csrf } = sessionFor('ai-schema', 'u-ana');
  const res = await fetch(url('/ask'), {
    method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ question: 'what is waiting?', csrf }).toString(),
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /A draft the reader can still read/);
  assert.match(html, /here are the rows themselves/);
});

test('ask: every model call writes exactly one meter row, with the prompt version on it', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-meter');
  await s.addMember('u-ana', 'Ana');
  await seedDraft(s, { title: 'Something to ask about' });
  const before = meterRows('ai-meter').length;
  await ask(db, s, 'what is waiting?');
  const after = meterRows('ai-meter');
  assert.equal(after.length, before + 1, 'one question, one metered call');
  const row = after[after.length - 1]!;
  assert.equal(row.purpose, 'other');
  assert.equal(row.promptVersion, 'ask/v1');
  assert.equal(row.refType, 'ask');
});

test('ask: the retrieved set is capped, and the counts stay true above the cap', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-cap');
  await s.addMember('u-ana', 'Ana');
  const total = MODEL_ROW_CAP + 5;
  for (let i = 0; i < total; i++) await seedDraft(s, { title: `Capped draft ${i}` });
  const r = await retrieve(s);
  assert.equal(r.rows.filter((x) => x.bucket === 'waiting').length, MODEL_ROW_CAP);
  assert.equal(r.counts.waiting, total, 'the count is of everything, not of the sample');
  assert.equal(r.capped, true);
  assert.ok(factsBlock(r).split('\n').length <= MODEL_ROW_CAP * 3 + 40 + 1);
});

test('ask: workspace A never sees workspace B rows, in the facts, the ids or the page', async () => {
  const a = await WorkspaceScope.ensure(db, 'ai-ten-a');
  const b = await WorkspaceScope.ensure(db, 'ai-ten-b');
  await a.addMember('u-a', 'Ana');
  await b.addMember('u-b', 'Bo');
  await seedDraft(a, { title: 'Work belonging to A' });
  const bDraft = await seedDraft(b, { title: 'SECRET-OF-B' });

  const ra = await retrieve(a);
  assert.equal(ra.rows.some((x) => x.id === `draft:${bDraft}`), false);
  assert.doesNotMatch(factsBlock(ra), /SECRET-OF-B/);
  assert.equal(idSet(ra).has(`draft:${bDraft}`), false);

  // and a model that cites B's row while answering for A is refused, not rendered
  const r = await withModel(
    { answer: 'Bo is waiting on SECRET-OF-B.', citedIds: [`draft:${bDraft}`] },
    () => ask(db, a, 'what is Bo waiting on?'),
  );
  assert.equal(r.outcome.kind, 'degraded');

  const { cookie } = sessionFor('ai-ten-a', 'u-a');
  const html = await (await fetch(url('/ask'), { headers: { cookie } })).text();
  assert.doesNotMatch(html, /SECRET-OF-B/);
  assert.match(html, /Work belonging to A/);
});

test('ask: the page needs a session, like every other page', async () => {
  const res = await fetch(url('/ask'), { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/login');
});

// ===========================================================================
// EXPLAIN
// ===========================================================================

test('explain: a short reason comes back, is stored through the scope, and audits only its length', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-explain');
  await s.addMember('u-ana', 'Ana');
  const draftId = await seedDraft(s, { title: 'Send the deck' });
  const stored: Array<{ id: string; reason: string; version: string }> = [];
  const scope: ReasonScope = {
    workspaceId: s.workspaceId,
    audit: s.audit.bind(s),
    setDraftReason: (id, reason, version) => { stored.push({ id, reason, version }); },
  };
  const out = await withModel(
    { reason: 'says she will send the revised deck herself by Thursday' },
    () => explainDraft(db, scope, draftId, "I'll send the revised deck to Priya by Thursday."),
  );
  assert.equal(out, 'says she will send the revised deck herself by Thursday');
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.version, 'explain/v1');
  const audit = auditRows('ai-explain').filter((a) => a.event === 'draft.reason_stored');
  assert.equal(audit.length, 1);
  assert.match(audit[0]!.detail ?? '', /"words":10/);
  assert.doesNotMatch(audit[0]!.detail ?? '', /deck/, 'the audit row carries no content');
});

test('explain: an over-long reason is dropped rather than truncated mid-clause', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-explain-long');
  const long = Array.from({ length: 30 }, () => 'wordy').join(' ');   // 30 words, under the 200-char schema cap
  const out = await withModel({ reason: long }, () => explainCommitment(db, s.workspaceId, { body: 'I will do it.' }));
  assert.equal(out.reason, null);
  assert.equal(out.why, 'too_long');
  assert.equal(reasonLine(out.reason), '', 'and the card renders exactly as it does now');
});

test('explain: a provider failure leaves the field absent, and is still metered', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-explain-fail');
  const before = meterRows('ai-explain-fail').length;
  const out = await explainCommitment(db, s.workspaceId, { body: "I'll ship it Friday." });
  assert.equal(out.reason, null);
  assert.equal(out.why, 'invalid_output');
  const after = meterRows('ai-explain-fail');
  assert.equal(after.length, before + 1);
  assert.equal(after[after.length - 1]!.promptVersion, 'explain/v1');
  assert.equal(reasonLine(out.reason), '');
});

test('explain: explainDraft never throws, whatever the storage does', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-explain-throw');
  const scope: ReasonScope = {
    workspaceId: s.workspaceId,
    audit: s.audit.bind(s),
    setDraftReason: () => { throw new Error('storage exploded'); },
  };
  const out = await withModel({ reason: 'says he will fix it' },
    () => explainDraft(db, scope, 'd-1', 'I will fix it.'));
  assert.equal(out, null, 'a decoration may not take drafting down with it');
});

test('explain: tidy strips the model habits before anything is measured or stored', () => {
  assert.equal(tidy('  "says she will send it"  '), 'says she will send it');
  assert.equal(tidy('says\nshe   will  send it'), 'says she will send it');
  assert.equal(tidy('x'.repeat(400)).length, 200);
});

test('explain: reasonLine escapes, because it renders inside a card', () => {
  assert.equal(reasonLine('<script>alert(1)</script>'),
    '<p class="meta">Why: &lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

// ===========================================================================
// DIGEST
// ===========================================================================

test('digest: the counts are computed in code and survive prose that disagrees', async () => {
  clearDigestCache();
  const s = await WorkspaceScope.ensure(db, 'ai-digest');
  await s.addMember('u-bo', 'Bo');
  await seedTask(s, 'u-bo', { title: 'Confirmed thing' });
  await seedDraft(s, { title: 'Waiting thing' });
  await seedDraft(s, { title: 'Overdue thing', due: '2020-01-01' });

  const d = await withModel(
    { headline: 'A steady day', summary: 'Work moved from the queue into the tracker, and some is still waiting.' },
    () => digest(db, s, { noCache: true }),
  );
  assert.notEqual(d.prose, null);
  assert.equal(d.retrieved.counts.confirmed, 1);
  assert.equal(d.retrieved.counts.waiting, 2);
  assert.equal(d.retrieved.counts.overdue, 1);
  assert.equal(d.retrieved.counts.confirmedToday, 1);
});

test('digest: prose that states its own count is refused, and the numbers still render', async () => {
  clearDigestCache();
  const s = await WorkspaceScope.ensure(db, 'ai-digest-num');
  await s.addMember('u-bo', 'Bo');
  await seedDraft(s, { title: 'Waiting thing' });
  const d = await withModel(
    { headline: 'Three things landed', summary: 'The team confirmed three commitments today.' },
    () => digest(db, s, { noCache: true }),
  );
  assert.equal(d.prose, null);
  assert.equal(d.why, 'numbers_in_prose');
  assert.equal(d.retrieved.counts.waiting, 1);
  assert.ok(auditRows('ai-digest-num').some((a) => a.event === 'digest.prose_rejected'));
});

test('digest: statesANumber refuses counts but allows a date and ordinary prose', () => {
  assert.equal(statesANumber('two drafts are waiting'), true);
  assert.equal(statesANumber('3 confirmed'), true);
  assert.equal(statesANumber('a dozen things'), true);
  assert.equal(statesANumber('Nothing was confirmed; the queue is untouched since 2026-01-08'), false);
  assert.equal(statesANumber('No one has confirmed the deck yet'), false);
});

test('digest: a model failure still renders every count', async () => {
  clearDigestCache();
  const s = await WorkspaceScope.ensure(db, 'ai-digest-fail');
  await s.addMember('u-bo', 'Bo');
  await seedTask(s, 'u-bo', { title: 'Confirmed under failure' });
  await seedDraft(s, { title: 'Waiting under failure' });
  const d = await digest(db, s, { noCache: true });          // fake provider: wrong shape
  assert.equal(d.prose, null);
  assert.equal(d.why, 'invalid_output');

  const { cookie } = sessionFor('ai-digest-fail', 'u-bo');
  const res = await fetch(url('/digest'), { headers: { cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Confirmed under failure/);
  assert.match(html, /Waiting under failure/);
  assert.match(html, /No summary this time/);
});

test('digest: an empty workspace calls no model', async () => {
  clearDigestCache();
  const s = await WorkspaceScope.ensure(db, 'ai-digest-empty');
  const before = meterRows('ai-digest-empty').length;
  const d = await digest(db, s);
  assert.equal(d.why, 'no_data');
  assert.equal(d.modelCalled, false);
  assert.equal(meterRows('ai-digest-empty').length, before);
});

test('digest: refreshing the page does not buy a second model call', async () => {
  clearDigestCache();
  const s = await WorkspaceScope.ensure(db, 'ai-digest-cache');
  await s.addMember('u-bo', 'Bo');
  await seedDraft(s, { title: 'Cached thing' });
  const before = meterRows('ai-digest-cache').length;
  await withModel({ headline: 'Quiet day', summary: 'A commitment is waiting for a human.' }, async () => {
    const first = await digest(db, s);
    const second = await digest(db, s);
    assert.equal(first.servedFromCache, false);
    assert.equal(second.servedFromCache, true);
    assert.deepEqual(second.prose, first.prose);
  });
  assert.equal(meterRows('ai-digest-cache').length, before + 1, 'two page loads, one metered call');
});

test('digest: one page load is one metered call, tagged digest/v1', async () => {
  clearDigestCache();
  const s = await WorkspaceScope.ensure(db, 'ai-digest-meter');
  await s.addMember('u-bo', 'Bo');
  await seedDraft(s, { title: 'Metered thing' });
  const before = meterRows('ai-digest-meter').length;
  await digest(db, s, { noCache: true });
  const after = meterRows('ai-digest-meter');
  assert.equal(after.length, before + 1);
  assert.equal(after[after.length - 1]!.promptVersion, 'digest/v1');
  assert.equal(after[after.length - 1]!.purpose, 'other');
});

// ===========================================================================
// The rules that hold across all three
// ===========================================================================

test('ai: neither page creates a task, a confirmation or a draft', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-readonly');
  await s.addMember('u-ana', 'Ana');
  await seedTask(s, 'u-ana', { title: 'Already confirmed' });
  await seedDraft(s, { title: 'Already waiting' });
  const count = (t: 'tasks' | 'confirmations') => (t === 'tasks'
    ? db.select().from(tasks).where(eq(tasks.workspaceId, 'ai-readonly')).all().length
    : db.select().from(confirmations).where(eq(confirmations.workspaceId, 'ai-readonly')).all().length);
  const drafts = (await s.pendingDrafts()).length;
  const before = { tasks: count('tasks'), confirmations: count('confirmations'), drafts };

  const { cookie, csrf } = sessionFor('ai-readonly', 'u-ana');
  await fetch(url('/ask'), { headers: { cookie } });
  await fetch(url('/ask'), {
    method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ question: 'what is waiting?', csrf }).toString(),
  });
  clearDigestCache();
  await fetch(url('/digest'), { headers: { cookie } });

  assert.deepEqual(
    { tasks: count('tasks'), confirmations: count('confirmations'), drafts: (await s.pendingDrafts()).length },
    before,
    'these are read-and-explain features',
  );
});

test('ai: the audit rows these features write carry counts and ids, never content', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-audit');
  await s.addMember('u-ana', 'Ana');
  await seedDraft(s, { title: 'CONTENT-THAT-MUST-NOT-BE-AUDITED' });
  await ask(db, s, 'what is waiting?');
  clearDigestCache();
  await digest(db, s, { noCache: true });
  const rows = auditRows('ai-audit');
  assert.ok(rows.some((r) => r.event.startsWith('ask.')));
  assert.ok(rows.some((r) => r.event.startsWith('digest.')));
  for (const r of rows) assert.doesNotMatch(r.detail ?? '', /CONTENT-THAT-MUST-NOT-BE-AUDITED/);
  // and the database itself refuses a content-shaped key, so this cannot regress
  await assert.rejects(() => s.audit('ask.answered', 'ok', { title: 'the deck' }));
});

test('ai: the model is never reached without a meter context', async () => {
  const { complete } = await import('../src/provider/index.js');
  const { AskAnswerSchema } = await import('../src/ai/schemas.js');
  await assert.rejects(
    () => complete(null as never, { tier: 'cheap', purpose: 'other', system: 's', user: 'u' }, AskAnswerSchema),
    /meter context/,
  );
});

test('migration 0007 is a no-op on the second and third cold boot', async () => {
  // SQLite has no ADD COLUMN IF NOT EXISTS and src/db/client.ts re-runs every
  // migration on every boot, so "boots three times" is the whole test.
  const cold = join(dir, 'cold.db');
  const files1 = await migrateDb(cold);
  const files2 = await migrateDb(cold);
  const files3 = await migrateDb(cold);
  assert.ok(files1.includes('0007_draft_reason.sql'));
  assert.deepEqual(files1, files3);
  assert.equal(files2.length, files3.length);
  const raw = new Database(cold);
  const names = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='draft_reasons'").all();
  const cols = raw.prepare('PRAGMA table_info(draft_reasons)').all() as Array<{ name: string }>;
  raw.close();
  assert.equal(names.length, 1, 'the sidecar exists after three boots');
  assert.deepEqual(cols.map((c) => c.name),
    ['workspace_id', 'draft_id', 'reason', 'prompt_version', 'created_at']);
});

// ===========================================================================
// The sidecar the queue card reads (migration 0007). These are the EXACT
// statements handed to src/db/scope.ts as setDraftReason / draftReasons, tested
// here so the wiring lands as a copy rather than a guess.
// ===========================================================================

const putReason = (workspaceId: string, draftId: string, reason: string, promptVersion: string) =>
  db.insert(draftReasonRows).values({
    workspaceId, draftId, reason: reason.slice(0, 200), promptVersion, createdAt: Date.now(),
  }).onConflictDoUpdate({
    target: [draftReasonRows.workspaceId, draftReasonRows.draftId],
    set: { reason: reason.slice(0, 200), promptVersion, createdAt: Date.now() },
  }).run();

const getReasons = (workspaceId: string, draftIds: string[]): Record<string, string> => {
  if (draftIds.length === 0) return {};
  const rows = db.select({ draftId: draftReasonRows.draftId, reason: draftReasonRows.reason })
    .from(draftReasonRows)
    .where(and(eq(draftReasonRows.workspaceId, workspaceId), inArray(draftReasonRows.draftId, draftIds)))
    .all();
  const out: Record<string, string> = {};
  for (const r of rows) out[r.draftId] = r.reason;
  return out;
};

test('reason sidecar: one row per draft, written twice, read back once', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-sidecar');
  await s.addMember('u-ana', 'Ana');
  const d1 = await seedDraft(s, { title: 'First' });
  const d2 = await seedDraft(s, { title: 'Second' });
  putReason('ai-sidecar', d1, 'says he will send it', 'explain/v1');
  putReason('ai-sidecar', d1, 'says he will send it by Thursday', 'explain/v1');   // recompute
  const got = getReasons('ai-sidecar', [d1, d2]);
  assert.equal(got[d1], 'says he will send it by Thursday');
  assert.equal(got[d2], undefined, 'a draft with no reason simply has none');
  assert.equal(reasonLine(got[d2]), '', 'and its card renders exactly as it does now');
});

test('reason sidecar: workspace B cannot read workspace A reasons', async () => {
  const a = await WorkspaceScope.ensure(db, 'ai-sidecar-a');
  const b = await WorkspaceScope.ensure(db, 'ai-sidecar-b');
  await a.addMember('u-a', 'Ana');
  await b.addMember('u-b', 'Bo');
  const da = await seedDraft(a, { title: 'A work' });
  putReason('ai-sidecar-a', da, 'says she will do it', 'explain/v1');
  assert.equal(getReasons('ai-sidecar-b', [da])[da], undefined);
  assert.equal(getReasons('ai-sidecar-a', [da])[da], 'says she will do it');
});

test('reason sidecar: deleting a draft takes its reason with it', async () => {
  const s = await WorkspaceScope.ensure(db, 'ai-sidecar-cascade');
  await s.addMember('u-ana', 'Ana');
  const d = await seedDraft(s, { title: 'Doomed' });
  putReason('ai-sidecar-cascade', d, 'says he will do it', 'explain/v1');
  assert.equal(Object.keys(getReasons('ai-sidecar-cascade', [d])).length, 1);
  // src/retention.ts deleteWorkspace deletes drafts; the sidecar must not refuse that
  db.delete(drafts).where(and(eq(drafts.workspaceId, 'ai-sidecar-cascade'), eq(drafts.id, d))).run();
  assert.equal(Object.keys(getReasons('ai-sidecar-cascade', [d])).length, 0);
});

test.after(() => {
  server.close();
  modelStub.close();
  rmSync(dir, { recursive: true, force: true });
});
