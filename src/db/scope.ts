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
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import type { openDb } from './client';
import { affectedRows } from './client';
import { withTx } from './tx';
import {
  workspaces, members, memberCredentials, sourceMessages, drafts, confirmations, tasks,
  auditEvents, actionMeter, jobs, draftReasons, taskWrites, oauthProviders,
  sourceConnections, sourceChannels, confirmationEdits,
} from './schema';
import { normaliseEmail } from '../password';

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
    // The page shows the task as AGREED, so an edited field wins over the model's
    // proposal; the draft is the fallback for every field the human left alone.
    // The join is LEFT because most confirmations carry no edits at all.
    return await this.db.select({
        id: tasks.id, writeState: tasks.writeState, createdAt: tasks.createdAt,
        title: sql<string>`coalesce(${confirmationEdits.title}, ${drafts.title})`,
        owner: sql<string | null>`coalesce(${confirmationEdits.owner}, ${drafts.suggestedOwner})`,
        due: sql<string | null>`coalesce(${confirmationEdits.dueDate}, ${drafts.suggestedDueDate})`,
        memberId: confirmations.memberId,
      }).from(tasks)
      .innerJoin(confirmations, and(eq(confirmations.workspaceId, tasks.workspaceId), eq(confirmations.id, tasks.confirmationId)))
      .innerJoin(drafts, and(eq(drafts.workspaceId, confirmations.workspaceId), eq(drafts.id, confirmations.draftId)))
      .leftJoin(confirmationEdits, and(eq(confirmationEdits.workspaceId, confirmations.workspaceId), eq(confirmationEdits.confirmationId, confirmations.id)))
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



    // Which fields the human actually moved, and to what.
    //
    // The draft row is what the MODEL proposed and is immutable from here on. This
    // used to be an UPDATE against `drafts`, which destroyed the model's proposal:
    // afterwards "the model got it right and the human agreed" and "the model got
    // it wrong and the human rewrote it" were indistinguishable, so acceptance rate
    // and owner accuracy could not be computed at all. ADR 0002 calls this loop the
    // product's only compounding data asset, and REVIEW.md M6 is explicit that edits
    // are data, not discards. The human's values go in a sidecar instead.
    //
    // A field is recorded only when it actually differs from the draft, so NULL in
    // the sidecar reads as "the human left this alone" rather than "changed it to
    // the same thing".
    const edited = edits && decision === 'confirmed_with_edits'
      ? {
          title: edits.title !== undefined && edits.title !== d.title ? edits.title : null,
          outcome: edits.outcome !== undefined && edits.outcome !== d.outcome ? edits.outcome : null,
          owner: (edits.suggestedOwner ?? null) !== (d.suggestedOwner ?? null) ? (edits.suggestedOwner ?? null) : null,
          dueDate: (edits.suggestedDueDate ?? null) !== (d.suggestedDueDate ?? null) ? (edits.suggestedDueDate ?? null) : null,
        }
      : null;
    const changed = edited
      ? (['title', 'outcome', 'owner', 'due_date'] as const)
          .filter((_, i) => [edited.title, edited.outcome, edited.owner, edited.dueDate][i] !== null)
      : [];

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
        // In the SAME transaction as the confirmation it belongs to: an edit that
        // outlived a rolled-back confirm would be an edit to nothing, and the
        // tracker writer reads these values to decide what to create.
        if (edited) {
          await tx.insert(confirmationEdits).values({
            workspaceId: this.workspaceId, confirmationId,
            editedFields: changed.join(','),
            title: edited.title, outcome: edited.outcome,
            owner: edited.owner, dueDate: edited.dueDate,
            createdAt: Date.now(),
          });
        }
      });
    } catch {
      // the UNIQUE (workspace_id, draft_id) index lost a race with another confirmer
      return { ok: false as const, reason: 'already_confirmed' };
    }

    if (edited) {
      // WHICH fields moved is signal for routing later; the values themselves are
      // customer content and stay out of the audit log.
      await this.audit('draft.edited', 'ok', { draft_id: draftId, edited_fields: changed.join(','), edited_count: changed.length });
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
    // What the human changed, if anything. The tracker must receive the values the
    // human AGREED to, not the ones the model proposed — writing the model's words
    // into the customer's tracker after a human corrected them is the failure this
    // whole sidecar exists to prevent.
    const edit = (await this.db.select().from(confirmationEdits).where(and(
      eq(confirmationEdits.workspaceId, this.workspaceId),
      eq(confirmationEdits.confirmationId, confirmationId))).limit(1))[0];
    const agreed = draft && {
      title: edit?.title ?? draft.title,
      outcome: edit?.outcome ?? draft.outcome,
      owner: edit?.owner ?? draft.suggestedOwner,
      dueDate: edit?.dueDate ?? draft.suggestedDueDate,
    };
    return { conf, task, draft, edit, agreed };
  }

  /**
   * Take the exclusive right to call the tracker for this task.
   *
   * The claim is a row, not a state flag on `tasks`, and it is taken BEFORE the
   * network call while `tasks.write_state` stays 'queued'. That ordering is the
   * fix for the failure this replaced: marking the task 'created' first meant a
   * failed API call produced a task that claimed to exist in the customer's
   * tracker and could never be retried, because the retry returns early on
   * 'created'. Now nothing claims the issue exists until the tracker says so.
   *
   * Returns 'claimed' when this worker owns the write, 'done' when the issue
   * already exists (another worker finished it), and 'busy' when another worker
   * holds a live claim. A claim older than `leaseMs` is taken over: a worker
   * that died mid-write must not block the write forever.
   */
  async claimTaskWrite(taskId: string, leaseMs = 120_000): Promise<'claimed' | 'busy' | 'done'> {
    const now = Date.now();
    const inserted = await this.db.insert(taskWrites).values({
      workspaceId: this.workspaceId, taskId, state: 'claimed', attempts: 1, claimedAt: now,
    }).onConflictDoNothing();
    if (affectedRows(inserted) !== 0) return 'claimed';

    const row = (await this.db.select().from(taskWrites).where(and(
      eq(taskWrites.workspaceId, this.workspaceId), eq(taskWrites.taskId, taskId))).limit(1))[0];
    if (!row) return 'busy';                       // lost a race with a concurrent insert
    if (row.state === 'done') return 'done';
    if (now - row.claimedAt < leaseMs) return 'busy';

    // Expired lease. Conditional on the timestamp we read, so exactly one worker
    // can take it over however many are trying.
    const taken = await this.db.update(taskWrites)
      .set({ claimedAt: now, attempts: row.attempts + 1 })
      .where(and(eq(taskWrites.workspaceId, this.workspaceId), eq(taskWrites.taskId, taskId),
                 eq(taskWrites.state, 'claimed'), eq(taskWrites.claimedAt, row.claimedAt)));
    return affectedRows(taken) !== 0 ? 'claimed' : 'busy';
  }

  /**
   * The tracker answered with an id. Only now does the task claim to exist, and
   * only from the 'queued' state, so a second completion cannot double-count.
   */
  async completeTaskWrite(taskId: string, result: { tracker: string; externalId: string; externalUrl: string }): Promise<boolean> {
    const res = await this.db.update(tasks)
      // affectedRows(), not `res.changes`: node-postgres reports `rowCount` and
      // reading the missing field would turn this check into "always true".
      .set({ writeState: 'created' })
      .where(and(eq(tasks.workspaceId, this.workspaceId), eq(tasks.id, taskId),
                 eq(tasks.writeState, 'queued')));
    const first = affectedRows(res) !== 0;
    await this.db.update(taskWrites)
      .set({ state: 'done', tracker: result.tracker, externalId: result.externalId,
             externalUrl: result.externalUrl, completedAt: Date.now() })
      .where(and(eq(taskWrites.workspaceId, this.workspaceId), eq(taskWrites.taskId, taskId)));
    return first;
  }

  /** The tracker call failed. Drop the claim so the retry can take it. */
  async releaseTaskWrite(taskId: string): Promise<void> {
    await this.db.delete(taskWrites).where(and(
      eq(taskWrites.workspaceId, this.workspaceId), eq(taskWrites.taskId, taskId),
      eq(taskWrites.state, 'claimed')));
  }

  /** The external issue this task became, if it has been written. */
  async taskWrite(taskId: string) {
    return (await this.db.select().from(taskWrites).where(and(
      eq(taskWrites.workspaceId, this.workspaceId), eq(taskWrites.taskId, taskId))).limit(1))[0];
  }

  /** The thread reply is recorded when it is actually posted, never before. */
  async markThreadReply(taskId: string, state: 'posted' | 'skipped' | 'failed'): Promise<void> {
    await this.db.update(tasks).set({ threadReplyState: state })
      .where(and(eq(tasks.workspaceId, this.workspaceId), eq(tasks.id, taskId)));
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
  async memberByEmail(email: string) {
    const norm = normaliseEmail(email);
    if (!norm) return undefined;
    return (await this.db.select().from(members)
      .where(and(eq(members.workspaceId, this.workspaceId), eq(memberCredentials.email, norm)))
      .innerJoin(memberCredentials, and(eq(memberCredentials.workspaceId, this.workspaceId), eq(memberCredentials.memberId, members.id)))
      .limit(1))[0];
  }

  // ---------------------------------------------------------------------
  // The Slack connection, and the channels the admin agreed we may read.
  // ---------------------------------------------------------------------

  /** Stores or replaces the connection. The token arrives already sealed. */
  async saveConnection(c: { teamId: string; teamName: string | null; botUserId: string | null;
                            tokenEnc: string; scopes: string; installedBy: string }): Promise<void> {
    const row = {
      workspaceId: this.workspaceId, provider: 'slack' as const, teamId: c.teamId, teamName: c.teamName,
      botUserId: c.botUserId, tokenEnc: c.tokenEnc, scopes: c.scopes, installedBy: c.installedBy,
      installedAt: Date.now(), revokedAt: null,
    };
    await this.db.insert(sourceConnections).values(row).onConflictDoUpdate({
      target: [sourceConnections.workspaceId, sourceConnections.provider],
      set: { teamId: row.teamId, teamName: row.teamName, botUserId: row.botUserId, tokenEnc: row.tokenEnc,
             scopes: row.scopes, installedBy: row.installedBy, installedAt: row.installedAt, revokedAt: null },
    });
  }

  /** The live connection, or undefined when absent or revoked. */
  async connection() {
    const row = (await this.db.select().from(sourceConnections).where(and(
      eq(sourceConnections.workspaceId, this.workspaceId),
      eq(sourceConnections.provider, 'slack'))).limit(1))[0];
    return row && !row.revokedAt ? row : undefined;
  }

  /** Disconnect: the token is destroyed, not just flagged. */
  async revokeConnection(): Promise<void> {
    await this.db.update(sourceConnections)
      .set({ revokedAt: Date.now(), tokenEnc: '' })
      .where(and(eq(sourceConnections.workspaceId, this.workspaceId), eq(sourceConnections.provider, 'slack')));
    await this.db.update(sourceChannels).set({ selected: 0, selectedAt: null })
      .where(eq(sourceChannels.workspaceId, this.workspaceId));
  }

  /** Records the channels Slack reported, preserving the admin's selection. */
  async recordChannels(list: Array<{ id: string; name: string; isPrivate: boolean }>): Promise<void> {
    const now = Date.now();
    for (const c of list) {
      await this.db.insert(sourceChannels).values({
        workspaceId: this.workspaceId, channelId: c.id, name: c.name,
        isPrivate: c.isPrivate ? 1 : 0, selected: 0, seenAt: now,
      }).onConflictDoUpdate({
        target: [sourceChannels.workspaceId, sourceChannels.channelId],
        set: { name: c.name, isPrivate: c.isPrivate ? 1 : 0, seenAt: now },
      });
    }
  }

  async channels() {
    return await this.db.select().from(sourceChannels)
      .where(eq(sourceChannels.workspaceId, this.workspaceId)).orderBy(sourceChannels.name);
  }

  async selectedChannels() {
    return await this.db.select().from(sourceChannels).where(and(
      eq(sourceChannels.workspaceId, this.workspaceId), eq(sourceChannels.selected, 1)));
  }

  /** True when this channel is one the admin ticked. The webhook asks this. */
  async isChannelSelected(channelId: string): Promise<boolean> {
    const row = (await this.db.select({ selected: sourceChannels.selected }).from(sourceChannels).where(and(
      eq(sourceChannels.workspaceId, this.workspaceId), eq(sourceChannels.channelId, channelId))).limit(1))[0];
    return Number(row?.selected ?? 0) === 1;
  }

  /** Replaces the selection wholesale: the list is the statement of consent. */
  async setSelectedChannels(ids: string[]): Promise<void> {
    const now = Date.now();
    await this.db.update(sourceChannels).set({ selected: 0, selectedAt: null })
      .where(eq(sourceChannels.workspaceId, this.workspaceId));
    if (!ids.length) return;
    await this.db.update(sourceChannels).set({ selected: 1, selectedAt: now })
      .where(and(eq(sourceChannels.workspaceId, this.workspaceId), inArray(sourceChannels.channelId, ids)));
  }

  // ---------------------------------------------------------------------
  // OAuth sign-in. These live here, and not in src/oauth.ts, for the reason
  // tools/check-tenancy.ts exists: `members`, `member_credentials` and
  // `oauth_providers` are tenant-owned, so the workspace id must be injected by
  // the scope rather than passed in by a caller who might forget.
  // ---------------------------------------------------------------------

  /** Links a provider identity to a member. Repeat calls are a no-op. */
  async linkOAuth(memberId: string, info: { provider: 'google' | 'github'; providerUserId: string; email: string | null; name: string | null }): Promise<void> {
    await this.db.insert(oauthProviders).values({
      workspaceId: this.workspaceId, memberId, provider: info.provider,
      providerUserId: info.providerUserId, email: info.email ? normaliseEmail(info.email) : null,
      name: info.name, createdAt: Date.now(),
    }).onConflictDoNothing();
  }

  /** The member behind a provider identity, or undefined. */
  async memberByOAuth(provider: 'google' | 'github', providerUserId: string) {
    const link = (await this.db.select().from(oauthProviders).where(and(
      eq(oauthProviders.workspaceId, this.workspaceId), eq(oauthProviders.provider, provider),
      eq(oauthProviders.providerUserId, providerUserId))).limit(1))[0];
    if (!link) return undefined;
    const m = await this.member(link.memberId);
    return m ? { memberId: link.memberId, member: m } : undefined;
  }

  /** The member linked to this email through any provider, or undefined. */
  async memberIdByOAuthEmail(email: string): Promise<string | undefined> {
    const norm = normaliseEmail(email);
    if (!norm) return undefined;
    const row = (await this.db.select().from(oauthProviders).where(and(
      eq(oauthProviders.workspaceId, this.workspaceId), eq(oauthProviders.email, norm))).limit(1))[0];
    return row?.memberId;
  }

  /** Session invalidation stamp: when the password was last set. */
  async passwordVersion(memberId: string): Promise<number> {
    const row = (await this.db.select().from(memberCredentials).where(and(
      eq(memberCredentials.workspaceId, this.workspaceId),
      eq(memberCredentials.memberId, memberId))).limit(1))[0];
    return Number(row?.passwordSetAt ?? 0);
  }

  async setDraftReason(draftId: string, reason: string, promptVersion: string): Promise<void> {
    await this.db.insert(draftReasons).values({
      workspaceId: this.workspaceId,
      draftId,
      reason,
      promptVersion: promptVersion,
      createdAt: Date.now()
    }).onConflictDoUpdate({
      target: [draftReasons.workspaceId, draftReasons.draftId],
      set: { reason, promptVersion: promptVersion, createdAt: Date.now() }
    });
  }

  async draftReasons(draftIds: string[]): Promise<Record<string, string>> {
    if (draftIds.length === 0) return {};
    const rows = await this.db.select({ draftId: draftReasons.draftId, reason: draftReasons.reason })
      .from(draftReasons)
      .where(and(
        eq(draftReasons.workspaceId, this.workspaceId),
        inArray(draftReasons.draftId, draftIds)
      ));
    return rows.reduce((acc, row) => ({
      ...acc,
      [row.draftId]: row.reason
    }), {});
  }

}
