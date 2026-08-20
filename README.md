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

The audit log is **append-only in the database**, not by convention: triggers
`RAISE(ABORT)` on any UPDATE or DELETE, including inside a transaction, and a CHECK
constraint refuses a `detail` payload containing a content-shaped key. So the log holds
even when the application code is wrong, which is the only condition under which an
audit log is worth having. Each row carries an actor and actor kind, the object acted
on, a request id generated by the database, and a monotonic id.

## Limits

| Guard | Default | Env |
|---|---|---|
| pending drafts per workspace | 5,000 | `SEROS_MAX_PENDING_DRAFTS` |
| queued jobs per workspace | 10,000 | `SEROS_MAX_QUEUED_JOBS` |
| unconfirmed draft lifetime | 14 days, then `expired` | `SEROS_DRAFT_TTL_DAYS` |
| orphaned job lease | 120s, then requeued | `SEROS_JOB_LEASE_MS` |
| model spend | daily and monthly, 0 = unlimited | per workspace |

A tenant at a cap is refused loudly with a 429 and an audited `denied`, never silently
dropped. An expired draft can never become a confirmed one: expiry only moves
`pending -> expired`, and `confirm()` refuses anything that is not pending.

## Deploying to Vercel

The whole app ships as **one serverless function**. `api/index.ts` wraps the same
express app used locally, and `vercel.json` rewrites `/(.*)` to `/api/index`, so every
route — pages, webhook, cron — lands in that single handler. There is no separate build
output; `build:vercel` only creates an empty `public/` for the static directory.

Required production environment variables:

| Variable | What it is |
|---|---|
| `DATABASE_URL` | pooled Postgres connection string; its presence is what selects Postgres |
| `DATABASE_URL_UNPOOLED` | direct connection, used for migrations and anything a pooler cannot carry |
| `SEROS_SESSION_SECRET` | signs session cookies |
| `SEROS_SIGNING_SECRET` | signs webhook and internal payloads |
| `CRON_SECRET` | the value Vercel Cron presents to `/api/cron/drain`; requests without it are refused |

**Migrations run on cold start.** The function applies `.seros/migrations/*.sql` in
order before serving, exactly as `npm run migrate` does, and the migrations are
idempotent — a warm instance, a second region or a concurrent boot re-applies nothing.

**Getting a login.** There is no member list and no session without a credential, so
create one deliberately:

```bash
npm run seed                      # demo workspace + members, prints the passwords once
npm run set-password -- <memberId>  # set or reset one member's password
```

Run these against the deployed database by pointing `DATABASE_URL` at it.

**Local dev uses SQLite, production uses Postgres**, and `DATABASE_URL` is the switch:
unset, the app opens `.seros/seros.db`; set, it connects to Postgres. The schema is the
same either way, which is why the local suite is evidence about production.

## Not done yet

* **Sign-in is a real password now** — the hole this section used to describe is closed.
  `/login` takes an email address or a member id **and a password**; there is no member
  list on the page and no path that issues a session without verifying a credential.
  Passwords are stored as `scrypt$N$r$p$<salt>$<hash>` (`node:crypto` only, per-user salt,
  parameters carried in the record so they can be raised later), compared with
  `crypto.timingSafeEqual`, and an unknown address costs the same time as a wrong
  password and gets the same sentence, so the form cannot be used to enumerate members.
  Five failures lock an account for fifteen minutes (`SEROS_LOGIN_MAX_ATTEMPTS`,
  `SEROS_LOGIN_LOCKOUT_MS`); a lockout answers exactly like any other failure and the
  real reason goes to the audit log. A credential is created by an admin issuing a
  **single-use invite** (`npm run invite -- <memberId>`, or the button on `/members`):
  the raw token is shown once, only its SHA-256 is stored, it expires in 24 hours
  (`SEROS_INVITE_TTL_MS`), and redeeming it at `/set-password` spends it. You change your
  own at `/password`, which requires the current one and rotates your session so every
  other session — including a stolen one — stops working. `npm run seed` creates the demo
  members with generated passwords and prints them once; `npm run set-password` and
  `npm run auth -- unlock|status` are the operator tools. Still missing: invites are
  handed over by the admin rather than emailed, there is no self-service reset for
  someone who has forgotten their password, and there is no second factor or SSO.
* The tracker writer is a local fake; no Slack or Jira/Linear client exists yet, so the
  `slack_action` confirmation surface named in ADR 0002 does not exist either.
* SQLite, single process. The schema is Postgres-shaped and expected to move.
* No vendor model is chosen (ADR 0004 is still open); the chain is local Qwen alone
  until one is, at which point Qwen becomes the fallback behind it.

## Review status

`REVIEW.md` is an adversarial review of this codebase, where every critical finding was
reproduced with a real request rather than described. Current state: **5 of 5 critical,
7 of 7 high and 14 of 14 medium findings closed**, each with a test that fails if the
fix is removed. Of the lows, L1–L4 and L6 are closed; L5 (the `slack_action` surface)
is a feature that does not exist yet rather than a defect.
