import { openDb, migrateDb } from './db/client';
import { claimNextJob, finishJob, retryJob, reapStaleJobs } from './db/system';
import { WorkspaceScope } from './db/scope';
import { complete, dbMeterContext, DetectionSchema, DraftSchema } from './provider/index';
import { and, eq } from 'drizzle-orm';
import { confirmations, drafts, tasks, members } from './db/schema';
import { sanitizeDueDate, resolveOwner } from './sanitize';
import { DETECT_SYSTEM, draftSystem } from './prompts';

const detectThreshold = () => {
  const raw = process.env.SEROS_DETECT_THRESHOLD;
  if (raw === undefined || raw === '') return 55;
  const n = Number(raw);
  // `confidence < NaN` is always false, so a typo here silently accepted everything.
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error(`SEROS_DETECT_THRESHOLD must be a number 0-100, got ${JSON.stringify(raw)}`);
  }
  return n;
};


async function handleDetect(db: ReturnType<typeof openDb>, workspaceId: string, messageId: string) {
  const scope = WorkspaceScope.open(db, workspaceId);
  const msg = scope.messageById(messageId);
  if (!msg) return;
  if (msg.body === null) {                       // content already purged by retention
    scope.audit('detect.skipped_purged', 'ok', { message_id: messageId });
    return;
  }
  const body: string = msg.body;

  // The provider meters itself now; the worker's job is to respect its answer.
  const meter = dbMeterContext(db, workspaceId);
  const det = await complete(meter, { tier: 'cheap', purpose: 'detect', system: DETECT_SYSTEM, user: body }, DetectionSchema);
  if (!det.ok || det.value === null) {
    // Degrade toward doing nothing: no draft is invented from a failed call.
    scope.audit('detect.unavailable', 'failed', { message_id: messageId, outcome: det.outcome });
    throw new Error(`detect unavailable: ${det.outcome}`);   // retried with backoff
  }
  if (!det.value.isCommitment || det.value.confidence < detectThreshold()) {
    scope.audit('detect.discarded', 'ok', { message_id: messageId, confidence: Math.round(det.value.confidence) });
    return;
  }

  const dr = await complete(meter, { tier: 'standard', purpose: 'draft', system: draftSystem(), user: body }, DraftSchema);
  if (!dr.ok || dr.value === null) {
    scope.audit('draft.unavailable', 'failed', { message_id: messageId, outcome: dr.outcome });
    throw new Error(`draft unavailable: ${dr.outcome}`);
  }
  const roster = db.select({ id: members.id, name: members.name }).from(members)
    .where(eq(members.workspaceId, workspaceId)).all();
  const owner = resolveOwner(dr.value.proposedOwner, msg.authorId, roster);
  const due = sanitizeDueDate(body, dr.value.dueDate);
  if (due === null && dr.value.dueDate !== null) {
    scope.audit('draft.due_date_dropped', 'ok', { message_id: msg.id });
  }

  scope.createDraft({
    sourceMessageId: msg.id,
    title: dr.value.title,
    outcome: dr.value.outcome,
    kind: 'commitment',
    confidence: Math.min(det.value.confidence, dr.value.confidence),
    suggestedOwner: owner.owner,
    suggestedDueDate: due,
    provider: dr.provider,
  });
}

/** The fake tracker. Idempotent on the confirmation id. */
function handleTrackerWrite(db: ReturnType<typeof openDb>, workspaceId: string, confirmationId: string) {
  const conf = db.select().from(confirmations)
    .where(and(eq(confirmations.workspaceId, workspaceId), eq(confirmations.id, confirmationId))).get();
  if (!conf) throw new Error('no confirmation: refusing to write');   // ADR 0002
  if (conf.decision === 'rejected') return;
  const task = db.select().from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.confirmationId, confirmationId))).get();
  if (!task) throw new Error('no task row');
  if (task.writeState === 'created') return;                          // already written
  const d = db.select().from(drafts)
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, conf.draftId))).get();
  // Conditional on the state we read: if another worker got there first, this
  // updates zero rows and we do not write, meter or audit a second time.
  const res: any = db.update(tasks).set({ writeState: 'created', threadReplyState: 'posted' })
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, task.id),
               eq(tasks.writeState, 'queued'))).run();
  if (res?.changes === 0) return;
  WorkspaceScope.open(db, workspaceId).audit('task.created', 'ok',
    { task_id: task.id, confirmation_id: confirmationId, idempotency_key: task.idempotencyKey });
  console.log(JSON.stringify({ level: 'info', event: 'tracker.write', task_id: task.id, title_len: (d?.title ?? '').length }));
}

export async function tick(db: ReturnType<typeof openDb>): Promise<boolean> {
  const job = claimNextJob(db, ['detect', 'tracker_write']);
  if (!job) return false;
  try {
    const payload = JSON.parse(job.payload);
    if (job.queue === 'detect') await handleDetect(db, job.workspaceId, payload.messageId);
    else if (job.queue === 'tracker_write') handleTrackerWrite(db, job.workspaceId, payload.confirmationId);
    finishJob(db, job, 'done');
  } catch (e: any) {
    console.error(JSON.stringify({ level: 'error', event: 'job.failed', queue: job.queue, job_id: job.id, attempts: job.attempts, error: String(e?.message ?? e) }));
    retryJob(db, job);
  }
  return true;
}

async function main() {
  migrateDb();
  const db = openDb();
  console.log(JSON.stringify({ level: 'info', event: 'worker.started' }));
  let lastReap = 0;
  // The loop is the thing that must not die. A job may fail; the worker may not.
  for (;;) {
    let did = false;
    try {
      if (Date.now() - lastReap > 30_000) { reapStaleJobs(db); lastReap = Date.now(); }
      did = await tick(db);
    } catch (e: any) {
      console.error(JSON.stringify({ level: 'error', event: 'worker.tick_failed', error: String(e?.message ?? e) }));
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!did) await new Promise((r) => setTimeout(r, 500));
  }
}

process.on('unhandledRejection', (e: any) => {
  console.error(JSON.stringify({ level: 'error', event: 'worker.unhandled_rejection', error: String(e?.message ?? e) }));
});

if (require.main === module) main();
