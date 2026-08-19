import type { Request, Response } from 'express';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';

const WS = () => process.env.SEROS_WORKSPACE || 'demo';
const ME = () => process.env.SEROS_MEMBER || 'u-demo';

export function confirmHandler(req: Request, res: Response) {
  const { draftId, decision, title, outcome, owner, due } = req.body ?? {};
  if (!draftId || !decision) return res.status(400).send('missing draftId or decision');

  const db = openDb();
  const scope = WorkspaceScope.ensure(db, WS());
  scope.addMember(ME(), 'Demo Confirmer', 'confirmer');
  const d = scope.draft(String(draftId));
  if (!d) return res.status(404).send('no such draft');

  const edited = decision === 'confirm' &&
    (title !== d.title || outcome !== d.outcome ||
     (owner || null) !== (d.suggestedOwner || null) || (due || null) !== (d.suggestedDueDate || null));

  const kind = decision === 'reject' ? 'rejected' : edited ? 'confirmed_with_edits' : 'confirmed';
  const r = scope.confirm(String(draftId), kind, ME(), {
    title: String(title ?? d.title), outcome: String(outcome ?? d.outcome),
    suggestedOwner: owner ? String(owner) : null, suggestedDueDate: due ? String(due) : null,
  });
  if (!r.ok) return res.status(409).send(r.reason);

  const msg = kind === 'rejected' ? 'Rejected. Nothing was written.'
    : kind === 'confirmed_with_edits' ? 'Confirmed with your edits. Task queued.'
    : 'Confirmed. Task queued.';
  return res.redirect(303, '/queue?msg=' + encodeURIComponent(msg));
}
