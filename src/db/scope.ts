/**
 * Tenancy is structural, not a convention (ADR 0003 consequence).
 * Tenant rows are ONLY reachable through a WorkspaceScope, which cannot be built
 * without an existing workspace id, and which injects workspace_id into every
 * query itself. There is no raw-db escape hatch on this class.
 *
 * DIALECT NOTE. Every method here is async, and every query is awaited rather
 * than finished with better-sqlite3's synchronous .get()/.all()/.run(). Those
 * three methods exist only on the SQLite builders: on node-postgres the same
 * builder is a promise with .execute(), so a `.run()` call site is not "slower"
 * on Postgres, it is a TypeError (observed: `db.insert(...).values(...)
 * .onConflictDoNothing(...).run is not a function`). Awaiting the builder is
 * correct on BOTH drivers - drizzle's better-sqlite3 builders are thenable and
 * still execute synchronously underneath - which is the same shape the rest of
 * this codebase was already migrated to (src/retention.ts, src/limits.ts,
 * src/password.ts, src/provider/meter.ts). The single-row helper is
 * `(await q.limit(1))[0]` instead of `.get()`, and a row count is read through
 * affectedRows(), which knows about both `changes` and `rowCount`.
 */
import { and, eq, desc } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import type { openDb } from './client';
import { affectedRows } from './client';
import { withTx } from './tx';
import {
  workspaces, members, sourceMessages, drafts, confirmations, tasks,
  auditEvents, actionMeter, jobs,
} from './schema';

type Db = ReturnType<typeof openDb>;

export class UnknownWorkspace extends Error {}

export class WorkspaceScope {
  private constructor(private readonly db: Db, readonly workspaceId: string) {}

