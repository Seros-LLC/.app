import { openDb, migrateDbAsync } from './db/client';
import { claimNextJobAsync, finishJobAsync, retryJobAsync, reapStaleJobsAsync } from './db/system';
import { enforceLimits, runMaintenance } from './limits';
import { WorkspaceScope } from './db/scope';
import { complete, dbMeterContext, DetectionSchema, DraftSchema } from './provider/index';
import { sanitizeDueDate, resolveOwner } from './sanitize';
import { DETECT_SYSTEM, draftSystem } from './prompts';
import { explainDraft } from './ai/explain';
import { TrackerService } from './tracker/service';

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
  const scope = await WorkspaceScope.open(db, workspaceId);
  const msg = await scope.messageById(messageId);
  if (!msg) return;
  if (msg.body === null) {                       // content already purged by retention
    await scope.audit('detect.skipped_purged', 'ok', { message_id: messageId });
    return;
  }
  const body: string = msg.body;

  // The provider meters itself now; the worker's job is to respect its answer.
  const meter = dbMeterContext(db, workspaceId);
  const det = await complete(meter, { tier: 'cheap', purpose: 'detect', system: DETECT_SYSTEM, user: body }, DetectionSchema);
  if (!det.ok || det.value === null) {
    // Degrade toward doing nothing: no draft is invented from a failed call.
    await scope.audit('detect.unavailable', 'failed', { message_id: messageId, outcome: det.outcome });
    throw new Error(`detect unavailable: ${det.outcome}`);   // retried with backoff
  }
  if (!det.value.isCommitment || det.value.confidence < detectThreshold()) {
    await scope.audit('detect.discarded', 'ok', { message_id: messageId, confidence: Math.round(det.value.confidence) });
    return;
  }

  const dr = await complete(meter, { tier: 'standard', purpose: 'draft', system: draftSystem(), user: body }, DraftSchema);
  if (!dr.ok || dr.value === null) {
    await scope.audit('draft.unavailable', 'failed', { message_id: messageId, outcome: dr.outcome });
    throw new Error(`draft unavailable: ${dr.outcome}`);
  }
  const owner = resolveOwner(dr.value.proposedOwner, msg.authorId, await scope.roster());
  const due = sanitizeDueDate(body, dr.value.dueDate);
  if (due === null && dr.value.dueDate !== null) {
    await scope.audit('draft.due_date_dropped', 'ok', { message_id: msg.id });
  }

  const cap = await enforceLimits(db, workspaceId, { kinds: ['pending_drafts'] });
  if (!cap.ok) {
    await scope.audit('draft.skipped_at_limit', 'denied', { count: cap.count, limit: cap.limit });
    return;
  }

  const draftId = await scope.createDraft({
    sourceMessageId: msg.id,
    title: dr.value.title,
    outcome: dr.value.outcome,
    kind: 'commitment',
    confidence: Math.min(det.value.confidence, dr.value.confidence),
    suggestedOwner: owner.owner,
    suggestedDueDate: due,
    provider: dr.provider,
  });

  // Why we read this as a commitment, in the confirmer's language. Best effort:
  // it never throws, and when it fails the card renders exactly as it did before.
  await explainDraft(db, scope, draftId, body);
}

/**
 * Create the confirmed task in the customer's tracker.
 *
 * Order matters, and it is the opposite of what this function used to do. The
 * task is marked 'created' only after the tracker answers with an id. Marking it
 * first meant a failed API call left a task that claimed to exist in a tracker
 * it had never reached, and the retry returned early on 'created' - a confirmed
 * commitment silently never arrived. The claim (a task_writes row) is what stops
 * two workers writing twice; 'created' is reserved for what is true.
 */
async function handleTrackerWrite(db: ReturnType<typeof openDb>, workspaceId: string, confirmationId: string) {
  const scope = await WorkspaceScope.open(db, workspaceId);
  const job = await scope.writeJob(confirmationId);
  if (!job) throw new Error('no confirmation: refusing to write');   // ADR 0002
  if (job.conf.decision === 'rejected') return;
  if (!job.task) throw new Error('no task row');
  if (job.task.writeState === 'created') return;                     // already in the tracker

  const claim = await scope.claimTaskWrite(job.task.id);
  if (claim === 'done') return;                                      // another worker finished it
  if (claim === 'busy') return;                                      // another worker is mid-write

  const writer = TrackerService.getInstance().getWriter();
  let result;
  try {
    result = await writer.write({
      workspaceId,
      taskId: job.task.id,
      confirmationId,
      idempotencyKey: job.task.idempotencyKey,
      // `agreed` is the draft with the human's confirm-time edits applied. The
      // tracker gets what the human agreed to, never the model's superseded words.
      title: job.agreed?.title ?? '(untitled)',
      outcome: job.agreed?.outcome ?? '',
      owner: job.agreed?.owner ?? null,
      dueDate: job.agreed?.dueDate ?? null,
      sourcePermalink: null,
      context: null,
      labels: [],
    });
  } catch (e) {
    // Drop the claim so the retry can take it, and leave write_state 'queued':
    // nothing in the system may claim this task exists in the tracker.
    await scope.releaseTaskWrite(job.task.id);
    await scope.audit('task.write_failed', 'failed', { task_id: job.task.id, confirmation_id: confirmationId, tracker: writer.getName() });
    throw e;                                                         // retried with backoff
  }

  const first = await scope.completeTaskWrite(job.task.id, result);
  if (!first) return;                                                // already accounted for
  await scope.audit('task.created', 'ok',
    { task_id: job.task.id, confirmation_id: confirmationId, idempotency_key: job.task.idempotencyKey,
      tracker: result.tracker, external_id: result.externalId, deduped: result.deduped === true ? 1 : 0 });
  console.log(JSON.stringify({ level: 'info', event: 'tracker.write', task_id: job.task.id,
    tracker: result.tracker, external_id: result.externalId, title_len: (job.agreed?.title ?? '').length }));
}

export async function tick(db: ReturnType<typeof openDb>): Promise<boolean> {
  const job = await claimNextJobAsync(db, ['detect', 'tracker_write']);
  if (!job) return false;
  try {
    const payload = JSON.parse(job.payload);
    if (job.queue === 'detect') await handleDetect(db, job.workspaceId, payload.messageId);
    else if (job.queue === 'tracker_write') await handleTrackerWrite(db, job.workspaceId, payload.confirmationId);
    await finishJobAsync(db, job, 'done');
  } catch (e: any) {
    console.error(JSON.stringify({ level: 'error', event: 'job.failed', queue: job.queue, job_id: job.id, attempts: job.attempts, error: String(e?.message ?? e) }));
    await retryJobAsync(db, job);
  }
  return true;
}

async function main() {
  await migrateDbAsync();
  const db = openDb();
  console.log(JSON.stringify({ level: 'info', event: 'worker.started' }));
  let lastReap = 0;
  let lastMaint = 0;
  // The loop is the thing that must not die. A job may fail; the worker may not.
  for (;;) {
    let did = false;
    try {
      if (Date.now() - lastReap > 30_000) { await reapStaleJobsAsync(db); lastReap = Date.now(); }
      if (Date.now() - lastMaint > 60_000) { await runMaintenance(db); lastMaint = Date.now(); }
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