import type { Request, Response } from 'express';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { page, esc } from '../views';
import type { PageContext } from '../views';

import { csrfToken } from '../auth';
import { reasonLine, reasonsFor } from '../ai/explain';

/** Who is signed in, plus anything the layout needs. Every page gets one. */
export function pageCtx(req: any, scope: any, flash?: string): PageContext {
  const s = req.session;
  const m = s ? scope.member(s.memberId) : null;
  return {
    member: m ? { id: m.id, name: m.name, role: m.role } : undefined,
    csrf: s ? csrfToken(s) : undefined,
    flash: flash || undefined,
  };
}

export function queuePage(req: Request, res: Response) {
  const s = req.session!;                       // requireSession guarantees this
  const db = openDb();
  const scope = WorkspaceScope.open(db, s.workspaceId);
  const me = scope.member(s.memberId);
  const canConfirm = !!me && me.status === 'active' && me.role !== 'viewer';
  const token = csrfToken(s);
  const rows = scope.pendingDrafts();
  const reasons = reasonsFor(scope, rows.map((d) => d.id));
  const flash = typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : '';

  const body = `
  <h1>Confirm queue</h1>
  <p class="sub">${rows.length} draft${rows.length === 1 ? '' : 's'} waiting. Nothing is written to a tracker until you confirm it.</p>
  ${rows.length === 0 ? `<div class="empty">The queue is empty. Post a message on the <a href="/demo">demo page</a> to create one.</div>` : ''}
  ${rows.map((d) => `
    <form class="card" method="post" action="/confirm">
      <input type="hidden" name="draftId" value="${esc(d.id)}">
      <input type="hidden" name="csrf" value="${esc(token)}">
      <p class="meta">${esc(d.kind)} &middot; confidence ${esc(d.confidence)}% &middot; ${esc(d.provider ?? 'unknown')}</p>
      ${reasonLine(reasons[d.id])}
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
        ${canConfirm
          ? `<button class="primary" type="submit" name="decision" value="confirm">Confirm</button>
             <button type="submit" name="decision" value="reject">Reject</button>`
          : `<span class="pill">read only — your role cannot confirm</span>`}
      </div>
    </form>`).join('')}`;
  res.type('html').send(page('Confirm queue', '/queue', body, pageCtx(req, scope, flash)));
}

export function tasksPage(req: Request, res: Response) {
  const db = openDb();
  const scope = WorkspaceScope.open(db, req.session!.workspaceId);
  const rows = scope.taskRows();

  const body = `<h1>Tasks</h1>
  <p class="sub">Every row here has a confirmation behind it. There is no other way for one to exist.</p>
  ${rows.length === 0 ? `<div class="empty">No tasks yet. Confirm something in the <a href="/queue">queue</a> and it will appear here.</div>` : `<div class="tablewrap"><table>
    <tr><th>Title</th><th>Owner</th><th>Due</th><th>Confirmed by</th><th>State</th></tr>
    ${rows.map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(t.owner ?? '—')}</td>
      <td>${esc(t.due ?? '—')}</td><td>${esc(t.memberId)}</td>
      <td><span class="pill ${t.writeState === 'created' ? 'ok' : ''}">${esc(t.writeState)}</span></td></tr>`).join('')}
  </table></div>`}`;
  res.type('html').send(page('Tasks', '/tasks', body, pageCtx(req, scope)));
}

export function auditPage(req: Request, res: Response) {
  const db = openDb();
  const scope = WorkspaceScope.open(db, req.session!.workspaceId);
  const rows = scope.auditRows();
  const body = `<h1>Audit log</h1>
  <p class="sub">Append-only. Identifiers only — no message content ever reaches this table.</p>
  ${rows.length === 0 ? '<div class="empty">Nothing recorded yet.</div>' : `<div class="tablewrap"><table>
    <tr><th>#</th><th>When</th><th>Event</th><th>Outcome</th><th>Detail</th></tr>
    ${rows.map((r) => `<tr><td>${r.id}</td><td>${new Date(r.at).toISOString().replace('T', ' ').slice(0, 19)}</td>
      <td>${esc(r.event)}</td><td><span class="pill ${r.outcome === 'ok' ? 'ok' : ''}">${esc(r.outcome)}</span></td>
      <td class="meta">${esc(r.detail ?? '')}</td></tr>`).join('')}
  </table></div>`}`;
  res.type('html').send(page('Audit', '/audit', body, pageCtx(req, scope)));
}
