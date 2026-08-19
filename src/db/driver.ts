/**
 * src/db/driver.ts - which database the app is talking to, and how to open it.
 *
 * The app runs on SQLite locally and in tests, and on Postgres in production
 * (Vercel serverless, where the filesystem is ephemeral: a SQLite FILE there is
 * a store that silently disappears between invocations). The choice is made by
 * ONE environment variable and nothing else:
 *
 *   DATABASE_URL starts with postgres:// or postgresql://  ->  Postgres
 *   anything else, including unset/empty                   ->  better-sqlite3,
 *                                                              file from SEROS_DB
 *
 * There is no third mode and no per-call override: a process talks to exactly
 * one database, so a mis-set variable cannot half-migrate one store and write to
 * the other.
 *
 * TYPE NOTE, read this before changing the signature of openDb(). The whole app
 * (src/db/scope.ts, src/retention.ts, src/limits.ts, tests) is written against
 * better-sqlite3's SYNCHRONOUS drizzle API - .get(), .all(), .run(), and a
 * synchronous db.transaction(). node-postgres' drizzle is asynchronous and has
 * none of those methods. openDb() is therefore TYPED as the SQLite handle while
 * being able to RETURN the Postgres one, so the existing call sites keep
 * compiling. That is a deliberate, documented lie at the type level, not an
 * oversight: pointing DATABASE_URL at a real Postgres does not make those
 * synchronous call sites work, it makes them throw at runtime (see README /
 * the report accompanying this change). The Postgres-safe entry points are the
 * *Async functions in src/db/system.ts.
 */
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { readFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Dialect = 'sqlite' | 'pg';

/** The handle every module in this app is typed against. */
export type Db = ReturnType<typeof drizzleSqlite>;

const SQLITE_MIGRATIONS = join(__dirname, '..', '..', '.seros', 'migrations');
const PG_MIGRATIONS = join(SQLITE_MIGRATIONS, 'pg');

/** An advisory lock id, so two booting instances cannot migrate at once. */
const PG_MIGRATION_LOCK = 8_154_193_027_111_001n;

const dbFile = () => process.env.SEROS_DB || join(__dirname, '..', '..', '.seros', 'seros.db');

/**
 * How many rows a write touched, on either driver. better-sqlite3 answers with
 * `{ changes }`, node-postgres with a Result carrying `rowCount`; a conditional
 * update ("only if it is still queued") is a correctness check in this codebase,
 * so reading the wrong field silently turns it into "always true".
 */
export function affectedRows(result: unknown): number {
  const r = result as { changes?: number; rowCount?: number } | null | undefined;
  if (!r) return 0;
  return Number(r.changes ?? r.rowCount ?? 0);
}

/** True for exactly the two URL schemes node-postgres accepts. */
export function isPgUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const u = url.trim();
  return u.startsWith('postgres://') || u.startsWith('postgresql://');
}

/** Which driver this process is using. Reads the environment every time, so a
 *  test can flip DATABASE_URL and see the answer change. */
export function dialect(url: string | undefined = process.env.DATABASE_URL): Dialect {
  return isPgUrl(url) ? 'pg' : 'sqlite';
}

/** The migration files that apply to a dialect, in application order. */
export function migrationsDir(d: Dialect = dialect()): string {
  return d === 'pg' ? PG_MIGRATIONS : SQLITE_MIGRATIONS;
}
export function migrationFiles(d: Dialect = dialect()): string[] {
  const dir = migrationsDir(d);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

// ---------------------------------------------------------------------------
// Postgres: one pool per process, cached across serverless invocations.
// ---------------------------------------------------------------------------
type PgState = { pool: any; db: Db; url: string };
// A warm Vercel lambda re-imports this module rarely but re-invokes the handler
// often; the pool must outlive the invocation or every request pays a TCP+TLS
// handshake and the database runs out of connections.
const g = globalThis as any;

function sslFor(url: string) {
  // Managed Postgres (Neon, Supabase, RDS) hands out sslmode=require URLs. The
  // certificate chain is not verifiable without shipping a CA bundle, and
  // node-postgres defaults to rejecting it, so honour the URL explicitly.
  if (/[?&]sslmode=(require|verify-ca|verify-full)/.test(url)) return { rejectUnauthorized: false };
  return undefined;
}


/** The connection options for a Postgres URL, so the migrator and a test client
 *  agree about TLS. Exported for tests; there is nothing secret in the result
 *  that is not already in the URL. */
export function pgClientOptions(url: string): { connectionString: string; ssl?: { rejectUnauthorized: boolean } | undefined } {
  return { connectionString: url, ssl: sslFor(url) };
}

function pgTypeFixups(pg: any) {
  // int8 (BIGINT) arrives as a STRING by default, because 2^63 does not fit a
  // JS number. Every BIGINT in this schema is an epoch-millisecond timestamp or
  // a small counter, all far inside Number.MAX_SAFE_INTEGER, and the whole app
  // does arithmetic on them (Date.now() comparisons, backoff, retention windows).
  // Without this, `created_at` comes back as "1787140523239" and every one of
  // those comparisons is wrong in a way that is invisible until it is not.
  pg.types.setTypeParser(20, (v: string) => (v === null ? null : Number(v)));
}

function openPg(): Db {
  const url = process.env.DATABASE_URL!;
  if (g.__serosPg && g.__serosPg.url === url) return (g.__serosPg as PgState).db;
  // Required lazily: on the SQLite path `pg` is never loaded at all.
  const pg = require('pg');
  const { drizzle } = require('drizzle-orm/node-postgres');
  pgTypeFixups(pg);
  const pool = new pg.Pool({
    connectionString: url,
    // Serverless: many short-lived instances, each of which should hold as few
    // connections as possible. Overridable for a long-running worker.
    max: Number(process.env.PGPOOL_MAX || 1),
    idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_MS || 10_000),
    connectionTimeoutMillis: Number(process.env.PGPOOL_CONNECT_MS || 10_000),
    ssl: sslFor(url),
  });
  // Optional: put this deployment's tables in a named schema instead of `public`.
  // Defaults to `public`, which is where migrateDb() puts them.
  // Applied per connection, so it needs a SESSION-pooled or direct endpoint; on a
  // TRANSACTION pooler (a Neon `-pooler` host) a per-session SET is not reliable,
  // which is why the migrator above uses SET LOCAL inside its own transaction
  // instead of depending on this.
  const schema = process.env.PGSCHEMA ?? 'public';
  assertSchemaName(schema);
  // Set on every new connection, including the default, so a pooled server
  // connection left pointing somewhere else by another client cannot silently
  // redirect this app's queries.
  pool.on('connect', (c: any) => { c.query(`SET search_path TO ${schema}`); });
  const state: PgState = { pool, db: drizzle(pool) as unknown as Db, url };
  g.__serosPg = state;
  return state.db;
}

