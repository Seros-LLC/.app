# Seros app — defect review

Reviewed: `/home/user/seros-app` @ 2026-08-18, against
`/home/user/seros/product/docs/IMPLEMENTATION-BRIEF.md` and ADR 0002.
Baseline: `npm test` = 25/25 pass, `npm run typecheck` = clean, `SEROS_PROVIDER=fake npm run eval`
= precision 80.0% / recall 100.0% on 20 examples. **All 25 tests passing is not evidence the
promises hold; every critical finding below is reproduced against the code as it stands.**

Nothing in `src/` was modified. Every reproduction ran against scratch databases under `/tmp/rev`
and a scratch server on port 3999, so the repo database was not touched.

**Snapshot note.** Another agent is editing `src/` concurrently. Line numbers below are against the
tree as of the final pass (`src/db/schema.ts` and `src/worker.ts` were changed mid-review; see M8).
Every reproduction in this document was run against the code as it stood, and re-checked against the
current files.

Severity counts: 5 critical, 7 high, 14 medium, 9 low.

---

## Summary of the promise failures

| Promise | Status |
|---|---|
| 1. No write without a recorded human Confirmation | **Broken twice.** Anyone on the network confirms as `u-demo` with no login (C1). The DB does not enforce the confirmation link at all: `tasks.confirmation_id` has no foreign key, so an orphan task inserts cleanly (C5). |
| 1b. Never write twice for one confirmation | **Broken.** Two workers double-fired 8 of 150 confirmed writes (C2). |
| 2. No customer content in logs, ever | Mostly held in the app (ids and lengths only), but the eval harness prints message text to stdout (M14) and unhandled body-parser/route errors return stack traces to unauthenticated clients (M1). |
| 3. Every model call metered | **Broken.** A total provider outage is metered as `outcome='ok'` (H2); meter rows are written by the caller, not the provider, and are skipped entirely on the `InvalidOutput` throw path (H3). No tokens, no cost, no budget check before the call. |
| 4. Tenancy enforced structurally | **Partly convention.** `WorkspaceScope` is good, but route and worker code queries tables directly around it (M5), an unauthenticated webhook creates arbitrary tenants (C3/M3), and the brief's build-failing static check does not exist. |
| 5. Degrade toward doing nothing | **Broken.** On provider failure the system invents a draft with a regex and presents it to the confirmer as a model suggestion (H2); on a DB hiccup the worker dies silently and confirmed writes never happen (H1). |

---

# CRITICAL

## C1 — There is no authentication anywhere; anyone can confirm, and any website can confirm for you
`src/routes/confirm.ts:5-6,13-14,23`, `src/routes/queue.ts:8-9,13-14`, `src/server.ts:27-32`

The confirmer is a process env var (`SEROS_MEMBER || 'u-demo'`), and the route *creates* that member
itself (`scope.addMember(ME(), 'Demo Confirmer', 'confirmer')`) on every request. There is no session,
no cookie, no CSRF token, no `Origin` check. `POST /confirm` therefore takes an unauthenticated
request, writes a `Confirmation` attributed to a person who never acted, queues a `Task`, and lets the
caller choose the title, owner and due date.

**Why it matters.** This is the whole product. ADR 0002 §3 requires "a real, authenticated person in
the workspace" and invariant 11 requires "an authenticated human session". Right now the confirmation
record is evidence of nothing: it names `u-demo`, a row the server manufactured. In a dispute about a
task that caused harm, the company would be producing an audit trail it wrote for itself. And because
the form is a plain `POST` with no token, **any web page a real user visits can silently confirm every
draft in the queue** (a self-submitting cross-origin form); the attacker does not even need network
access to the box if a confirmer's browser has it.

**Proof** — cross-origin POST from `https://evil.example`, no credentials of any kind:

```
$ curl/requests POST http://127.0.0.1:3999/confirm  (Origin: https://evil.example)
   draftId=<demo draft>&decision=confirm&title=Wire funds to attacker account&owner=u-cfo
303 /queue?msg=Confirmed%20with%20your%20edits.%20Task%20queued.

tasks:         [('demo','eec16ad1-…','6694a346-…','queued','6694a346-…')]
confirmations: [('demo','6694a346-…','2bcd0490-…','u-demo','confirmed_with_edits','web')]
draft now:     [('Wire funds to attacker account','done','u-cfo','confirmed')]
members:       [('demo','u-demo','Demo Confirmer','confirmer','active')]
```

**How bad:** as bad as it gets for this product. It is a full authorisation bypass on the one control
the company sells, reachable by anyone who can reach the port, and drive-by exploitable through a
confirmer's browser. It must not be exposed on any network, internal or not, until fixed.

