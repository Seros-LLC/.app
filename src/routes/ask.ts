/**
 * GET /ask and POST /ask.
 *
 * A member asks a plain-English question about their own workspace's work. The
 * rows are retrieved through WorkspaceScope first and the model answers from those
 * rows or not at all (src/ai/ask.ts). Everything this page can show - the answer,
 * the cited rows, the counts - came out of this workspace.
 *
 * Nothing here writes a draft, a confirmation or a task. The page has no such form
 * and the code has no such call.
 */
import type { Request, Response } from 'express';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { page, esc } from '../views';
import { csrfToken } from '../auth';
import { ask } from '../ai/ask';
import type { AskResult } from '../ai/ask';
import { capNote, QUESTION_MAX_CHARS, retrieve } from '../ai/retrieve';
import type { Retrieved, WorkRow } from '../ai/retrieve';

const SAMPLES = [
  'What did I commit to this week?',
  'What is overdue?',
  'What is Bo waiting on?',
  'What expired without anyone confirming it?',
];

const bucketLabel = (b: WorkRow['bucket']) =>
  b === 'waiting' ? 'awaiting confirmation' : b === 'expired' ? 'expired' : 'confirmed';

function rowsTable(rows: WorkRow[], caption: string): string {
  if (rows.length === 0) return '';
  return `<p class="meta">${esc(caption)}</p>
  <table>
    <tr><th>What</th><th>Owner</th><th>Due</th><th>State</th></tr>
    ${rows.map((r) => `<tr>
      <td>${esc(r.title)}</td>
      <td>${esc(r.owner ?? '—')}</td>
      <td>${esc(r.due ?? '—')}${r.overdue ? ' <span class="pill">overdue</span>' : ''}</td>
      <td><span class="pill${r.bucket === 'confirmed' ? ' ok' : ''}">${esc(bucketLabel(r.bucket))}</span></td>
    </tr>`).join('')}
  </table>`;
}

const countsLine = (r: Retrieved) =>
  `<p class="meta">Retrieved from this workspace: ${r.counts.waiting} waiting, `
  + `${r.counts.confirmed} confirmed, ${r.counts.expired} expired, ${r.counts.overdue} overdue. `
  + `Counts are computed from the rows, never by the model.</p>`;

function form(token: string, question: string): string {
  return `<form class="card" method="post" action="/ask">
    <input type="hidden" name="csrf" value="${esc(token)}">
    <label for="q">Ask about this workspace</label>
    <input id="q" type="text" name="question" size="60" maxlength="${QUESTION_MAX_CHARS}"
           value="${esc(question)}" placeholder="${esc(SAMPLES[0] ?? '')}">
    <div class="row"><button class="primary" type="submit">Ask</button></div>
  </form>
  <div class="card"><p class="meta">Try one of these</p>
    <ul>${SAMPLES.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
}

const DEGRADE_TEXT: Record<string, string> = {
  provider_unavailable: 'The model did not answer, so here are the rows themselves.',
  invalid_output: 'The model answered in a shape this page will not trust, so here are the rows themselves.',
  budget_blocked: 'This workspace is at its spending cap, so no question was sent. Here are the rows themselves.',
  unknown_citation: 'The answer referred to work that is not in this workspace, so it was discarded whole. Here are the rows themselves.',
};

function render(result: AskResult, token: string): string {
  const r = result.retrieved;
  const head = `<h1>Ask</h1>
  <p class="sub">Answered only from this workspace's own drafts, tasks and members — never from another
  workspace, never from the model's memory. This page reads; it writes nothing.</p>
  ${form(token, result.question)}`;

  if (result.outcome.kind === 'no_question') {
    // What is here to ask about, before anything is asked. No model call is made
    // to render this: it is the retrieved set, printed.
    return `${head}
    <div class="card">
      <h3>What is here to ask about</h3>
      ${countsLine(r)}
      ${r.rows.length === 0
        ? '<div class="empty">Nothing has been drafted or confirmed in this workspace yet.</div>'
        : rowsTable(r.rows, 'Everything a question would be answered from')}
      <p class="meta">${esc(capNote(r))}</p>
    </div>`;
  }

  if (result.outcome.kind === 'no_data') {
    return `${head}
    <div class="card">
      <h3>Nothing to answer from</h3>
      <p class="sub">This workspace has no drafts and no tasks yet, so the question was not sent to a
      model and nothing was spent. Post a message on the <a href="/demo">demo page</a> first.</p>
    </div>`;
  }

  if (result.outcome.kind === 'degraded') {
    const why = result.outcome.why;
    return `${head}
    <div class="card">
      <h3>No answer, but the rows are here</h3>
      <p class="sub">${esc(DEGRADE_TEXT[why] ?? 'No answer was usable, so here are the rows themselves.')}</p>
      ${countsLine(r)}
      ${rowsTable(r.rows, 'Everything retrieved for this question')}
      <p class="meta">${esc(capNote(r))}</p>
    </div>`;
  }

  const { answer, cited, citedMembers } = result.outcome;
  return `${head}
  <div class="card">
    <h3>Answer</h3>
    <p>${esc(answer)}</p>
    ${citedMembers.length ? `<p class="meta">People named: ${citedMembers.map((m) => esc(m.name)).join(', ')}</p>` : ''}
    ${cited.length
      ? rowsTable(cited, 'The rows this answer is built on')
      : '<p class="meta">The answer cites no row: nothing retrieved bore on the question.</p>'}
    ${countsLine(r)}
    <p class="meta">${esc(capNote(r))}</p>
  </div>
  ${cited.length && cited.length < r.rows.length
    ? `<div class="card">${rowsTable(r.rows, 'Everything else that was retrieved')}</div>` : ''}`;
}

export async function askPage(req: Request, res: Response) {
  const s = req.session!;
  const db = openDb();
  const scope = WorkspaceScope.open(db, s.workspaceId);
  const retrieved = await retrieve(scope);
  const result: AskResult = {
    question: '', retrieved, meterId: null, modelCalled: false, outcome: { kind: 'no_question' },
  };
  res.type('html').send(page('Ask', '/ask', render(result, csrfToken(s))));
}

export async function askPost(req: Request, res: Response) {
  const s = req.session!;
  const db = openDb();
  const scope = WorkspaceScope.open(db, s.workspaceId);
  const token = csrfToken(s);
  let result: AskResult;
  try {
    result = await ask(db, scope, (req.body ?? {}).question);
  } catch (e: any) {
    // The model layer meters and swallows its own failures; anything reaching here
    // is ours. Degrade to the plain view rather than a broken page.
    console.error(JSON.stringify({
      level: 'error', event: 'ask.failed', error_class: e?.constructor?.name ?? 'Error',
    }));
    result = {
      question: '', retrieved: await retrieve(scope), meterId: null, modelCalled: false,
      outcome: { kind: 'degraded', why: 'provider_unavailable', providerOutcome: 'provider_error' },
    };
  }
  res.type('html').send(page('Ask', '/ask', render(result, token)));
}