// ---------------------------------------------------------------------------
// SQLite: unchanged from the original src/db/client.ts, byte for byte in effect.
// ---------------------------------------------------------------------------
function openSqlite(dbPath: string): Db {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzleSqlite(sqlite);
}

/**
 * The one way to get a database handle. The argument is the SQLite file path and
 * is ignored on Postgres, where the location is the URL.
 */
export function openDb(dbPath: string = dbFile()): Db {
  return dialect() === 'pg' ? openPg() : openSqlite(dbPath);
}

/**
 * Release the connection. On Postgres this drains the pool, which a serverless
 * handler should do before it freezes if it is not reusing the warm instance;
 * on SQLite it is a no-op because each openDb() handle is closed by GC and the
 * process is long-lived. Safe to call when nothing is open.
 */
export async function closeDb(): Promise<void> {
  const state: PgState | undefined = g.__serosPg;
  if (!state) return;
  g.__serosPg = undefined;
  try { await state.pool.end(); } catch { /* already ended: nothing to release */ }
}

// ---------------------------------------------------------------------------
// Migrations. Run on every boot, so every file in both sets is idempotent.
// ---------------------------------------------------------------------------

/** Applies migrations/pg/*.sql to `url`, in order, each file in its own
 *  transaction, under an advisory lock so two booting instances serialise.
 *  Exported so a test can point it at a throwaway database. */
export async function applyPgMigrations(
  url: string = process.env.DATABASE_URL!,
  schema?: string,
): Promise<string[]> {
  const pg = require('pg');
  pgTypeFixups(pg);
  const client = new pg.Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();
  try {
    // `schema` is an isolation hook for tests: it lets tests/driver.test.ts apply
    // the real files to a throwaway schema on a real database without touching
    // the production tables in `public`. Production passes nothing.
    if (schema) {
      assertSchemaName(schema);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    }
    const files = migrationFiles('pg');
    for (const f of files) {
      const text = readFileSync(join(PG_MIGRATIONS, f), 'utf-8');
      try {
        await client.query('BEGIN');
        // A TRANSACTION-scoped lock, not a session one: a managed Postgres is
        // usually reached through a transaction pooler (Neon, Supabase), where a
        // session-level lock can be left on a server connection this client never
        // sees again. This one is released by COMMIT/ROLLBACK, always.
        await client.query('SELECT pg_advisory_xact_lock($1)', [PG_MIGRATION_LOCK.toString()]);
        // SET LOCAL, never a bare SET, for the same reason: it dies with the
        // transaction. A session-level SET on a transaction pooler is left behind
        // on a shared server connection and silently redirects somebody else's
        // queries (observed against Neon while building this). It is set on EVERY
        // run, not only the isolated one, so a migration cannot inherit a stale
        // search_path from whoever used this connection last.
        await client.query(`SET LOCAL search_path TO ${schema ?? 'public'}`);
        await client.query(text);
        await client.query('COMMIT');
      } catch (e: any) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${f} failed: ${e?.message ?? e}`);
      }
    }
    return files;
  } finally {
    await client.end().catch(() => {});
  }
}

function assertSchemaName(schema: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`unsafe schema name: ${schema}`);
}

function migrateSqlite(dbPath: string): string[] {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma('foreign_keys = ON');
  const files = migrationFiles('sqlite');
  for (const f of files) raw.exec(readFileSync(join(SQLITE_MIGRATIONS, f), 'utf-8'));
  raw.close();
  return files;
}

/**
 * Idempotent: every migration is CREATE ... IF NOT EXISTS (plus, on Postgres,
 * CREATE OR REPLACE FUNCTION and DROP TRIGGER IF EXISTS), so this is safe to run
 * on every boot - which it is.
 *
 * SIGNATURE, deliberately: it is typed `string[]` because a dozen call sites do
 * `migrateDb(); const db = openDb();` at module top level and every one of them
 * is on SQLite, where this really is synchronous. On Postgres the returned value
 * is a PROMISE of that list wearing the same type, exactly like openDb()'s handle
 * (see the header of this file): `await migrateDb()` is correct on both, and a
 * Postgres caller that forgets the await has a floating promise. Callers that can
 * be async should use migrateDbAsync(), which is honest on both dialects.
 */
export function migrateDb(dbPath: string = dbFile()): string[] {
  const result = dialect() === 'pg' ? applyPgMigrations() : migrateSqlite(dbPath);
  return result as unknown as string[];
}

/** migrateDb() with the type it actually has on Postgres. Awaitable on both. */
export function migrateDbAsync(dbPath: string = dbFile()): Promise<string[]> {
  return Promise.resolve(migrateDb(dbPath) as unknown as string[] | Promise<string[]>);
}