**Smallest correct fix:** put a session middleware in front of `/queue`, `/confirm`, `/tasks`, `/audit`
(signed, `HttpOnly`, `SameSite=Lax` cookie; email-link login is already the v0 plan); take
`workspaceId` and `memberId` **from the session only**, delete `WS()`/`ME()` and both `addMember`
calls from the request path; add a per-session CSRF token to the confirm form and verify it on POST.
Ten lines of middleware plus one hidden input.

## C2 — Two workers double-fire the write queue: duplicate tasks in the customer's tracker
`src/db/system.ts:9-17` (`claimNextJob`), `src/worker.ts:70-77` (`handleTrackerWrite`)

`claimNextJob` is `SELECT … WHERE status='queued'` followed by a **separate** `UPDATE … SET
status='running'`. Nothing serialises the two statements, so two workers routinely select the same
row before either updates it. `handleTrackerWrite` repeats the pattern: it reads the task, checks
`writeState === 'created'`, then updates — a read-check-write with no transaction and no conditional
predicate.

**Why it matters.** §34: "A duplicate task is a trust incident." The `write` queue is the one queue
that "must never double-fire". The unique index protects the *row*; it does not protect the *side
effect*, and in production the side effect is an issue created in someone else's tracker plus a reply
posted into their Slack thread.

**Proof (a)** — two claim loops, 3000 jobs:

```
worker A claimed: 2398  worker B claimed: 2234
jobs claimed by BOTH workers (double-fire): 1632
003a9851-b626-447a-b9a0-90cea32ec674
003e7850-b5dd-451e-9594-58ae7ab24bc6
```

**Proof (b)** — end to end, 150 confirmed drafts, two real `npm run worker` processes:

```
total tracker writes emitted: 158
distinct task ids:            150
tasks written MORE THAN ONCE: 8
task.created audit rows: 158
distinct tasks: 150
```

Eight customers' trackers get two issues for one confirmation, and the audit log claims 158 writes
for 150 tasks.

**Smallest correct fix:** make the claim one atomic statement —
`UPDATE jobs SET status='running', attempts=attempts+1 WHERE workspace_id=? AND id=(SELECT id FROM
jobs WHERE status='queued' AND run_at<=? AND queue IN (…) ORDER BY run_at LIMIT 1) RETURNING *` —
and make the write itself conditional: `UPDATE tasks SET write_state='created' WHERE … AND
write_state='queued'`, then perform the external write only when `result.changes === 1`.

## C3 — The webhook signing secret has a hard-coded default; forged events are accepted and create tenants
`src/routes/webhook.ts:6`, `src/db/scope.ts:28-34`, `src/routes/webhook.ts:38,47`

`const secret = () => process.env.SEROS_SIGNING_SECRET || 'dev-signing-secret'`. If the env var is
missing in production the app does not fail — it silently accepts anything signed with a secret that
is published in this repository. The workspace is then taken from the attacker-supplied `team_id` and
passed to `WorkspaceScope.ensure`, which **creates the tenant**.

