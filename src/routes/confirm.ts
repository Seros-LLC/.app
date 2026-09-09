import type { Request, Response } from 'express';
import { z } from 'zod';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { sanitizeDueDate } from '../sanitize';
import { errorPage } from '../views';
import { pageCtx } from './queue';

/** What each refusal from scope.confirm() means to the person who hit it. */
const CONFLICT: Record<string, [string, string]> = {
  already_confirmed: [
    'Another member has already reviewed this draft',
    'Their decision stands and nothing was written twice. The queue shows what is still waiting.',
  ],
  not_pending: [
    'This draft has already been decided',
    'It was confirmed or rejected before this form was submitted, so nothing changed. The queue shows what is still waiting.',
  ],
  no_such_member: [
    'Your membership is no longer active in this workspace',
    'Nothing was written. Ask an owner or admin to restore your access, then review the draft again.',
  ],
};

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

export async function confirmHandler(req: Request, res: Response) {
  const s = req.serosSession!;                    // requireSession + requireCsrf ran already
  const db = openDb();
  const scope = await WorkspaceScope.open(db, s.workspaceId);
  // Every refusal below is a page in the workspace the member is already in, so
  // the header, the navigation and the sign-out control survive the refusal.
  const ctx = await pageCtx(req, scope);
  const back = { href: '/queue', label: 'Back to the queue', primary: true };
  const refuse = (status: number, cause: string, detail: string, opts: { heading?: string; title?: string } = {}) =>
    res.status(status).type('html').send(errorPage(status, cause, detail, {
      ...opts, active: '/queue', ctx, actions: [back],
    }));

  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    // The field names are the form's own, not the validator's message: a zod issue
    // string is internal text and does not belong on the page.
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? 'form')))]
      .filter((f) => f !== 'csrf');
    return refuse(400, 'That review could not be read',
      (fields.length
        ? `Check these fields and submit again: ${fields.join(', ')}.`
        : 'Open the queue again and resubmit the review.')
      + ' Nothing was confirmed and nothing was written.',
      { heading: 'That review could not be submitted', title: 'Check the form' });
  }
  const { draftId, decision, title, outcome, owner, due } = parsed.data;

  const me = await scope.member(s.memberId);
  if (!me || me.status !== 'active') {
    return refuse(403, 'Your membership is not active in this workspace',
      'Nothing was confirmed. Ask a workspace owner or admin to reactivate your account, then review the draft again.',
      { heading: 'That action was refused', title: 'Not an active member' });
  }
  if (me.role === 'viewer') {
    await scope.audit('draft.confirm_denied', 'denied', { member_id: me.id, draft_id: draftId },
                      { actorType: 'member', actorId: me.id, objectType: 'draft', objectId: draftId });
    return refuse(403, 'Your role cannot confirm work',
      'A viewer can read the queue but cannot confirm or reject a draft. Ask an owner or admin to review this one, or to change your role.',
      { heading: 'That action was refused', title: 'Read-only role' });
  }

  const d = await scope.draft(draftId);
  if (!d) {
    return refuse(404, 'That draft is no longer in the queue',
      'It may have been reviewed by someone else, or it may have expired unconfirmed. Nothing was written.',
      { heading: 'That draft is not here', title: 'Draft not found' });
  }

  // A human may type any date they like, but it is still checked against the message
  // rather than trusted, exactly as the model's suggestion was.
  const dueClean = due ? sanitizeDueDate((await scope.messageById(d.sourceMessageId))?.body ?? '', due) ?? due : null;

  const nextTitle = title ?? d.title;
  const nextOutcome = outcome ?? d.outcome;
  const nextOwner = owner ? owner : null;
  const edited = decision === 'confirm' &&
    (nextTitle !== d.title || nextOutcome !== d.outcome ||
     nextOwner !== (d.suggestedOwner || null) || dueClean !== (d.suggestedDueDate || null));

  const kind = decision === 'reject' ? 'rejected' : edited ? 'confirmed_with_edits' : 'confirmed';
  const r = await scope.confirm(draftId, kind, me.id, {
    title: nextTitle, outcome: nextOutcome, suggestedOwner: nextOwner, suggestedDueDate: dueClean,
  });
  if (!r.ok) {
    const [cause, detail] = CONFLICT[r.reason] ?? [
      'This draft could not be reviewed now',
      'Its state changed while the form was open, so nothing was written. Open the queue to see what is still waiting.',
    ];
    return refuse(409, cause, detail, { heading: 'Someone got there first', title: 'Already decided' });
  }

  const msg = (r as any).replayed ? 'Already confirmed. Nothing was written twice.'
    : kind === 'rejected' ? 'Rejected. Nothing was written.'
    : kind === 'confirmed_with_edits' ? 'Confirmed with your edits. Task queued.'
    : 'Confirmed. Task queued.';
  return res.redirect(303, '/queue?msg=' + encodeURIComponent(msg));
}
