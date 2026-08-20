/**
 * tests/driver.test.ts - the database the app talks to is chosen by DATABASE_URL.
 *
 * Three things are proved here:
 *   1. the selection rule itself (postgres:// or postgresql:// -> Postgres,
 *      anything else -> the SQLite file, exactly as before);
 *   2. that the SQLite path is UNCHANGED - synchronous migrateDb(), the same
 *      pragmas, the same synchronous .get()/.all()/.run() handle, and the
 *      rewritten (rowid-free) job claim still claiming exactly one job;
 *   3. that migrations/pg/*.sql really parse and apply on a real Postgres,
 *      including the append-only trigger and the RETURNING claim - but only when
 *      TEST_DATABASE_URL points at one. With no Postgres present those tests SKIP
 *      (they do not fail), and every one of them says so in its own name.
 *
 * The Postgres tests apply the real migration files to a throwaway schema and
 * drop it afterwards, so they never touch a production `public` schema. No test
 * name, assertion message or log line here contains the connection string.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.SEROS_PROVIDER = 'fake';
const dir = mkdtempSync(join(tmpdir(), 'seros-driver-'));
process.env.SEROS_DB = join(dir, 'driver.db');
// This file's SQLite assertions must be about the default (no DATABASE_URL) path.
const INHERITED_DATABASE_URL = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

import { sql } from 'drizzle-orm';
import {
  dialect, isPgUrl, openDb, migrateDb, closeDb, migrationFiles, applyPgMigrations, pgClientOptions,
} from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { claimNextJob, claimNextJobAsync, reapStaleJobs } from '../src/db/system';

const PG_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'seros_drvtest_' + randomBytes(4).toString('hex');

// ---------------------------------------------------------------------------
// 1. the selection rule
// ---------------------------------------------------------------------------
test('dialect: postgres:// and postgresql:// select Postgres, everything else selects SQLite', () => {
  assert.equal(dialect('postgres://u:p@host:5432/db'), 'pg');
  assert.equal(dialect('postgresql://u:p@host:5432/db?sslmode=require'), 'pg');
  assert.equal(dialect('  postgres://u:p@host/db  '), 'pg');   // stray whitespace from a .env file
  assert.equal(dialect(undefined), 'sqlite');
  assert.equal(dialect(''), 'sqlite');
  assert.equal(dialect('/var/data/.seros/seros.db'), 'sqlite');
  assert.equal(dialect('file:./.seros/seros.db'), 'sqlite');
  assert.equal(dialect('mysql://u:p@host/db'), 'sqlite');      // not a Postgres URL: no silent third mode
  assert.equal(isPgUrl('postgres://x'), true);
  assert.equal(isPgUrl('postgresqlish://x'), false);
});

test('dialect: reads the live environment, so one process talks to exactly one database', () => {
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(dialect(), 'sqlite');
  process.env.DATABASE_URL = 'postgres://u:p@example.invalid:5432/db';
  try {
    assert.equal(dialect(), 'pg');
  } finally {
    delete process.env.DATABASE_URL;
  }
  assert.equal(dialect(), 'sqlite');
});

// ---------------------------------------------------------------------------
// 2. the SQLite path is unchanged
// ---------------------------------------------------------------------------
test('sqlite: migrateDb() is synchronous, applies migrations/*.sql, and is idempotent', () => {
  const first = migrateDb();
  assert.ok(Array.isArray(first), 'on SQLite migrateDb() must return the file list, not a promise');
  assert.deepEqual(first, migrationFiles('sqlite'));
  assert.ok((first as string[]).includes('0005_audit_append_only.sql'));
  const second = migrateDb();                    // it runs on every boot
  assert.deepEqual(second, first);
});

test('sqlite: openDb() still returns the synchronous better-sqlite3 handle, with the same pragmas', () => {
  const db = openDb();
  assert.equal(typeof (db.select().from(sql`sqlite_master` as any) as any).all, 'function');
  assert.equal(typeof db.all, 'function');
  assert.equal(typeof db.run, 'function');
  assert.equal((db.all(sql`SELECT 1 AS one`) as any[])[0].one, 1);
  assert.equal((db.all(sql`PRAGMA foreign_keys`) as any[])[0].foreign_keys, 1);
  assert.equal(String((db.all(sql`PRAGMA journal_mode`) as any[])[0].journal_mode).toLowerCase(), 'wal');
  const tables = (db.all(sql`SELECT name FROM sqlite_master WHERE type='table'`) as any[]).map((r) => r.name);
  for (const t of ['workspaces', 'members', 'drafts', 'confirmations', 'tasks', 'jobs', 'audit_log', 'action_meter']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('sqlite: the rewritten job claim (composite key, no rowid) still claims exactly one job', async () => {
  const db = openDb();
  const ws = await WorkspaceScope.ensure(db, 'DRV-claim');
  const a: string = await ws.enqueue('drvq', { n: 1 });
  const b: string = await ws.enqueue('drvq', { n: 2 });
  const first = claimNextJob(db, ['drvq']);
  assert.ok(first, 'a queued job must be claimable');
  assert.equal(first!.status, 'running');
  assert.equal(first!.attempts, 1);
  assert.ok([a, b].includes(first!.id));
  const second = claimNextJob(db, ['drvq']);
  assert.ok(second && second.id !== first!.id, 'the second claim must get the OTHER job, never the same one');
  assert.equal(claimNextJob(db, ['drvq']), null, 'an empty queue claims nothing');
  assert.equal(typeof first!.runAt, 'number');
  // the reaper uses the same rewritten statement shape
  assert.ok(reapStaleJobs(db, 0) >= 2);
});

test('the Postgres migration set mirrors the SQLite one, file for file', () => {
  const s = migrationFiles('sqlite');
  const p = migrationFiles('pg');
  assert.equal(p.length, s.length,
    'every SQLite migration needs a Postgres counterpart: add the mirror file in migrations/pg/ ' +
    `(sqlite: ${s.join(', ')} | pg: ${p.join(', ')})`);
  assert.deepEqual(p.map((f) => f.slice(0, 4)), s.map((f) => f.slice(0, 4)));
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join: j } = require('node:path') as typeof import('node:path');
  for (const f of p) {
    // comments explain the SQLite original, so only the STATEMENTS are scanned
    const statements = readFileSync(j(__dirname, '..', '.seros', 'migrations', 'pg', f), 'utf-8')
      .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    for (const sqliteism of ['AUTOINCREMENT', 'randomblob', 'RAISE(ABORT', 'INSERT OR IGNORE',
                             'rowid', 'PRAGMA', 'instr(']) {
      assert.ok(!statements.includes(sqliteism), `${f} still contains the SQLite-only ${sqliteism}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. the Postgres files, against a real Postgres if there is one
// ---------------------------------------------------------------------------
let probe: Promise<string | null> | null = null;
/** Returns null when a Postgres is usable, or the reason to skip. Never leaks the URL. */
function pgSkipReason(): Promise<string | null> {
  if (!PG_URL) return Promise.resolve('TEST_DATABASE_URL is not set');
  if (!isPgUrl(PG_URL)) return Promise.resolve('TEST_DATABASE_URL is not a postgres:// URL');
  if (!probe) {
    probe = (async () => {
      const pg = require('pg');
      const c = new pg.Client({ ...pgClientOptions(PG_URL!), connectionTimeoutMillis: 8000 });
      try { await c.connect(); await c.end(); return null; }
      catch (e: any) { try { await c.end(); } catch {} return `no reachable Postgres (${e?.code ?? 'connect failed'})`; }
    })();
  }
  return probe;
}