**Why it matters.** Invariant 35 says an unverified request is dropped without processing. A missing
env var is a normal deploy accident, and here it converts to: arbitrary content injected into any
workspace id, arbitrary tenants created, arbitrary model spend, and drafts placed in front of a human
confirmer who has no way to tell them from real Slack traffic (combine with C1 and it is a straight
line to a task in the customer's tracker).

**Proof** — server started with `SEROS_SIGNING_SECRET` unset; signature computed with the default
string taken from source:

```
0 200 {"ok":true,"messageId":"f7ea9080-…","deduped":false}
1 200 {"ok":true,"messageId":"04a9957a-…","deduped":false}
2 200 {"ok":true,"messageId":"fe29e133-…","deduped":false}
source_messages: [('T-victim-corp','C-exec','1787106179.857','u-attacker',"I'll wire the payment to the new account"), … x3]
workspaces: [('T-victim-corp',)]
jobs: [('detect','queued',3)]
```

**Smallest correct fix:** `const s = process.env.SEROS_SIGNING_SECRET; if (!s) throw new Error('SEROS_SIGNING_SECRET is required');`
at module load (fail the boot, not the request), and resolve the workspace from a *stored connection*
keyed by `team_id` — `WorkspaceScope.open`, never `ensure`, on this path.

## C4 — The bytes that are verified are not the bytes that are processed
`src/server.ts:16-17`, `src/routes/webhook.ts:28-29,34-42`

`rawBody` is captured by the `verify` hook of `express.json()`, which only runs for
`Content-Type: application/json`. `express.urlencoded()` is mounted next and will happily parse a form
body. Send the request as `application/x-www-form-urlencoded` and `rawBody` is `''`: the HMAC is
verified **over the empty string**, while `req.body` carries fully attacker-controlled parsed content
that was never signed.

**Why it matters.** This is the classic signed-body/parsed-body split. The verification proves a fact
about bytes nobody processed. Today an attacker still needs a signature over `""`, which the default
secret of C3 hands them for free; independently it is a broken verification design that will bite the
moment any other body parser, proxy, charset or `verify` short-circuit is introduced.

**Proof** — HMAC computed over `''`, body sent as a form:

```
POST /api/slack/events  Content-Type: application/x-www-form-urlencoded
x-slack-signature: v0=<hmac over "">     body: team_id=T-mismatch&text=unsigned+body+accepted&channel=C-x&user=u-x
200 {"ok":true,"messageId":"35685a42-…","deduped":false}
source_messages: [('T-mismatch','C-x','u-x','unsigned body accepted')]
```

**Smallest correct fix:** mount `express.raw({ type: '*/*', limit: '128kb' })` on
`/api/slack/events` only, verify the HMAC over that exact `Buffer`, then `JSON.parse` the same buffer
inside the handler; reject any content type that is not `application/json`. Do not let a general body
parser run before the signature check.

## C5 — The confirmation link is not enforced by the schema: orphan tasks and non-member confirmers insert cleanly
`src/db/schema.ts:70-81`, `migrations/0001_initial_schema.sql` (tasks, confirmations), test at `tests/app.test.ts:106-109`

ADR 0002 §2: "a task row without one is a schema violation, not a logic bug". In the migration,
`tasks.confirmation_id` is `TEXT NOT NULL UNIQUE(workspace_id, confirmation_id)` — with **no
`REFERENCES confirmations`**. `confirmations.draft_id` and `confirmations.member_id` likewise have no
foreign keys. `PRAGMA foreign_key_list(tasks)` shows only the `workspaces` reference. So the only
thing standing between the product's central promise and a bad row is application code (and C1 shows
that code is unauthenticated).

The existing invariant test passes because it only inserts `confirmationId: null`, which `NOT NULL`
catches. It never tries a *dangling* id.

**Proof:**

```
declared FKs on tasks:         [(0,0,'workspaces','workspace_id','id',…)]
declared FKs on confirmations: [(0,0,'workspaces','workspace_id','id',…)]
insert into tasks values ('T-role','ghost-task','confirmation-that-does-not-exist','queued','pending','k',0)  -> OK
orphan tasks: (1,)
insert into confirmations values ('T-role','some-draft','conf-sys','confirmed','web','svc-robot-not-a-member',0) -> OK
confirmation by a non-member service actor: [('conf-sys','svc-robot-not-a-member')]
members table has it? (0,)
(pragma foreign_keys = 1 during both inserts)
```

A service account confirming is exactly what ADR 0002 §3 forbids, and the database accepts it.

**Smallest correct fix:** in the migration add
`FOREIGN KEY (workspace_id, confirmation_id) REFERENCES confirmations(workspace_id, id)` to `tasks`,
`FOREIGN KEY (workspace_id, draft_id) REFERENCES drafts(workspace_id, id)` and
`FOREIGN KEY (workspace_id, member_id) REFERENCES members(workspace_id, id)` to `confirmations`
(the parent unique keys already exist), and extend the invariant test to attempt a dangling
`confirmation_id` and expect a throw.

---

# HIGH

## H1 — One database error kills the worker forever; confirmed writes then never happen
`src/worker.ts:84` (`claimNextJob` is outside the `try`), `src/worker.ts:93` (`retryJob` inside the `catch`), `src/worker.ts:108` (`main()` with no `.catch`)

Only the job *body* is protected. Any throw from `claimNextJob`, `finishJob` or `retryJob` escapes
`tick`, rejects the promise returned by `main()`, and Node exits on the unhandled rejection. There is
no supervisor, no `process.on('unhandledRejection')`, no restart.

**Why it matters.** SQLITE_BUSY under two workers, a mid-deploy migration, a locked WAL — any of these
stops the only component that writes to customer systems. Confirmed tasks sit at `write_state='queued'`
indefinitely and nobody is told. It degrades toward doing nothing, which is the right direction, but
*silently*, which is not: invariant 10 requires a retry, a hold **or an alert**.

**Proof** — worker running normally, then a transient DB fault:

```
WORKER PROCESS IS DEAD
exit code: 1
SqliteError: no such table: jobs
    at claimNextJob (/home/user/seros-app/src/db/system.ts:12:35)
    at tick (/home/user/seros-app/src/worker.ts:79:15)
    at main (/home/user/seros-app/src/worker.ts:98:23)
```

**Smallest correct fix:** wrap the whole loop body in `try/catch`, log the error class, sleep with
backoff and continue; add `main().catch(e => { log(e); process.exit(1); })` plus
`process.on('unhandledRejection')`, and run the worker under a supervisor that restarts it.

