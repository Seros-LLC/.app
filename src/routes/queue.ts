import type { Request, Response } from 'express';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { page, esc } from '../views';
import { and, desc, eq } from 'drizzle-orm';
import { auditEvents, confirmations, drafts, tasks } from '../db/schema';

const WS = () => process.env.SEROS_WORKSPACE || 'demo';
const ME = () => process.env.SEROS_MEMBER || 'u-demo';

export function queuePage(req: Request, res: Response) {
  const db = openDb();
  const scope = WorkspaceScope.ensure(db, WS());
  scope.addMember(ME(), 'Demo Confirmer', 'confirmer');
  const rows = scope.pendingDrafts();
  const flash = typeof req.query.msg === 'string' ? req.query.msg : '';

  const body = `
  <h1>Confirm queue</h1>
  <p class="sub">${rows.length} draft${rows.length === 1 ? '' : 's'} waiting. Nothing is written to a tracker until you confirm it.</p>
  ${flash ? `<p class="pill ok">${esc(flash)}</p>` : ''}
  ${rows.length === 0 ? `<div class="empty">The queue is empty. Post a message on the <a href="/demo">demo page</a> to create one.</div>` : ''}
  ${rows.map((d) => `
    <form class="card" method="post" action="/confirm">
      <input type="hidden" name="draftId" value="${esc(d.id)}">
      <p class="meta">${esc(d.kind)} &middot; confidence ${esc(d.confidence)}% &middot; ${esc(d.provider ?? 'unknown')}</p>
      <div class="grid">
        <div><label for="t-${esc(d.id)}">Title</label>
          <input id="t-${esc(d.id)}" type="text" name="title" value="${esc(d.title)}" size="40"></div>
        <div><label for="o-${esc(d.id)}">Owner</label>
          <input id="o-${esc(d.id)}" type="text" name="owner" value="${esc(d.suggestedOwner ?? '')}"></div>
      </div>
      <div class="grid">
        <div><label for="c-${esc(d.id)}">Outcome</label>
          <input id="c-${esc(d.id)}" type="text" name="outcome" value="${esc(d.outcome)}" size="40"></div>
        <div><label for="d-${esc(d.id)}">Due</label>
          <input id="d-${esc(d.id)}" type="date" name="due" value="${esc(d.suggestedDueDate ?? '')}"></div>
      </div>
      <div class="row">
        <button class="primary" type="submit" name="decision" value="confirm">Confirm</button>
        <button type="submit" name="decision" value="reject">Reject</button>
      </div>
    </form>`).join('')}`;
  res.type('html').send(page('Confirm queue', '/queue', body));
}

export function tasksPage(_req: Request, res: Response) {
  const db = openDb();
  const scope = WorkspaceScope.ensure(db, WS());
  const rows = db.select({
      id: tasks.id, writeState: tasks.writeState, createdAt: tasks.createdAt,
      title: drafts.title, owner: drafts.suggestedOwner, due: drafts.suggestedDueDate,
      memberId: confirmations.memberId,
    }).from(tasks)
    .innerJoin(confirmations, and(eq(confirmations.workspaceId, tasks.workspaceId), eq(confirmations.id, tasks.confirmationId)))
    .innerJoin(drafts, and(eq(drafts.workspaceId, confirmations.workspaceId), eq(drafts.id, confirmations.draftId)))
    .where(eq(tasks.workspaceId, scope.workspaceId))
    .orderBy(desc(tasks.createdAt)).all();

  const body = `<h1>Tasks</h1>
  <p class="sub">Every row here has a confirmation behind it. There is no other way for one to exist.</p>
  ${rows.length === 0 ? '<div class="empty">No tasks yet.</div>' : `<table>
    <tr><th>Title</th><th>Owner</th><th>Due</th><th>Confirmed by</th><th>State</th></tr>
    ${rows.map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(t.owner ?? '—')}</td>
      <td>${esc(t.due ?? '—')}</td><td>${esc(t.memberId)}</td>
      <td><span class="pill ${t.writeState === 'created' ? 'ok' : ''}">${esc(t.writeState)}</span></td></tr>`).join('')}
  </table>`}`;
  res.type('html').send(page('Tasks', '/tasks', body));
}

export function auditPage(_req: Request, res: Response) {
  const db = openDb();
  const scope = WorkspaceScope.ensure(db, WS());
  const rows = db.select().from(auditEvents)
    .where(eq(auditEvents.workspaceId, scope.workspaceId))
    .orderBy(desc(auditEvents.id)).limit(100).all();
  const body = `<h1>Audit log</h1>
  <p class="sub">Append-only. Identifiers only — no message content ever reaches this table.</p>
  ${rows.length === 0 ? '<div class="empty">Nothing recorded yet.</div>' : `<table>
    <tr><th>#</th><th>When</th><th>Event</th><th>Outcome</th><th>Detail</th></tr>
    ${rows.map((r) => `<tr><td>${r.id}</td><td>${new Date(r.at).toISOString().replace('T', ' ').slice(0, 19)}</td>
      <td>${esc(r.event)}</td><td><span class="pill ${r.outcome === 'ok' ? 'ok' : ''}">${esc(r.outcome)}</span></td>
      <td class="meta">${esc(r.detail ?? '')}</td></tr>`).join('')}
  </table>`}`;
  res.type('html').send(page('Audit', '/audit', body));
}
