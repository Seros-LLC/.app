import type { Request, Response } from 'express';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { page, esc } from '../views';
import { pageCtx } from './queue';

import { csrfToken } from '../auth';

const SAMPLES = [
  "I'll send the revised deck to Priya by Thursday.",
  'Can someone look at the staging build?',
  "We'll ship the billing fix before the demo on Friday.",
  'Nice work on the release everyone.',
];

export async function demoPage(req: Request, res: Response) {
  const token = csrfToken(req.serosSession!);
  const body = `<h1>Post a message</h1>
  <p class="sub">Stands in for Slack. Whatever you type goes through the same pipeline: ingest, detect, draft, queue.</p>
  <form class="card" method="post" action="/demo">
    <input type="hidden" name="csrf" value="${esc(token)}">
    <label for="text">Message</label>
    <input id="text" type="text" name="text" size="60" value="${esc(SAMPLES[0])}">
    <div class="grid">
      <div><label for="user">From</label><input id="user" type="text" name="user" value="u-ana"></div>
      <div><label for="channel">Channel</label><input id="channel" type="text" name="channel" value="C-general"></div>
    </div>
    <div class="row"><button class="primary" type="submit">Send</button></div>
  </form>
  <div class="card"><p class="meta">Try one of these</p>
    <ul>${SAMPLES.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
  res.type('html').send(page('Demo', '/demo', body,
    await pageCtx(req, await WorkspaceScope.open(openDb(), req.serosSession!.workspaceId))));
}

export async function demoPost(req: Request, res: Response) {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.redirect(303, '/demo');
  const db = openDb();
  const scope = await WorkspaceScope.open(db, req.serosSession!.workspaceId);
  const { row, created } = await scope.ingestMessage({
    channelId: String(req.body?.channel || 'C-general'),
    ts: String(Date.now() / 1000),
    authorId: String(req.body?.user || 'u-ana'),
    body: text,
  });
  if (created) await scope.enqueue('detect', { messageId: row.id });
  return res.redirect(303, '/queue?msg=' + encodeURIComponent('Message ingested. The worker will draft it shortly.'));
}