## H2 — A provider outage is recorded as a successful call and answered with a fabricated draft
`src/provider/index.ts:107-120` (`if (!forceFake) outcome = 'ok'`), `src/worker.ts:35-36,42-43`

When Ollama is unreachable or times out, `complete()` substitutes `fakeComplete()` — a regex over the
message — and then **overwrites the real outcome with `'ok'`**. The worker meters that `'ok'`, builds a
`Draft` from the regex output and puts it in the confirm queue.

**Why it matters.** Two promises at once. Invariant 17: "Every outcome is metered, including
`timeout`, `invalid_output`, `provider_error`" — the meter now lies, so the outage is invisible to
billing, to the reliability metric and to the circuit breaker that ADR 0004 requires. And promise 5:
during a total model outage the product should queue drafting (ADR 0004: "On outage drafting queues"),
not manufacture suggestions of unknown quality and present them to a human as model output. The
`provider` string does say `fake(after:provider_error)`, but no page shows it in a way a confirmer
would read as "this was not the model".

**Proof** — `OLLAMA_HOST=http://127.0.0.1:1` (dead), provider not forced to fake:

```
action_meter: [('detect','ok',1), ('draft','ok',1)]
drafts:       [('pending','fake(after:provider_error)',"I'll ship the migration by Friday")]
audit:        [… ('draft.created','ok','{"draft_id":"e80e8d15-…","confidence":72}')]
```

Zero `provider_error` rows for two failed provider calls.

**Smallest correct fix:** delete line 119 (`if (!forceFake) outcome = 'ok'`), keep
`timeout`/`provider_error` as the metered outcome, and on a real-provider failure **throw** so the job
retries with backoff instead of producing a draft. Keep the deterministic fake for
`SEROS_PROVIDER=fake` only.

## H3 — Metering and budget live outside the provider, so calls can be unmetered and are never budget-checked
`src/provider/index.ts:100-136` (no `workspaceId`, no meter write, no budget check), `src/worker.ts:36,43`, `src/db/scope.ts:43-48`

The provider abstraction does not know which workspace it is spending for, writes no meter row, and
never consults `daily_budget_cents`/`monthly_budget_cents` (both columns exist and are dead). Metering
is a courtesy call the caller makes *after* the fact, so:

* if `complete()` throws `InvalidOutput` (lines 126 and 132) the call happened and **no meter row is
  ever written**; the job then retries and burns more unmetered calls;
* if `handleDetect` throws between the call and `scope.meter`, same;
* the meter row carries no tokens, no cost, no model, no prompt version, no `ref_id`, so cost cannot be
  attributed to a draft (brief 1.10) and the ADR-0004 exit test cannot be run;
* invariant 18's hard stop *before* the network call does not exist anywhere.

**Why it matters.** Promise 3 is "every model call metered" and 15/16 say the meter row is written in
the same transaction boundary as the call, inside the abstraction, which "refuses to run without a
meter context". A model API is the one unbounded cost in the system, exposed here through
unauthenticated ingest with no rate limit (H6).

**Smallest correct fix:** change `complete(req, schema)` to `complete(scope, req, schema)`, check the
workspace budget before `fetch` (writing a `budget_blocked` row and returning), and write the meter row
in a `finally` so every exit path — ok, timeout, provider_error, invalid_output — produces exactly one
row. Then remove the meter calls from `worker.ts`.

## H4 — A `viewer` can confirm and create a task
`src/db/scope.ts:129-131`

`confirm()` checks that the member exists and is `active`. It never looks at `role`, though the column
exists with the full `owner|admin|confirmer|viewer` enum.

**Why it matters.** Brief §32: "Roles … enforced on every workspace-scoped read and write; viewer
cannot confirm", and the testing section names it as required deterministic coverage. A read-only
account can write into the customer's tracker.

**Proof:**

```
viewer confirm result: {"ok":true,"confirmationId":"18f2c726-…","taskId":"80e50b53-…"}
tasks created by a viewer: 1
confirmation member/role: [('u-viewer','viewer')]
```

**Smallest correct fix:** after the status check,
`if (!['owner','admin','confirmer'].includes(member.role)) return { ok:false, reason:'forbidden' };`
plus a test per role.

## H5 — Replay protection is a timestamp window and nothing else, and replays multiply
`src/routes/webhook.ts:7,19,40`

There is no nonce/seen-signature store, so a captured valid request can be resent for the whole window.
Worse, `ts` falls back to the *server's* clock (`String(ev.ts || Date.now()/1000)`), and the ingest
idempotency key is `(workspace, channel, ts)` — so a replay of a Slack event without an `event.ts`
creates a **brand-new** `SourceMessage`, a new detect job, new model spend and a duplicate draft.
`Math.abs()` on line 19 also accepts timestamps 300 s in the future, making the practical window ~10
minutes.