/** A plain client. Every statement the Postgres tests run is SCHEMA-QUALIFIED
 *  (`SCHEMA.audit_log`, never bare `audit_log`), so nothing here can reach the
 *  production tables in `public`, and nothing depends on a per-session
 *  `search_path` - which a transaction pooler such as Neon's `-pooler` endpoint
 *  does not reliably keep, and which it refuses outright as a startup option. */
async function pgClient(url: string = PG_URL!) {
  const pg = require('pg');
  const c = new pg.Client({ ...pgClientOptions(url), connectionTimeoutMillis: 8000 });
  await c.connect();
  return c;
}

/** The endpoint that can hold a per-session search_path, for the ORM test: the
 *  unpooled URL if one is provided, otherwise the Neon direct host (the pooled
 *  host with `-pooler` removed), otherwise the URL itself. */
function directUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL_UNPOOLED;
  if (explicit && isPgUrl(explicit)) return explicit;
  return PG_URL!.replace('-pooler.', '.');
}

test('postgres: migrations/pg/*.sql apply to a real database and are idempotent (SKIPPED unless TEST_DATABASE_URL points at a reachable Postgres)', async (t) => {
  const why = await pgSkipReason();
  if (why) return t.skip(why);

  const first = await applyPgMigrations(PG_URL!, SCHEMA);
  const second = await applyPgMigrations(PG_URL!, SCHEMA);   // it runs on every boot
  assert.deepEqual(first, migrationFiles('pg'));
  assert.deepEqual(second, first);

  const c = await pgClient();
  try {
    const tables = (await c.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`, [SCHEMA],
    )).rows.map((r: any) => r.table_name);
    for (const t2 of ['action_meter', 'audit_log', 'confirmations', 'drafts', 'jobs', 'members',
                      'source_messages', 'tasks', 'webhook_replay_nonces', 'workspaces']) {
      assert.ok(tables.includes(t2), `missing table ${t2}`);
    }
    // the constraints are the invariants: they must exist as real constraints
    const cons = (await c.query(
      `SELECT conname, contype FROM pg_constraint
        WHERE connamespace = $1::regnamespace`, [SCHEMA],
    )).rows;
    assert.ok(cons.filter((r: any) => r.contype === 'p').length >= 10, 'every table needs its primary key');
    assert.ok(cons.filter((r: any) => r.contype === 'f').length >= 8, 'the composite foreign keys must be real');
    assert.ok(cons.filter((r: any) => r.contype === 'c').length >= 10, 'the CHECK constraints must be real');
    const idx = (await c.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [SCHEMA],
    )).rows.map((r: any) => r.indexname);
    assert.ok(idx.includes('tasks_idempotency_key'), 'the unique idempotency key index must exist');
    assert.ok(idx.includes('jobs_status_runat'));
    assert.ok(idx.includes('audit_log_request'));
  } finally { await c.end(); }
});

test('postgres: audit_log is append-only in the database itself (SKIPPED unless TEST_DATABASE_URL points at a reachable Postgres)', async (t) => {
  const why = await pgSkipReason();
  if (why) return t.skip(why);
  await applyPgMigrations(PG_URL!, SCHEMA);
  const c = await pgClient();
  try {
    await c.query(`INSERT INTO ${SCHEMA}.workspaces (id,name,created_at) VALUES ('DRV-pg','w',$1) ON CONFLICT DO NOTHING`, [Date.now()]);
    const ins = await c.query(
      `INSERT INTO ${SCHEMA}.audit_log (workspace_id,event,outcome,detail,at) VALUES ('DRV-pg','driver.probe','ok','{"draft_id":"d1"}',$1)
       RETURNING id, request_id, at`, [Date.now()]);
    const row = ins.rows[0];
    assert.equal(typeof row.id, 'number', 'BIGINT must arrive as a number, not a string');
    assert.equal(typeof row.at, 'number');
    assert.match(row.request_id, /^[0-9a-f]{16}$/, 'the database must default request_id');

    await assert.rejects(() => c.query(`UPDATE ${SCHEMA}.audit_log SET event='rewritten'`), /append-only/i);
    await assert.rejects(() => c.query(`DELETE FROM ${SCHEMA}.audit_log`), /append-only/i);
    // the content check is a database constraint, not a convention
    await assert.rejects(
      () => c.query(`INSERT INTO ${SCHEMA}.audit_log (workspace_id,event,outcome,detail,at) VALUES ('DRV-pg','x','ok','{"title":"a customer sentence"}',1)`),
      /check constraint/i);
    // a member actor must be identified
    await assert.rejects(
      () => c.query(`INSERT INTO ${SCHEMA}.audit_log (workspace_id,actor_type,event,outcome,at) VALUES ('DRV-pg','member','x','ok',1)`),
      /check constraint/i);
    // and the id sequence still advances above the ids that exist
    const next = await c.query(
      `INSERT INTO ${SCHEMA}.audit_log (workspace_id,event,outcome,at) VALUES ('DRV-pg','driver.probe2','ok',$1) RETURNING id`, [Date.now()]);
    assert.ok(next.rows[0].id > row.id, 'audit ids must be monotonic');
  } finally { await c.end(); }
});

test('postgres: the job claim UPDATE ... RETURNING claims exactly one row through the ORM (SKIPPED unless TEST_DATABASE_URL points at a reachable Postgres that accepts a session search_path)', async (t) => {
  const why = await pgSkipReason();
  if (why) return t.skip(why);
  await applyPgMigrations(PG_URL!, SCHEMA);

  // The ORM issues unqualified table names, so this one test needs a connection
  // that keeps a per-session search_path. A transaction pooler does not.
  let direct: any;
  try { direct = await pgClient(directUrl()); }
  catch (e: any) { return t.skip(`no direct (non-pooled) Postgres endpoint (${e?.code ?? 'connect failed'})`); }

  const savedUrl = process.env.DATABASE_URL;
  const savedSchema = process.env.PGSCHEMA;
  try {
    await direct.query(`INSERT INTO ${SCHEMA}.workspaces (id,name,created_at) VALUES ('DRV-pgjob','w',$1) ON CONFLICT DO NOTHING`, [Date.now()]);
    await direct.query(`DELETE FROM ${SCHEMA}.jobs WHERE workspace_id='DRV-pgjob'`);
    await direct.query(
      `INSERT INTO ${SCHEMA}.jobs (workspace_id,id,queue,payload,run_at,created_at)
       VALUES ('DRV-pgjob','j1','drvq','{}',$1,$1), ('DRV-pgjob','j2','drvq','{}',$1,$1)`, [Date.now() - 1000]);

    process.env.DATABASE_URL = directUrl();
    process.env.PGSCHEMA = SCHEMA;          // keeps the ORM inside the throwaway schema
    assert.equal(dialect(), 'pg');
    const db = openDb();
    const first = await claimNextJobAsync(db, ['drvq']);
    assert.ok(first, 'the claim must return the row it claimed');
    assert.equal(first!.status, 'running');
    assert.equal(first!.attempts, 1);
    assert.equal(typeof first!.runAt, 'number', 'run_at is BIGINT and must arrive as a number');
    const second = await claimNextJobAsync(db, ['drvq']);
    assert.ok(second && second.id !== first!.id, 'two claims must never return the same job');
    assert.equal(await claimNextJobAsync(db, ['drvq']), null);
    // the synchronous entry point refuses rather than returning an unawaited promise
    assert.throws(() => claimNextJob(db, ['drvq']), /claimNextJobAsync/);
    await closeDb();
  } finally {
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
    if (savedSchema === undefined) delete process.env.PGSCHEMA; else process.env.PGSCHEMA = savedSchema;
    await direct.end().catch(() => {});
  }
});

after(async () => {
  // Leave no trace on a shared database.
  const why = await pgSkipReason();
  if (!why) {
    const pg = require('pg');
    const c = new pg.Client({ ...pgClientOptions(PG_URL!), connectionTimeoutMillis: 8000 });
    try { await c.connect(); await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } finally { await c.end().catch(() => {}); }
  }
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (INHERITED_DATABASE_URL !== undefined) process.env.DATABASE_URL = INHERITED_DATABASE_URL;
});
