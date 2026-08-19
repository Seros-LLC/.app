import type { Request, Response } from 'express';
import { z } from 'zod';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { sanitizeDueDate } from '../sanitize';

/**
 * L2: everything that is not "reject" used to be treated as a confirm, so
 * `decision=banana` created a task. The form is parsed rather than assumed.
 */
const Body = z.object({
  draftId: z.string().min(1).max(64),
  decision: z.enum(['confirm', 'reject']),
  csrf: z.string().min(1),
  title: z.string().trim().min(1).max(160).optional(),
  outcome: z.string().trim().min(1).max(400).optional(),
  owner: z.string().trim().max(64).optional().or(z.literal('')),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
});

export function confirmHandler(req: Request, res: Response) {
  const s = req.session!;                    // requireSession + requireCsrf ran already
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).send('that form did not make sense: ' + parsed.error.issues.map((i) => i.path.join('.')).join(', '));
  }
  const { draftId, decision, title, outcome, owner, due } = parsed.data;

  const db = openDb();
  const scope = WorkspaceScope.open(db, s.workspaceId);

  const me = scope.member(s.memberId);
  if (!me || me.status !== 'active') return res.status(403).send('not an active member');
  if (me.role === 'viewer') {
    scope.audit('draft.confirm_denied', 'denied', { member_id: me.id, draft_id: draftId },
                { actorType: 'member', actorId: me.id, objectType: 'draft', objectId: draftId });
    return res.status(403).send('your role cannot confirm');
  }

  const d = scope.draft(draftId);
  if (!d) return res.status(404).send('no such draft');

  // A human may type any date they like, but it is still checked against the message
  // rather than trusted, exactly as the model's suggestion was.
  const dueClean = due ? sanitizeDueDate(scope.messageById(d.sourceMessageId)?.body ?? '', due) ?? due : null;

  const nextTitle = title ?? d.title;
  const nextOutcome = outcome ?? d.outcome;
  const nextOwner = owner ? owner : null;
  const edited = decision === 'confirm' &&
    (nextTitle !== d.title || nextOutcome !== d.outcome ||
     nextOwner !== (d.suggestedOwner || null) || dueClean !== (d.suggestedDueDate || null));

  const kind = decision === 'reject' ? 'rejected' : edited ? 'confirmed_with_edits' : 'confirmed';
  const r = scope.confirm(draftId, kind, me.id, {
    title: nextTitle, outcome: nextOutcome, suggestedOwner: nextOwner, suggestedDueDate: dueClean,
  });
  if (!r.ok) return res.status(409).send(r.reason);

  const msg = (r as any).replayed ? 'Already confirmed. Nothing was written twice.'
    : kind === 'rejected' ? 'Rejected. Nothing was written.'
    : kind === 'confirmed_with_edits' ? 'Confirmed with your edits. Task queued.'
    : 'Confirmed. Task queued.';
  return res.redirect(303, '/queue?msg=' + encodeURIComponent(msg));
}