**Proof** — the same signed bytes sent three times produced three messages, three jobs and three
identical drafts:

```
drafts: [('T-victim-corp','3d6e6fab-…','pending',"I'll wire the payment to the new account tomorrow",'u-attacker'),
         ('T-victim-corp','d42a5d7a-…','pending',"I'll wire the payment to the new account tomorrow",'u-attacker'),
         ('T-victim-corp','9a66e0d6-…','pending',"I'll wire the payment to the new account tomorrow",'u-attacker')]
```

**Smallest correct fix:** reject `tsNum > now + 60`; keep a bounded `Map`/table of seen signatures with
a 300 s TTL and reject repeats; require `event.ts` (drop the event if missing) so ingest idempotency
actually keys on the source event.

## H6 — No rate limit, no request quota, no budget on any unauthenticated entry point
`src/server.ts:25-33`, `src/routes/demo.ts:32-45`, `src/routes/webhook.ts:46-51`

Nothing limits how fast anyone can push messages in. Every accepted message enqueues a job, and every
job makes two model calls with no budget check (H3).

**Proof:**

```
150 unauth ingests in 0.3s, statuses: {303}
queued detect jobs now: (151,)
```

**Why it matters.** §35 requires a per-workspace rate limit on webhooks. Without it this is a cost
amplifier (one HTTP request → two model calls) and a queue-flood DoS against the confirm queue: fill it
with junk drafts and the human stops confirming, which the ADR itself names as the failure that kills
accounts.

**Smallest correct fix:** a per-IP and per-workspace token bucket in front of `/api/slack/events`,
`/demo` and `/confirm` (e.g. 60/min/workspace), plus the budget hard stop from H3, plus a queue-depth
cap that holds ingest rather than dropping it.

## H7 — `confirm()` is not a transaction: a TOCTOU check, uncaught constraint errors, and a lost-write window
`src/db/scope.ts:123-167`

Five statements (read draft, read member, read existing confirmation, insert confirmation, update
draft, insert task, insert job) run with no `db.transaction()`. The `already` check on line 133 is a
read used to guard a write, with no serialisation. Under two concurrent confirmers the insert throws
`SQLITE_CONSTRAINT` — and nothing catches it. In the web route that becomes an unhandled exception,
i.e. HTTP 500 with a stack trace (M1) instead of "already confirmed". If a failure lands *after* the
confirmation insert (draft update, task insert, enqueue), the confirmation exists with no task and no
queued write, and no code path ever reconciles it: a human authorised a write that never happens and
nobody is alerted.

**Proof** — two processes confirming the same 200 drafts:

```
{"proc":"B","ok":84,"refused":97,"uncaught_exceptions":19,"lastErr":"UNIQUE constraint failed: confirmations.workspace_id, confirmations.draft_id"}
{"proc":"A","ok":116,"refused":69,"uncaught_exceptions":15,"lastErr":"UNIQUE constraint failed: confirmations.workspace_id, confirmations.draft_id"}
drafts: 200 confirmations: 200 tasks: 200 write jobs: 200
```

The unique index kept the data correct (good), but 34 requests crashed instead of reporting the
already-confirmed state.

