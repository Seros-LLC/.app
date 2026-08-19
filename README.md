# Seros — application

Turns what a team already said into confirmed, owned, dated tasks.
Ingest a message, detect a commitment, draft a task, **show it to a human**, and only
then write anything anywhere.

> **The rule the whole codebase is built around:** nothing is written to a customer's
> tracker without a recorded human confirmation. A `Task` row can only be created from a
> `Confirmation` id — there is no function in this repository that creates one from a
> draft. See [ADR 0002](../seros/product/docs/adr/0002-human-confirmation-is-mandatory.md).

## Run it

```bash
npm install
npm run migrate          # creates seros.db
npm start                # web app on http://localhost:3000
npm run worker           # background worker, in a second terminal
```

Then open <http://localhost:3000/demo>, post a message, and watch it appear in the
queue. Confirm it and it shows up under Tasks with the confirmation behind it.

| Command | What it does |
|---|---|
| `npm start` | the web app |
| `npm run worker` | detection, drafting and the tracker writer |
| `npm test` | full test suite, offline, no keys |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run eval` | scores detection against the golden set |
| `npm run migrate` | applies `migrations/*.sql`, idempotent |

## The model, and its backup

`src/provider/index.ts` is the only place in the codebase that talks to a model.
One operation, no streaming, no tools, no vendor type escapes the file.

1. **Primary: local Qwen** — `qwen2.5:7b-instruct` on Ollama at `127.0.0.1:11434`.
   Bounded call, `temperature 0`, JSON mode, hard timeout.
2. **Backup: a deterministic fake** — pure code, no network. It runs when Ollama is
   unreachable, when the call times out, when the JSON is malformed, and when the
   response fails its Zod schema. Every test and every CI run uses it.

The app therefore never hangs on a model and never crashes on a bad response; it
degrades to something dumber and keeps a human in the loop.

Measured on the 20-example golden set (`npm run eval`):

| Provider | Precision | Recall | Wall clock |
|---|---|---|---|
| `ollama:qwen2.5:7b-instruct` | **88.9%** | 100% | 21.8s |
| deterministic fake (backup) | 80.0% | 100% | 0.0s |

Precision is the number that matters: a missed commitment costs nothing, a wrong task
in someone's tracker costs trust.

```bash
SEROS_PROVIDER=fake npm run eval                 # force the backup
OLLAMA_HOST=http://127.0.0.1:59999 npm run eval  # prove the fallback works
```

## Guards over the model

A 7b model will happily invent a due date. `src/sanitize.ts` refuses:

* a date is kept **only** if the message actually states one — an ISO date, a numeric
  date, "today"/"tomorrow" that matches, or a named weekday that really is that weekday
  within seven days. Anything else becomes `null` and the human fills it in.
* the owner must map to a real member of the workspace. "Send the deck **to Priya**"
  proposes Priya, who is the recipient, not the person who committed — so it falls back
  to the message author, and the mapping is recorded.

Both behaviours are covered by tests, and dropping a date writes an audit row.

## Layout

```
src/
  server.ts            express app, security headers, routes
  worker.ts            detect -> draft -> queue, and the tracker writer
  sanitize.ts          guards over model output
  views.ts             server-rendered HTML, escaped, no client framework
  provider/index.ts    the whole model boundary
  db/
    schema.ts          drizzle tables
    scope.ts           WorkspaceScope: the only way to touch tenant rows
    system.ts          the single cross-tenant path (the queue poller)
    client.ts          connection + migrations
  routes/              webhook, queue, confirm, demo
migrations/*.sql       idempotent, applied in order
evals/                 golden set + precision/recall scorer
tests/                 node:test, offline
```

## Tenancy

Tenant rows are reachable **only** through `WorkspaceScope`. It cannot be constructed
without an existing workspace, it injects `workspace_id` into every query itself, and it
exposes no raw database handle. Every tenant table carries `workspace_id` in its primary
key, so a row cannot exist outside a workspace and no unique constraint is global.
There is exactly one cross-tenant path — the queue poller in `db/system.ts` — and it
reads identifiers, never content.

## Audit and metering

Every state change writes an `audit_events` row; every model call writes an
`action_meter` row with its outcome (`ok`, `timeout`, `invalid_output`,
`provider_error`, `budget_blocked`). Neither table ever receives message content — only
ids, hashes and counts. Browse them at `/audit`.

## Not done yet

* **No authentication.** Anyone who can reach the app can confirm as the demo member.
  This is a demo-grade hole and must close before anything real touches it.
* The tracker writer is a local fake; no Slack or Jira/Linear client exists yet.
* SQLite, single process. The schema is Postgres-shaped and expected to move.
