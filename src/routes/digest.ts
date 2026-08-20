/**
 * GET /digest.
 *
 * The end of the day, for one workspace: what was confirmed, what is still
 * waiting, what expired. Every number on this page is computed in code from rows
 * retrieved through WorkspaceScope. The model writes two sentences of prose and
 * nothing else, and if it states a number those sentences are dropped
 * (src/ai/digest.ts) - the page then shows the numbers alone, which is the part
 * that has to be right.
 *
 * Reads only. No draft, no confirmation, no task is created here.
 */
import type { Request, Response } from 'express';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { page, esc } from '../views';
import { digest } from '../ai/digest';
import type { DigestResult } from '../ai/digest';
import { capNote, retrieve } from '../ai/retrieve';
import type { Retrieved, WorkRow } from '../ai/retrieve';

const WHY_TEXT: Record<string, string> = {
  no_data: 'Nothing has been drafted or confirmed in this workspace yet, so no summary was written and no model was called.',
  provider_unavailable: 'The model did not answer. The numbers below are unaffected: they are counted in code.',
  invalid_output: 'The model answered in a shape this page will not trust. The numbers below are unaffected.',
  budget_blocked: 'This workspace is at its spending cap, so no summary was requested. The numbers below are unaffected.',
  numbers_in_prose: 'The summary tried to state its own counts, so it was dropped. The numbers below are the counted ones.',
};

function bucketTable(rows: WorkRow[], heading: string, empty: string): string {
  return `<h3>${esc(heading)}</h3>
  ${rows.length === 0 ? `<p class="sub">${esc(empty)}</p>` : `<table>
    <tr><th>What</th><th>Owner</th><th>Due</th><th>When</th></tr>
    ${rows.map((r) => `<tr>
      <td>${esc(r.title)}</td>
      <td>${esc(r.owner ?? '—')}</td>
      <td>${esc(r.due ?? '—')}${r.overdue ? ' <span class="pill">overdue</span>' : ''}</td>
      <td class="meta">${esc(new Date(r.at).toISOString().slice(0, 10))}${
        r.actor ? ` &middot; ${esc(r.actor)}` : ''}</td>
    </tr>`).join('')}
  </table>`}`;
}

function counters(r: Retrieved): string {
  const cell = (n: number, label: string) =>
    `<div class="card"><h3>${n}</h3><p class="meta">${esc(label)}</p></div>`;
  return `<div class="grid">
    ${cell(r.counts.confirmedToday, 'confirmed today')}
    ${cell(r.counts.waiting, 'still waiting for a human')}
    ${cell(r.counts.expired, r.expiredAvailable ? 'expired unconfirmed' : 'expired unconfirmed (not yet readable)')}
    ${cell(r.counts.overdue, 'past their due date')}
  </div>`;
}

export function renderDigest(d: DigestResult): string {
  const r = d.retrieved;
  const waiting = r.rows.filter((x) => x.bucket === 'waiting');
  const confirmed = r.rows.filter((x) => x.bucket === 'confirmed');
  const expired = r.rows.filter((x) => x.bucket === 'expired');

  return `<h1>${esc(r.today)}</h1>
  <p class="sub">End of day for this workspace. The counts are computed from the rows; only the
  prose is written by a model, and it is not allowed to state a number.</p>
  ${counters(r)}
  ${d.prose
    ? `<div class="card">
        <h3>${esc(d.prose.headline)}</h3>
        <p>${esc(d.prose.summary)}</p>
        <p class="meta">Written from ${r.rows.length} retrieved row${r.rows.length === 1 ? '' : 's'}${
          d.servedFromCache ? ', served from the summary already written for these counts' : ''}.</p>
      </div>`
    : `<div class="card">
        <h3>No summary this time</h3>
        <p class="sub">${esc(WHY_TEXT[d.why ?? 'provider_unavailable'] ?? 'No summary was written. The numbers below are unaffected.')}</p>
      </div>`}
  <div class="card">
    ${bucketTable(confirmed, 'Confirmed', 'Nothing has been confirmed.')}
  </div>
  <div class="card">
    ${bucketTable(waiting, 'Still waiting', 'Nothing is waiting for a human.')}
  </div>
  <div class="card">
    ${bucketTable(expired, 'Expired unconfirmed', r.expiredAvailable
      ? 'Nothing expired.'
      : 'Expired drafts are not readable through the scope yet, so this is empty rather than wrong.')}
  </div>
  <p class="meta">${esc(capNote(r))}</p>`;
}

export async function digestPage(req: Request, res: Response) {
  const db = openDb();
  const scope = await WorkspaceScope.open(db, req.session!.workspaceId);
  let result: DigestResult;
  try {
    result = await digest(db, scope);
  } catch (e: any) {
    console.error(JSON.stringify({
      level: 'error', event: 'digest.failed', error_class: e?.constructor?.name ?? 'Error',
    }));
    result = {
      retrieved: await retrieve(scope), prose: null, why: 'provider_unavailable',
      meterId: null, modelCalled: false, servedFromCache: false,
    };
  }
  res.type('html').send(page('Digest', '/digest', renderDigest(result)));
}
