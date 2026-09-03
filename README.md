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
npm run migrate          # creates .seros/seros.db
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
| `npm run migrate` | applies `.seros/migrations/*.sql`, idempotent |
| `npm run check:tenancy` | fails if any module reaches past `WorkspaceScope` |
| `npm run verify` | typecheck, tenancy check, and the full suite |

## Deployment

### Vercel

This application is designed to be deployed on Vercel. The configuration includes:

- Serverless functions via `/api/index.ts`
- Automatic migrations on cold start
- Cron job for `/api/cron/drain` (runs daily at 9:00 UTC)
- Security headers and proper HTTPS enforcement
- Connection pooling for Neon Postgres

To deploy:
1. Push to GitHub connected to Vercel, or
2. Run `vercel --prod` with the Vercel CLI

### Local Development with Postgres

To test with Postgres locally:
```bash
# Install Postgres (if needed)
# Create a database and user
export DATABASE_URL="postgresql://user:password@localhost:5432/seros"
export SEROS_DB=""  # empty to force Postgres
npm run migrate
npm start
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | (uses SQLite if not postgres://) |
| `SEROS_DB` | SQLite file path | `.seros/seros.db` |
| `PGPOOL_MAX` | Max Postgres connections | `1` |
| `PGPOOL_IDLE_MS` | Idle connection timeout | `10000` |
| `PGPOOL_CONNECT_MS` | Connection timeout | `10000` |
| `PGSCHEMA` | Postgres schema | `public` |
| `SEROS_SESSION_SECRET` | Session signing key (min 16 chars) | **required** |
| `SEROS_DETECT_THRESHOLD` | Detection confidence threshold (0-100) | `55` |
| `SEROS_TRACKER` | Which tracker receives confirmed tasks: `linear` or `fake` | `fake` |
| `LINEAR_API_KEY` | Linear personal API key, required when `SEROS_TRACKER=linear` | — |
| `LINEAR_TEAM_ID` | Linear team the issues are created in | — |
| `SEROS_TRACKER_TIMEOUT_MS` | Tracker HTTP timeout | `15000` |
| `SEROS_SLACK` | Slack client: `http` (real) or `fake` | `fake` |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Slack app credentials for the install flow | — |
| `SEROS_ENCRYPTION_KEY` | 32 bytes (base64 or hex) sealing stored Slack tokens | **required to connect Slack** |
| `SEROS_PUBLIC_URL` | Public base URL, for the OAuth redirect | request host |

### Connecting Slack, and what "we only read these" means

`/connect` installs the Slack app (owner or admin only) and lists the scopes
verbatim before the redirect. `/channels` is the picker. A channel that is not
ticked is not read: the webhook drops the event **before** `source_messages`,
so an unticked channel leaves no row to delete later. Disconnecting destroys the
stored token and the team no longer resolves to a tenant, so ingestion stops.

The tenant is resolved from the stored connection (`source_connections.team_id`),
never from the event payload. A signed event for a team nobody has connected has
nowhere to go and is refused.

### The tracker write

v0 writes to exactly one tracker. Which one is configuration, not code:
`SEROS_TRACKER=linear` with a key, or `fake` for tests and local work. An
unknown value fails the boot rather than silently writing confirmed tasks into a
tracker nobody can see.

The write is two-phase, and the order is the point. A `task_writes` row is the
claim; the tracker is called; only when it answers with an id does
`tasks.write_state` become `created`. Before this, the task was marked `created`
first, so a failed call left a task that claimed to exist in a tracker it had
never reached and the retry skipped it — a confirmed commitment that silently
never arrived. `tests/tracker-write.test.ts` holds that case open.

## The model, and what catches it when it falls

`src/provider/` is the only place in the codebase that talks to a model, and the only
thing permitted to open a socket to one. One operation, no streaming, no tools, no
vendor type escapes the directory. It refuses to run without a meter context, checks
the budget before the network call, and writes exactly one `action_meter` row on every
terminating path — `ok`, `timeout`, `invalid_output`, `provider_error`,
`budget_blocked`.

**The transport chain** is ordered configuration, `SEROS_PROVIDER_CHAIN`:

| Setting | Meaning |
|---|---|
| `ollama` *(default)* | local Qwen `qwen2.5:7b-instruct`, and nothing behind it |
| `http,ollama` | a hosted provider first, **local Qwen as the backup** when it fails |
| `ollama,fake` | accept a regex-grade answer rather than none — a decision, written down |

A chained call is still one metered row, and the provider string records which link
actually served it: `ollama:qwen2.5:7b-instruct(after:http)`. No vendor has been chosen
yet (ADR 0004 is still open), so today the chain is Qwen alone; the moment a hosted
model goes in front, Qwen becomes exactly what it should be — the thing that keeps the
product working when someone else's API is having an afternoon.

**A failed call invents nothing.** It returns `ok: false, value: null`, the job retries
with backoff, and the human sees no draft rather than a fabricated one. The
deterministic fake is a real transport, but it is only ever reached when it is named on
purpose — `SEROS_PROVIDER=fake` for tests and CI, or written into the chain. Quietly
fabricating an answer and presenting it as a model result was a review finding, not a
feature.

Measured on the 217-example golden set (`npm run eval`), which prints a threshold
sweep so the operating point is chosen from evidence rather than taste:

| Corpus | Provider | Prompt | Precision | Recall | F1 |
|---|---|---|---|---|---|
| 217 | `ollama:qwen2.5:7b-instruct` | detect/v2 | **100.0%** | 95.8% | 97.9% |
| 122 | `ollama:qwen2.5:7b-instruct` | detect/v2 | 100.0% | 89.8% | 94.6% |
| 122 | `ollama:qwen2.5:7b-instruct` | detect/v1 | 81.0% | 95.9% | 87.9% |
| 122 | deterministic fake | — | 80.0% | 65.3% | 71.9% |

Zero false positives across 217 examples, and the sweep is flat from 55 to 85, which
means the operating point is not balanced on a knife edge.

Precision is the number that matters: a missed commitment costs nothing, a wrong task
in someone's tracker costs trust.

**How v2 happened, because it is the argument for keeping the harness.** v1 lost eleven
false positives to a single family — statements about where a person will *be*, what
they will *not* do, and what a *system* will do on its own: "I'll be out Friday", "I
won't be in the office Thursday", "The bot will send reminders". The model rated every
one of them 100, so the sweep showed no threshold could rescue it; precision peaked at
86% and stayed there. The instruction changed instead, and the false positives went to
zero. Prompts are versioned in `src/prompts.ts` and the version is recorded on every
metered call, so a rollback is a flag flip.

The golden set itself was written by the same local Qwen — 197 of its 217 examples,
generated in about a minute of GPU time as synthetic fixtures (the brief requires
fixtures be synthetic), then read and labelled by hand. Three were thrown out: one
"hard negative" that was a real commitment, one that drifted into Chinese, and one too
ambiguous to label honestly. `SEROS_EVAL_SHOW_TEXT=1` prints the misclassified ones;
by default the harness prints counts, because one day it will be pointed at a consented
corpus and printing text should not be the habit it has by then.

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
.seros/
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

Every state change writes an audit row; every model call writes an `action_meter` row
with its outcome (`ok`, `timeout`, `invalid_output`, `provider_error`,
`budget_blocked`). Browse them at `/audit`.

## Development

### Code Quality

This project uses:
- TypeScript for type safety
- Jest-style tests with `tsx --test`

### Linting

There is no linter wired up. A legacy `.eslintrc.cjs` is still in the tree, but
ESLint is not a dependency and that config format is not read by ESLint 9, so
`npm run lint` and `make lint` did not exist / did not work; the commands were
removed rather than left as documentation for something that fails. The gates
that do run are `npm run typecheck`, `npm run check:tenancy` and `npm test`,
all three of which `npm run verify` runs together.

### Type Checking

Run `npm run typecheck` to ensure type safety.

### Testing

Run `npm test` for the full test suite.

### Makefile Convenience Commands

For developers who prefer Make, the following targets are available:
- `make dev` - start the web app in development mode
- `make worker` - start the background worker
- `make test` - run tests
- `make verify` - typecheck + tenancy check + tests