**Smallest correct fix:** wrap the body in `this.db.transaction(() => { … })()`, and catch the unique
violation to return the *existing* confirmation — which is also what brief 1.6 requires ("first
confirmation wins, a second returns the same confirmation").

---

# MEDIUM

## M1 — Express's default error handler returns stack traces and absolute paths to unauthenticated clients
`src/server.ts:11-35` (no error middleware, no `NODE_ENV=production` guarantee)

Any body-parser failure (malformed JSON, oversized body) or any throw in a sync route (H7) is rendered
by Express's default handler, which includes `err.stack` outside production.

**Proof** — no signature, no auth, before any route logic:

```
POST /api/slack/events   body: {"event":{"text":"Confidential: Acme will terminate the MSA on Friday"
400
<pre>SyntaxError: Expected ',' or '}' after property value in JSON at position 70 (line 1 column 71)<br>
    at parse (/home/user/seros-app/node_modules/body-parser/lib/types/json.js:91:21)<br> …
```

Filesystem layout, dependency versions and internal call paths leak; some parser errors echo a slice of
the request body, which here is customer message text — the exact thing promise 2 forbids from leaving
the system.

**Fix:** add a terminal error middleware that logs the error *class* with a request id and responds
`{"error":"bad_request","request_id":…}`; set `NODE_ENV=production` in the deploy.

## M2 — Model input is unbounded; the only cap is body-parser's implicit 100 kB default
`src/worker.ts:35,42` (`user: body`), `src/server.ts:16-17` (no explicit `limit`)

ADR 0004 requires max input tokens on every call ("an unbounded call is a bug"). Nothing truncates the
message before it becomes the prompt.

**Proof:** a 200 kB body is rejected (`413`, by accident of the default), but a 90 kB one is stored
whole — `stored body length: (90010,)` — and would be shipped to the model verbatim.

**Fix:** `express.json({ limit: '64kb' })` explicitly, and a hard `maxInputChars`/token budget applied
inside `complete()` before the call.

## M3 — Unbounded tenant and queue growth
`src/db/scope.ts:28-34` (`ensure` creates workspaces), `src/routes/webhook.ts:38,47`, `src/db/system.ts:19-22` (`done`/`dead_letter` rows kept forever)

An unauthenticated request creates a tenant row; finished jobs are never deleted or archived. Both grow
without bound and neither is alerted on.

**Fix:** `open()` (not `ensure()`) on request paths; a maintenance job that deletes `done` jobs past a
retention window and alerts on `dead_letter` depth.

## M4 — A job claimed by a worker that dies is stuck in `running` forever
`src/db/system.ts:9-22`

No lease, no visibility timeout, no reaper. If a worker is killed between claim and finish, a confirmed
task's write is lost silently — the same "hold with no alert" failure as H1, from the other direction.

**Fix:** add `claimed_at`, and requeue `running` jobs older than N minutes in the maintenance loop;
alert when it happens.

## M5 — Tenancy is structural in `WorkspaceScope` only; the rest of the code goes around it
`src/routes/queue.ts:50-58`, `src/worker.ts:44-45`, `src/db/scope.ts:1-6` (the "no raw-db escape hatch" comment)

`tasksPage` builds a three-table join straight from `db` + schema imports; `handleDetect` reads
`members` directly. Both happen to carry a `workspace_id` predicate today, so there is no live leak,
but the guarantee is convention, not construction — and invariant 20 plus the testing strategy's
"static check that fails the build on any tenant-owned query with no workspace predicate" do not exist.

**Fix:** move those two queries onto `WorkspaceScope`, do not export the raw `db` handle to route
modules, and add the lint/static check the brief requires.

## M6 — Confirming with edits destroys the model's suggestion and records no `edited_fields`
**FIXED c46cf9b.** Draft is immutable after drafting; the human's values go to the
`confirmation_edits` sidecar, written in the confirm transaction. Readers coalesce edit over
draft (`writeJob().agreed`, worker, `taskRows`). Covered by `tests/confirmation-edits.test.ts`.
`src/db/scope.ts:143-149`, `src/db/schema.ts:57-68`

Edits are applied with `UPDATE drafts SET title=…, outcome=…` in place, and the `confirmations` table
has no `edited_fields` / `edited_payload` columns. After a confirmation nobody can tell what the model
proposed or what the human changed.

**Why it matters.** Brief 1.6 and invariant 7: edits and rejections are "data, not discards" — the ADR
calls the confirm loop "the product's only compounding data asset". Every edit currently deletes that
asset, and the acceptance-rate and owner-accuracy metrics become uncomputable.

**Fix:** add `edited_fields` (field names only) and `edited_payload` to `confirmations`, write the
final values there, and leave the draft row as the model wrote it.

## M7 — Drafts never expire
`src/db/schema.ts:39-55` (no `expires_at`), `src/db/scope.ts:127`

The brief makes `expires_at` a required column with an `expired` terminal state; the app has the enum
value but no column, no sweeper and no check. A stale draft stays confirmable forever — and with C1,
by anyone.

**Fix:** add `expires_at`, refuse confirmation past it, and expire in the maintenance loop.

## M8 — Retention cannot run: no sweeper at all (the `NOT NULL` half was fixed during this review)
`src/db/schema.ts:30`, `migrations/0001_initial_schema.sql` (`source_messages.body`), `src/worker.ts:29-33`

When I read the code, `source_messages.body` was `TEXT NOT NULL`, so brief 1.3 / invariant 27 ("content
is nulled in place with `content_purged_at` set") was structurally impossible to execute. While this
review was being written another agent made the column nullable and taught `handleDetect` to skip a
purged message, so that half is now fixed. What remains: there is still **no retention sweeper job**,
no `retention.swept` audit event with counts, no alert when a sweep does not run, and
`workspaces.retention_content_days` is still read by nothing — so no content is ever deleted and the
published retention promise is unimplemented.

**Fix:** add the sweeper on the maintenance queue (nulls `body` past the per-workspace window, sets
`content_purged_at`, writes `retention.swept` with counts), and alert if it finds rows past their
window or does not run.

## M9 — `tasks.idempotency_key` is not unique
**ALREADY FIXED (finding was stale).** `0004_hardening.sql` created the unique index
`tasks_idempotency_key (workspace_id, idempotency_key)`. Only `schema.ts` failed to declare it,
which would have let drizzle propose a duplicate; declared as of c46cf9b.
`src/db/schema.ts:76`, migration `tasks`

Brief 1.7 requires `idempotency_key text req **unique**`. Only `(workspace_id, confirmation_id)` is
unique. It happens to be derived from the confirmation id today, so the gap is latent — but the
idempotency key is the thing §34 relies on when reconciling an ambiguous tracker failure.

**Fix:** `UNIQUE (workspace_id, idempotency_key)`.

## M10 — `drizzle-orm` is a runtime dependency declared in `devDependencies`
`package.json:19-25`

`src/db/*.ts` imports `drizzle-orm` at module load, but it is listed under `devDependencies`
(`dependencies: ['better-sqlite3','express','nodemon','tsx','typescript','zod']`). A standard
production install (`npm ci --omit=dev`) yields an app that cannot start. `nodemon`, `tsx` and
`typescript` are conversely shipped as production dependencies.

**Fix:** move `drizzle-orm` to `dependencies`; move `nodemon`/`typescript` to dev.

## M11 — The audit log is append-only by assertion only, and is missing the fields the brief mandates
`src/db/schema.ts:83-90`, `src/routes/queue.ts:78`

Nothing prevents `UPDATE`/`DELETE` on `audit_events` (the page even claims "Append-only"), and the
table has no `actor_type`, `actor_id`, `object_type`, `object_id` or `request_id`, so log entries
cannot be correlated to requests (invariant 12) and "who did this" cannot be answered for a system
actor vs a member.

**Fix:** add the columns; add SQLite `BEFORE UPDATE`/`BEFORE DELETE` triggers that `RAISE(ABORT)`;
keep the writing role separate from any role that can drop them.

## M12 — CSP has no `frame-ancestors`, and there is no `X-Frame-Options`
`src/server.ts:19`

The confirm queue can be framed. Once C1 is fixed and confirmations are session-backed, a framed
"Confirm" button is a one-click write into a customer's tracker.

**Fix:** add `frame-ancestors 'none'; object-src 'none'` to the CSP.

## M13 — A non-numeric `SEROS_DETECT_THRESHOLD` silently removes the confidence floor
`src/worker.ts:9,37`

`Number('high') === NaN`, and `confidence < NaN` is always `false`, so every detection passes.

**Proof:** `threshold= NaN   12<t ? false`.

**Why it matters.** Precision is the gating constraint of the product; a typo in an env var turns the
floor off with no error, degrading toward more suggestions rather than fewer.

**Fix:** parse once at startup, validate `Number.isFinite` and the 0-100 range, and throw otherwise.

## M14 — The eval harness prints corpus message text to stdout, and the golden set is far below the required size and lives in this repo
`evals/detection.ts:20,29-30,52`, `evals/golden.json`

Every false positive and false negative is printed verbatim:

```
  FP  Someone will need to send the deck at some point.
  FP  If we ship Friday, I'll be surprised.
```

The fixtures are synthetic today, so nothing is leaking yet — but this is the code path that will run
against the consented corpus, and its output goes to CI logs. The brief also requires ≥200 labelled
messages across ≥20 threads (there are **20** examples, 8 positive), a separate restricted repository
for the corpus, provenance/consent per entry, and a recorded append-only evaluation log. None exist,
so "no prompt reaches production without an offline evaluation run" cannot be honoured and the
"baseline may not fall" gate has no baseline worth the name.

**Fix:** print ids/hashes instead of text (or gate text behind an explicit local-only flag), move the
corpus to a separate private repo referenced by version, and grow it to the specified size before the
first customer.

---

# LOW

**L1 — Second confirmation returns 409 instead of the existing confirmation.** `src/db/scope.ts:133-135`,
`src/routes/confirm.ts:27`. Brief 1.6 requires idempotency on `(draft_id, member_id)`: "a second
returns the same confirmation". A double-click currently shows an error page. Fix: return the existing
confirmation when the member matches.

**L2 — No input validation on the confirm form.** `src/routes/confirm.ts:9,22`. Anything that is not
the string `reject` is treated as a confirm (`decision=banana` confirms), and `title`/`owner`/`due`
are unvalidated free text (a due date is never re-checked with `sanitizeDueDate` on the human path).
Fix: parse the body with the `zod` already in the dependency tree.

**L3 — `rawBody` is a UTF-8 re-encoding, not the received bytes.** `src/server.ts:16`. Non-UTF-8 input
is lossily converted before the HMAC, so a legitimate request can fail verification and two different
byte strings can verify identically. Fix: keep the `Buffer` and HMAC the buffer (see C4).

**L4 — Future-dated timestamps accepted.** `src/routes/webhook.ts:19` uses `Math.abs`, doubling the
replay window to ~10 minutes. Fix: allow at most ~60 s of forward skew.

**L5 — `surface` is hard-coded to `'web'`.** `src/db/scope.ts:140`. The `slack_action` surface, which
ADR 0002 calls out as a second implementation of the same authorisation check, does not exist; the
column cannot distinguish surfaces today.

**L6 — The provider response is read unbounded, with none of ADR 0004's failure machinery.**
`src/provider/index.ts:56,64`. `num_predict` caps tokens but `await r.json()` will buffer whatever a
misbehaving or hostile Ollama host returns; there is no "retry once with a stricter instruction", no
dead-letter on repeated invalid output, no circuit breaker, no jitter. Fix: cap the response body
size, and implement the documented retry/dead-letter/breaker at the abstraction.

**L7 — `evals/detection.ts:55` calls `main()` with no `.catch`,** so an eval failure is an unhandled
rejection.

**L8 — Prompt versions are inline string constants.** `src/worker.ts:11-23`. ADR 0004 requires prompts
as versioned artefacts loaded from files, with the version recorded on every `Candidate`, `Draft` and
`ActionMeter` row; `prompt_version` exists in neither the schema nor the code, so no suggestion can be
traced to the prompt that produced it and rollback-by-flag is impossible.

**L9 — Pipeline entities are collapsed.** There is no `Candidate` table and no `suppressed_reason`
usage, so threshold/abstention/dedupe data (brief §3 stages 5 and 8) is not recorded; identical
messages produce duplicate drafts with no `duplicate_draft` suppression (visible in the H5 proof).

---

# Checked and found clean

**HTML injection / XSS — no live defect.** `esc()` (`src/views.ts:2-3`) escapes `& < > " '` correctly
and is applied to every dynamic interpolation in `src/views.ts`, `src/routes/queue.ts` and
`src/routes/demo.ts`. I enumerated every `${…}` in those files; the unescaped ones are literal
constants, integers or the `page()` body slot. Injected payload test:

```
posted: I'll fix "><script>alert(document.domain)</script><img src=x onerror=alert(1)> tomorrow.
rendered: value="I&#39;ll fix &quot;&gt;&lt;script&gt;alert(document"
raw <script> present in /queue: False       flash reflected raw (?msg=): False
audit page raw script: False                tasks page raw script: False
```

Two residual footguns worth fixing cheaply: `page(title, active, body)` takes `body` as raw HTML with
no branded-string type, so a future caller can pass unescaped data; and `src/routes/queue.ts:81`
interpolates `${r.id}` unescaped — safe only because the column is `INTEGER`.

**SQL injection — none.** Every query goes through Drizzle's parameter binding; there is no string
concatenation into SQL anywhere in `src/`, and the migration is a static file.

**HMAC comparison — correct in the parts that are done.** `crypto.timingSafeEqual` is used on equal
length buffers, with the length check first (`src/routes/webhook.ts:20-23`); both are fixed-length hex
so the early return leaks nothing useful. The timestamp check runs before the HMAC, which is fine.
The defects around it are C3, C4, H5 and L3-L4, not the comparison itself.

**No path creates a `Task` without a `Confirmation` row in application code.** `insert(tasks)` appears
exactly once (`src/db/scope.ts:160`), inside `confirm()`, after the confirmation insert; `grep -rn
"insert(tasks)\|insert(confirmations)" src/` returns only `src/db/scope.ts:138` and `:160`. The
single-choke-point shape is right. What is missing is that the *authorisation* in front of it is
absent (C1), the *database* does not enforce the link (C5), and the *side effect* behind it can fire
twice (C2).

---

# Fix order

1. **C1** — put authentication and CSRF in front of `/confirm` before this is exposed anywhere.
2. **C2** — atomic job claim and conditional write update; duplicate tracker writes are the trust incident the ADR is built to prevent.
3. **C3 / C4** — fail boot without a signing secret; verify the raw bytes you actually parse.
4. **C5 / H4** — real foreign keys and a role check, so the invariant is enforced by construction rather than by the code path that is currently unauthenticated.
5. **H1 / H7** — worker supervision and a transaction around `confirm()`.
6. **H2 / H3** — honest metering, budget before the call, and no fabricated drafts on outage.
7. **H5 / H6 / M1-M4** — replay store, rate limits, error handler, job leases.

Add the deterministic tests the brief already names and that would have caught most of this: a task
insert with a dangling `confirmation_id` expected to fail; a viewer expected to be refused; two
concurrent workers expected to produce exactly one write per confirmation; a provider failure expected
to produce a `provider_error` meter row and **no** draft; an unauthenticated `POST /confirm` expected
to be rejected.
