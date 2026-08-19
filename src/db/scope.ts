/**
 * Tenancy is structural, not a convention (ADR 0003 consequence).
 * Tenant rows are ONLY reachable through a WorkspaceScope, which cannot be built
 * without an existing workspace id, and which injects workspace_id into every
 * query itself. There is no raw-db escape hatch on this class.
 */
import { and, eq, desc } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import type { openDb } from './client';
import {
  workspaces, members, sourceMessages, drafts, confirmations, tasks,
  auditEvents, actionMeter, jobs,
} from './schema';

type Db = ReturnType<typeof openDb>;

export class UnknownWorkspace extends Error {}

export class WorkspaceScope {
  private constructor(private readonly db: Db, readonly workspaceId: string) {}

  static open(db: Db, workspaceId: string): WorkspaceScope {
    const row = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
    if (!row) throw new UnknownWorkspace(workspaceId);
    return new WorkspaceScope(db, workspaceId);
  }

  static ensure(db: Db, workspaceId: string, name = workspaceId): WorkspaceScope {
    db.insert(workspaces)
      .values({ id: workspaceId, name, status: 'active', retentionContentDays: 30,
                dailyBudgetCents: 0, monthlyBudgetCents: 0, createdAt: Date.now() })
      .onConflictDoNothing().run();
    return new WorkspaceScope(db, workspaceId);
  }

  // ---- audit + meter (never carry content) ----
  audit(
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
  ) {
    this.db.insert(auditEvents).values({
      workspaceId: this.workspaceId, event, outcome,
      actorType: who?.actorType ?? (who?.actorId ? 'member' : 'system'),
      actorId: who?.actorId ?? null,
      objectType: who?.objectType ?? null,
      objectId: who?.objectId ?? null,
      // omitted rather than undefined, so the database default fires
      ...(who?.requestId ? { requestId: who.requestId } : {}),
      detail: detail ? JSON.stringify(detail) : null, at: Date.now(),
    }).run();
  }

  meter(purpose: 'detect'|'draft'|'route'|'replay'|'other',
        outcome: 'ok'|'timeout'|'invalid_output'|'provider_error'|'budget_blocked') {
    this.db.insert(actionMeter).values({
      workspaceId: this.workspaceId, purpose, outcome, at: Date.now(),
    }).run();
  }

  // ---- ingest ----
  ingestMessage(input: { channelId: string; ts: string; authorId: string; body: string }) {
    const id = randomUUID();
    const bodyHash = createHash('sha256').update(input.body).digest('hex');
    const existing = this.db.select().from(sourceMessages).where(and(
      eq(sourceMessages.workspaceId, this.workspaceId),
      eq(sourceMessages.channelId, input.channelId),
      eq(sourceMessages.ts, input.ts),
    )).get();
    if (existing) return { row: existing, created: false as const };
    this.db.insert(sourceMessages).values({
      workspaceId: this.workspaceId, channelId: input.channelId, ts: input.ts, id,
      authorId: input.authorId, body: input.body, bodyHash,
      contentPurgedAt: null, receivedAt: Date.now(),
    }).run();
    this.audit('message.ingested', 'ok', { message_id: id });
    const row = this.db.select().from(sourceMessages).where(and(
      eq(sourceMessages.workspaceId, this.workspaceId),
      eq(sourceMessages.channelId, input.channelId),
      eq(sourceMessages.ts, input.ts),
    )).get()!;
    return { row, created: true as const };
  }

  messageById(id: string) {
    return this.db.select().from(sourceMessages)
      .where(and(eq(sourceMessages.workspaceId, this.workspaceId), eq(sourceMessages.id, id))).get();
  }

  // ---- jobs ----
  enqueue(queue: string, payload: Record<string, unknown>) {
    const id = randomUUID();
    this.db.insert(jobs).values({
      workspaceId: this.workspaceId, id, queue, status: 'queued',
      payload: JSON.stringify(payload), runAt: Date.now(), attempts: 0, createdAt: Date.now(),
    }).run();
    return id;
  }

