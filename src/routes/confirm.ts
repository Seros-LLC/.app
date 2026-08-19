import type { Request, Response } from 'express';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';

export function confirmHandler(req: Request, res: Response) {
  const s = req.session!;                    // requireSession + requireCsrf ran already
  const { draftId, decision, title, outcome, owner, due } = req.body ?? {};
  if (!draftId || !decision) return res.status(400).send('missing draftId or decision');

  const db = openDb();
  const scope = WorkspaceScope.open(db, s.workspaceId);

  const me = scope.member(s.memberId);
  if (!me || me.status !== 'active') return res.status(403).send('not an active member');
  if (me.role === 'viewer') {                // a viewer may look, not act
    scope.audit('draft.confirm_denied', 'denied', { member_id: me.id, draft_id: String(draftId) });
    return res.status(403).send('your role cannot confirm');
  }

  const d = scope.draft(String(draftId));
  if (!d) return res.status(404).send('no such draft');

  const edited = decision === 'confirm' &&
    (title !== d.title || outcome !== d.outcome ||
     (owner || null) !== (d.suggestedOwner || null) || (due || null) !== (d.suggestedDueDate || null));

  const kind = decision === 'reject' ? 'rejected' : edited ? 'confirmed_with_edits' : 'confirmed';
  const r = scope.confirm(String(draftId), kind, me.id, {
    title: String(title ?? d.title), outcome: String(outcome ?? d.outcome),
    suggestedOwner: owner ? String(owner) : null, suggestedDueDate: due ? String(due) : null,
  });
  if (!r.ok) return res.status(409).send(r.reason);

  const msg = kind === 'rejected' ? 'Rejected. Nothing was written.'
    : kind === 'confirmed_with_edits' ? 'Confirmed with your edits. Task queued.'
    : 'Confirmed. Task queued.';
  return res.redirect(303, '/queue?msg=' + encodeURIComponent(msg));
}
