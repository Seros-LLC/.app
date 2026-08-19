import { openDb, migrateDb } from './db/client';
import { claimNextJob, finishJob, retryJob } from './db/system';
import { WorkspaceScope } from './db/scope';
import { complete, DetectionSchema, DraftSchema } from './provider/index';
import { and, eq } from 'drizzle-orm';
import { confirmations, drafts, tasks, members } from './db/schema';
import { sanitizeDueDate, resolveOwner } from './sanitize';

const detectThreshold = () => Number(process.env.SEROS_DETECT_THRESHOLD || 55);

const DETECT_SYSTEM =
  'You decide whether a chat message contains a commitment: something a person undertook to do. ' +
  'Reply ONLY with JSON: {"isCommitment":boolean,"confidence":0-100,"reason":string}. ' +
  'A question, an opinion or praise is not a commitment.';
const draftSystem = (now = new Date()) => {
  const iso = now.toISOString().slice(0, 10);
  const day = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getUTCDay()];
  return 'You turn a chat message into a task draft. Reply ONLY with JSON: ' +
    '{"title":string,"outcome":string,"proposedOwner":string|null,"dueDate":"YYYY-MM-DD"|null,"confidence":0-100}. ' +
    `Today is ${iso}, a ${day}. Resolve "tomorrow" or a named weekday against that date. ` +
    'If the message states no deadline at all, dueDate MUST be null - never guess one. ' +
    'proposedOwner is whoever undertook the work, not the person it is being sent to; use null if unclear.';
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

  const det = await complete({ tier: 'cheap', purpose: 'detect', system: DETECT_SYSTEM, user: body }, DetectionSchema);
  scope.meter('detect', det.outcome);
  if (!det.value.isCommitment || det.value.confidence < detectThreshold()) {
    scope.audit('detect.discarded', 'ok', { message_id: messageId, confidence: Math.round(det.value.confidence) });
    return;
  }

  const dr = await complete({ tier: 'standard', purpose: 'draft', system: draftSystem(), user: body }, DraftSchema);
  scope.meter('draft', dr.outcome);
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
  db.update(tasks).set({ writeState: 'created', threadReplyState: 'posted' })
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, task.id))).run();
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
  for (;;) {
    const did = await tick(db);
    if (!did) await new Promise((r) => setTimeout(r, 500));
  }
}

if (require.main === module) main();