  // ---- drafts ----
  createDraft(d: { sourceMessageId: string; title: string; outcome: string;
                   kind: 'commitment'|'request'|'decision'; confidence: number;
                   suggestedOwner: string | null; suggestedDueDate: string | null; provider: string }) {
    const id = randomUUID();
    this.db.insert(drafts).values({
      workspaceId: this.workspaceId, id, sourceMessageId: d.sourceMessageId,
      title: d.title, outcome: d.outcome, kind: d.kind, confidence: Math.round(d.confidence),
      suppressedReason: null, suggestedDueDate: d.suggestedDueDate, suggestedOwner: d.suggestedOwner,
      state: 'pending', provider: d.provider, createdAt: Date.now(),
    }).run();
    this.audit('draft.created', 'ok', { draft_id: id, confidence: Math.round(d.confidence) });
    return id;
  }

  pendingDrafts() {
    return this.db.select().from(drafts)
      .where(and(eq(drafts.workspaceId, this.workspaceId), eq(drafts.state, 'pending')))
      .orderBy(desc(drafts.createdAt)).all();
  }
  draft(id: string) {
    return this.db.select().from(drafts)
      .where(and(eq(drafts.workspaceId, this.workspaceId), eq(drafts.id, id))).get();
  }
  /** The tasks page needs a join; it does NOT need the tables. */
  taskRows(limit = 100) {
    return this.db.select({
        id: tasks.id, writeState: tasks.writeState, createdAt: tasks.createdAt,
        title: drafts.title, owner: drafts.suggestedOwner, due: drafts.suggestedDueDate,
        memberId: confirmations.memberId,
      }).from(tasks)
      .innerJoin(confirmations, and(eq(confirmations.workspaceId, tasks.workspaceId), eq(confirmations.id, tasks.confirmationId)))
      .innerJoin(drafts, and(eq(drafts.workspaceId, confirmations.workspaceId), eq(drafts.id, confirmations.draftId)))
      .where(eq(tasks.workspaceId, this.workspaceId))
      .orderBy(desc(tasks.createdAt)).limit(limit).all();
  }

  auditRows(limit = 100) {
    return this.db.select().from(auditEvents)
      .where(eq(auditEvents.workspaceId, this.workspaceId))
      .orderBy(desc(auditEvents.id)).limit(limit).all();
  }

  recentTasks(limit = 20) {
    return this.db.select().from(tasks)
      .where(eq(tasks.workspaceId, this.workspaceId)).orderBy(desc(tasks.createdAt)).limit(limit).all();
  }