  static async open(db: Db, workspaceId: string): Promise<WorkspaceScope> {
    const row = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0];
    if (!row) throw new UnknownWorkspace(workspaceId);
    return new WorkspaceScope(db, workspaceId);
  }

  static async ensure(db: Db, workspaceId: string, name = workspaceId): Promise<WorkspaceScope> {
    await db.insert(workspaces)
      .values({ id: workspaceId, name, status: 'active', retentionContentDays: 30,
                dailyBudgetCents: 0, monthlyBudgetCents: 0, createdAt: Date.now() })
      .onConflictDoNothing();
    return new WorkspaceScope(db, workspaceId);
  }

  // ---- audit + meter (never carry content) ----
  async audit(
    event: string,
    outcome: 'ok' | 'denied' | 'failed',
    detail?: Record<string, string | number>,
    who?: {
      actorType?: 'member' | 'system' | 'operator';
      actorId?: string | null;
      objectType?: string;
      objectId?: string;
      requestId?: string;
    },
  ): Promise<void> {
    await this.db.insert(auditEvents).values({
      workspaceId: this.workspaceId, event, outcome,
      actorType: who?.actorType ?? (who?.actorId ? 'member' : 'system'),
      actorId: who?.actorId ?? null,
      objectType: who?.objectType ?? null,
      objectId: who?.objectId ?? null,
      // omitted rather than undefined, so the database default fires
      ...(who?.requestId ? { requestId: who.requestId } : {}),
      detail: detail ? JSON.stringify(detail) : null, at: Date.now(),
    });
  }

  async meter(purpose: 'detect'|'draft'|'route'|'replay'|'other',
              outcome: 'ok'|'timeout'|'invalid_output'|'provider_error'|'budget_blocked'): Promise<void> {
    await this.db.insert(actionMeter).values({
      workspaceId: this.workspaceId, purpose, outcome, at: Date.now(),
    });
  }

  // ---- ingest ----
  async ingestMessage(input: { channelId: string; ts: string; authorId: string; body: string }) {
    const id = randomUUID();
    const bodyHash = createHash('sha256').update(input.body).digest('hex');
    const existing = (await this.db.select().from(sourceMessages).where(and(
      eq(sourceMessages.workspaceId, this.workspaceId),
      eq(sourceMessages.channelId, input.channelId),
      eq(sourceMessages.ts, input.ts),
    )).limit(1))[0];
    if (existing) return { row: existing, created: false as const };
    await this.db.insert(sourceMessages).values({
      workspaceId: this.workspaceId, channelId: input.channelId, ts: input.ts, id,
      authorId: input.authorId, body: input.body, bodyHash,
      contentPurgedAt: null, receivedAt: Date.now(),
    });
    await this.audit('message.ingested', 'ok', { message_id: id });
    const row = (await this.db.select().from(sourceMessages).where(and(
      eq(sourceMessages.workspaceId, this.workspaceId),
      eq(sourceMessages.channelId, input.channelId),
      eq(sourceMessages.ts, input.ts),
    )).limit(1))[0]!;
    return { row, created: true as const };
  }

  async messageById(id: string) {
    return (await this.db.select().from(sourceMessages)
      .where(and(eq(sourceMessages.workspaceId, this.workspaceId), eq(sourceMessages.id, id))).limit(1))[0];
  }

  // ---- jobs ----
  async enqueue(queue: string, payload: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    await this.db.insert(jobs).values({
      workspaceId: this.workspaceId, id, queue, status: 'queued',
      payload: JSON.stringify(payload), runAt: Date.now(), attempts: 0, createdAt: Date.now(),
    });
    return id;
  }

  // ---- drafts ----
  async createDraft(d: { sourceMessageId: string; title: string; outcome: string;
                         kind: 'commitment'|'request'|'decision'; confidence: number;
                         suggestedOwner: string | null; suggestedDueDate: string | null; provider: string }): Promise<string> {
    const id = randomUUID();
    await this.db.insert(drafts).values({
      workspaceId: this.workspaceId, id, sourceMessageId: d.sourceMessageId,
      title: d.title, outcome: d.outcome, kind: d.kind, confidence: Math.round(d.confidence),
      suppressedReason: null, suggestedDueDate: d.suggestedDueDate, suggestedOwner: d.suggestedOwner,
      state: 'pending', provider: d.provider, createdAt: Date.now(),
    });
    await this.audit('draft.created', 'ok', { draft_id: id, confidence: Math.round(d.confidence) });
    return id;
  }

  async pendingDrafts() {
    return await this.db.select().from(drafts)
      .where(and(eq(drafts.workspaceId, this.workspaceId), eq(drafts.state, 'pending')))
      .orderBy(desc(drafts.createdAt));
  }
  async draft(id: string) {
    return (await this.db.select().from(drafts)
      .where(and(eq(drafts.workspaceId, this.workspaceId), eq(drafts.id, id))).limit(1))[0];
  }
  /** The tasks page needs a join; it does NOT need the tables. */
  async taskRows(limit = 100) {
    return await this.db.select({
        id: tasks.id, writeState: tasks.writeState, createdAt: tasks.createdAt,
        title: drafts.title, owner: drafts.suggestedOwner, due: drafts.suggestedDueDate,
        memberId: confirmations.memberId,
      }).from(tasks)
      .innerJoin(confirmations, and(eq(confirmations.workspaceId, tasks.workspaceId), eq(confirmations.id, tasks.confirmationId)))
      .innerJoin(drafts, and(eq(drafts.workspaceId, confirmations.workspaceId), eq(drafts.id, confirmations.draftId)))
      .where(eq(tasks.workspaceId, this.workspaceId))
      .orderBy(desc(tasks.createdAt)).limit(limit);
  }

  async auditRows(limit = 100) {
    return await this.db.select().from(auditEvents)
      .where(eq(auditEvents.workspaceId, this.workspaceId))
      .orderBy(desc(auditEvents.id)).limit(limit);
  }

  async recentTasks(limit = 20) {
    return await this.db.select().from(tasks)
      .where(eq(tasks.workspaceId, this.workspaceId)).orderBy(desc(tasks.createdAt)).limit(limit);
  }

  /**
   * The ONLY function that can produce a Confirmation, and the ONLY function that
   * may create a Task. A task cannot be created from a draft id anywhere in this
   * codebase: there is no such signature. (ADR 0002)
   */
  async confirm(draftId: string, decision: 'confirmed' | 'confirmed_with_edits' | 'rejected',
                memberId: string, edits?: { title?: string; outcome?: string; suggestedOwner?: string | null; suggestedDueDate?: string | null }) {
    const d = await this.draft(draftId);
    if (!d) return { ok: false as const, reason: 'not_found' };

    // Checked BEFORE the pending test: after the first confirmation the draft is no
    // longer pending, and a double-click must still get the same answer (brief 1.6).
    const prior = (await this.db.select().from(confirmations).where(and(
      eq(confirmations.workspaceId, this.workspaceId), eq(confirmations.draftId, draftId))).limit(1))[0];
    if (prior) {
      if (prior.memberId !== memberId) return { ok: false as const, reason: 'already_confirmed' };
      const t = (await this.db.select().from(tasks).where(and(
        eq(tasks.workspaceId, this.workspaceId), eq(tasks.confirmationId, prior.id))).limit(1))[0];
      return { ok: true as const, confirmationId: prior.id, taskId: t?.id ?? null, replayed: true as const };
    }

    if (d.state !== 'pending') return { ok: false as const, reason: 'not_pending' };

    const member = (await this.db.select().from(members).where(and(
      eq(members.workspaceId, this.workspaceId), eq(members.id, memberId))).limit(1))[0];
    if (!member || member.status !== 'active') return { ok: false as const, reason: 'no_such_member' };



    const confirmationId = randomUUID();
    try {
      // withTx(), not db.transaction(): the two drivers disagree about whether the
      // callback may be async, and this one has to be (see src/db/tx.ts).
      await withTx(this.db, async (tx) => {
        await tx.insert(confirmations).values({
          workspaceId: this.workspaceId, draftId, id: confirmationId, decision,
          surface: 'web', memberId, createdAt: Date.now(),
        });
        if (decision !== 'rejected') {
          await tx.insert(tasks).values({
            workspaceId: this.workspaceId, id: randomUUID(), confirmationId,
            writeState: 'queued', threadReplyState: 'pending',
            idempotencyKey: confirmationId, createdAt: Date.now(),
          });
        }
      });
    } catch {
      // the UNIQUE (workspace_id, draft_id) index lost a race with another confirmer
      return { ok: false as const, reason: 'already_confirmed' };
    }

    if (edits && decision === 'confirmed_with_edits') {
      // What the human changed is the training signal for routing later, so record
      // WHICH fields moved. The values themselves are content and stay out of audit.
      const changed = [
        edits.title !== undefined && edits.title !== d.title ? 'title' : null,
        edits.outcome !== undefined && edits.outcome !== d.outcome ? 'outcome' : null,
        (edits.suggestedOwner ?? null) !== (d.suggestedOwner ?? null) ? 'owner' : null,
        (edits.suggestedDueDate ?? null) !== (d.suggestedDueDate ?? null) ? 'due_date' : null,
      ].filter(Boolean) as string[];
      await this.audit('draft.edited', 'ok', { draft_id: draftId, edited_fields: changed.join(','), edited_count: changed.length });
      await this.db.update(drafts).set({
        title: edits.title ?? d.title, outcome: edits.outcome ?? d.outcome,
        suggestedOwner: edits.suggestedOwner ?? d.suggestedOwner,
        suggestedDueDate: edits.suggestedDueDate ?? d.suggestedDueDate,
      }).where(and(eq(drafts.workspaceId, this.workspaceId), eq(drafts.id, draftId)));
    }

    await this.db.update(drafts).set({ state: decision === 'rejected' ? 'rejected' : 'confirmed' })
      .where(and(eq(drafts.workspaceId, this.workspaceId), eq(drafts.id, draftId)));
    await this.audit(decision === 'rejected' ? 'draft.rejected' : 'draft.confirmed', 'ok',
                     { draft_id: draftId, confirmation_id: confirmationId, member_id: memberId },
                     { actorType: 'member', actorId: memberId, objectType: 'draft', objectId: draftId });

    if (decision === 'rejected') return { ok: true as const, confirmationId, taskId: null };

    // the task row was written inside the same transaction as its confirmation
    const taskId = (await this.db.select().from(tasks).where(and(
      eq(tasks.workspaceId, this.workspaceId), eq(tasks.confirmationId, confirmationId))).limit(1))[0]!.id;
    await this.audit('task.queued', 'ok', { task_id: taskId, confirmation_id: confirmationId });
    await this.enqueue('tracker_write', { confirmationId });
    return { ok: true as const, confirmationId, taskId };
  }

  /** The roster, for owner resolution. Ids and names only. */
  async roster() {
    return await this.db.select({ id: members.id, name: members.name }).from(members)
      .where(eq(members.workspaceId, this.workspaceId));
  }

  /** The sign-in page needs names and roles, not the members table. */
  async rosterWithRoles() {
    return await this.db.select({ id: members.id, name: members.name, role: members.role, status: members.status })
      .from(members).where(eq(members.workspaceId, this.workspaceId));
  }

  /** What the tracker writer needs, fetched through the scope rather than around it. */
  async writeJob(confirmationId: string) {
    const conf = (await this.db.select().from(confirmations).where(and(
      eq(confirmations.workspaceId, this.workspaceId), eq(confirmations.id, confirmationId))).limit(1))[0];
    if (!conf) return null;
    const task = (await this.db.select().from(tasks).where(and(
      eq(tasks.workspaceId, this.workspaceId), eq(tasks.confirmationId, confirmationId))).limit(1))[0];
    const draft = (await this.db.select().from(drafts).where(and(
      eq(drafts.workspaceId, this.workspaceId), eq(drafts.id, conf.draftId))).limit(1))[0];
    return { conf, task, draft };
  }

  /**
   * Conditional on the state that was read: if another worker got there first this
   * updates zero rows, and the caller must not write, meter or audit again.
   */
  async markTaskCreated(taskId: string): Promise<boolean> {
    // affectedRows(), not `res.changes`: node-postgres reports `rowCount` and
    // reading the missing field would turn this check into "always true".
    const res = await this.db.update(tasks)
      .set({ writeState: 'created', threadReplyState: 'posted' })
      .where(and(eq(tasks.workspaceId, this.workspaceId), eq(tasks.id, taskId),
                 eq(tasks.writeState, 'queued')));
    return affectedRows(res) !== 0;
  }

  async addMember(id: string, name: string, role: 'owner'|'admin'|'confirmer'|'viewer' = 'confirmer'): Promise<void> {
    await this.db.insert(members).values({
      workspaceId: this.workspaceId, id, name, role, status: 'active',
    }).onConflictDoNothing();
  }
  async member(id: string) {
    return (await this.db.select().from(members)
      .where(and(eq(members.workspaceId, this.workspaceId), eq(members.id, id))).limit(1))[0];
  }
}