  /**
   * The ONLY function that can produce a Confirmation, and the ONLY function that
   * may create a Task. A task cannot be created from a draft id anywhere in this
   * codebase: there is no such signature. (ADR 0002)
   */
  confirm(draftId: string, decision: 'confirmed' | 'confirmed_with_edits' | 'rejected',
          memberId: string, edits?: { title?: string; outcome?: string; suggestedOwner?: string | null; suggestedDueDate?: string | null }) {
    const d = this.draft(draftId);
    if (!d) return { ok: false as const, reason: 'not_found' };
    if (d.state !== 'pending') return { ok: false as const, reason: 'not_pending' };

    const member = this.db.select().from(members).where(and(
      eq(members.workspaceId, this.workspaceId), eq(members.id, memberId))).get();
    if (!member || member.status !== 'active') return { ok: false as const, reason: 'no_such_member' };

    const already = this.db.select().from(confirmations).where(and(
      eq(confirmations.workspaceId, this.workspaceId), eq(confirmations.draftId, draftId))).get();
    if (already) return { ok: false as const, reason: 'already_confirmed' };

    const confirmationId = randomUUID();
    try {
      this.db.transaction((tx) => {
        tx.insert(confirmations).values({
          workspaceId: this.workspaceId, draftId, id: confirmationId, decision,
          surface: 'web', memberId, createdAt: Date.now(),
        }).run();
        if (decision !== 'rejected') {
          tx.insert(tasks).values({
            workspaceId: this.workspaceId, id: randomUUID(), confirmationId,
            writeState: 'queued', threadReplyState: 'pending',
            idempotencyKey: confirmationId, createdAt: Date.now(),
          }).run();
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
      this.audit('draft.edited', 'ok', { draft_id: draftId, edited_fields: changed.join(','), edited_count: changed.length });
      this.db.update(drafts).set({
        title: edits.title ?? d.title, outcome: edits.outcome ?? d.outcome,
        suggestedOwner: edits.suggestedOwner ?? d.suggestedOwner,
        suggestedDueDate: edits.suggestedDueDate ?? d.suggestedDueDate,
      }).where(and(eq(drafts.workspaceId, this.workspaceId), eq(drafts.id, draftId))).run();
    }

    this.db.update(drafts).set({ state: decision === 'rejected' ? 'rejected' : 'confirmed' })
      .where(and(eq(drafts.workspaceId, this.workspaceId), eq(drafts.id, draftId))).run();
    this.audit(decision === 'rejected' ? 'draft.rejected' : 'draft.confirmed', 'ok',
               { draft_id: draftId, confirmation_id: confirmationId, member_id: memberId },
               { actorType: 'member', actorId: memberId, objectType: 'draft', objectId: draftId });

    if (decision === 'rejected') return { ok: true as const, confirmationId, taskId: null };

    // the task row was written inside the same transaction as its confirmation
    const taskId = this.db.select().from(tasks).where(and(
      eq(tasks.workspaceId, this.workspaceId), eq(tasks.confirmationId, confirmationId))).get()!.id;
    this.audit('task.queued', 'ok', { task_id: taskId, confirmation_id: confirmationId });
    this.enqueue('tracker_write', { confirmationId });
    return { ok: true as const, confirmationId, taskId };
  }

  /** The roster, for owner resolution. Ids and names only. */
  roster() {
    return this.db.select({ id: members.id, name: members.name }).from(members)
      .where(eq(members.workspaceId, this.workspaceId)).all();
  }

  /** The sign-in page needs names and roles, not the members table. */
  rosterWithRoles() {
    return this.db.select({ id: members.id, name: members.name, role: members.role, status: members.status })
      .from(members).where(eq(members.workspaceId, this.workspaceId)).all();
  }

  /** What the tracker writer needs, fetched through the scope rather than around it. */
  writeJob(confirmationId: string) {
    const conf = this.db.select().from(confirmations).where(and(
      eq(confirmations.workspaceId, this.workspaceId), eq(confirmations.id, confirmationId))).get();
    if (!conf) return null;
    const task = this.db.select().from(tasks).where(and(
      eq(tasks.workspaceId, this.workspaceId), eq(tasks.confirmationId, confirmationId))).get();
    const draft = this.db.select().from(drafts).where(and(
      eq(drafts.workspaceId, this.workspaceId), eq(drafts.id, conf.draftId))).get();
    return { conf, task, draft };
  }

  /**
   * Conditional on the state that was read: if another worker got there first this
   * updates zero rows, and the caller must not write, meter or audit again.
   */
  markTaskCreated(taskId: string): boolean {
    const res: any = this.db.update(tasks)
      .set({ writeState: 'created', threadReplyState: 'posted' })
      .where(and(eq(tasks.workspaceId, this.workspaceId), eq(tasks.id, taskId),
                 eq(tasks.writeState, 'queued'))).run();
    return res?.changes !== 0;
  }

  addMember(id: string, name: string, role: 'owner'|'admin'|'confirmer'|'viewer' = 'confirmer') {
    this.db.insert(members).values({
      workspaceId: this.workspaceId, id, name, role, status: 'active',
    }).onConflictDoNothing().run();
  }
  member(id: string) {
    return this.db.select().from(members)
      .where(and(eq(members.workspaceId, this.workspaceId), eq(members.id, id))).get();
  }
}
