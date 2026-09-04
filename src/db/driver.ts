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
 * TYPE NOTE: This module now properly types the database handle for both SQLite
 * and Postgres while maintaining backward compatibility. The Db type represents
 * the common interface that works for both drivers in synchronous contexts.
 * For Postgres-specific async operations, use the *Async functions in 
 * src/db/system.ts.
 */
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { readFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "./schema";

export type Dialect = "sqlite" | "pg";

/** The handle that works for both drivers in synchronous contexts. */
export type Db = ReturnType<typeof drizzleSqlite>;

const SQLITE_MIGRATIONS = join(__dirname, "..", "..", ".seros", "migrations");
const PG_MIGRATIONS = join(SQLITE_MIGRATIONS, "pg");

/** An advisory lock id, so two booting instances cannot migrate at once. */
const PG_MIGRATION_LOCK = BigInt("8154193027111001");

const dbFile = () => process.env.SEROS_DB || (process.env.VERCEL ? "/tmp/seros.db" : join(__dirname, "..", "..", ".seros", "seros.db"));

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

/** True for exactly the two URL schemes postgres-js accepts. */
export function isPgUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const u = url.trim();
  return u.startsWith("postgres://") || u.startsWith("postgresql://");
}

/** Which driver this process is using. Reads the environment every time, so a
 *  test can flip DATABASE_URL and see the answer change. */
export function dialect(url: string | undefined = process.env.DATABASE_URL): Dialect {
  return isPgUrl(url) ? "pg" : "sqlite";
}

/** The migration files that apply to a dialect, in application order. */
export function migrationsDir(d: Dialect = dialect()): string {
  return d === "pg" ? PG_MIGRATIONS : SQLITE_MIGRATIONS;
}
export function migrationFiles(d: Dialect = dialect()): string[] {
  const dir = migrationsDir(d);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

// ---------------------------------------------------------------------------
// Postgres: one pool per process, cached across serverless invocations.
// ---------------------------------------------------------------------------
type PgState = { sql: postgres.Sql; db: any; url: string };
const g = globalThis as any;

function sslFor(url: string): any {
  if (/[?&]sslmode=(require|verify-ca|verify-full)/.test(url)) return { rejectUnauthorized: false };
  return undefined;
}

/** The connection options for a Postgres URL. */
export function pgClientOptions(url: string): { connectionString: string; ssl?: any } {
  return { connectionString: url, ssl: sslFor(url) };
}

function openPg(): any {
  const url = process.env.DATABASE_URL!;
  if (g.__serosPg && g.__serosPg.url === url) return (g.__serosPg as PgState).db;

  const sqlOptions: any = {
    max: Number(process.env.PGPOOL_MAX || 1),
    idle_timeout: Number(process.env.PGPOOL_IDLE_MS || 10000),
    connect_timeout: Number(process.env.PGPOOL_CONNECT_MS || 10000),
    transform: postgres.camel,
    types: {
      bigint: postgres.BigInt,
    },
  };

  const ssl = sslFor(url);
  if (ssl !== undefined) {
    sqlOptions.ssl = ssl;
  }

  const sql = postgres(url, sqlOptions);

  const schemaName = process.env.PGSCHEMA ?? "public";
  assertSchemaName(schemaName);
  // Note: postgres-js does not support per-connection SET search_path easily,
  // so we rely on the migrator SET LOCAL approach.

  const db = drizzlePg(sql, { schema });
  const state: PgState = { sql, db, url };
  g.__serosPg = state;
  return db;
}

// ---------------------------------------------------------------------------
// SQLite: unchanged from the original src/db/client.ts, byte for byte in effect.
// ---------------------------------------------------------------------------
function openSqlite(dbPath: string): Db {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzleSqlite(sqlite, { schema });
}

/**
 * The one way to get a database handle. The argument is the SQLite file path and
 * is ignored on Postgres, where the location is the URL.
 */
export function openDb(dbPath: string = dbFile()): Db {
  return dialect() === "pg" ? openPg() : openSqlite(dbPath);
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
  try { await state.sql.end(); } catch { /* already ended: nothing to release */ }
}

// ---------------------------------------------------------------------------
// Migrations. Run on every boot, so every file in both sets is idempotent.
// ---------------------------------------------------------------------------

/** Applies migrations/pg/*.sql to `url`, in order, each file in its own
 *  transaction, under an advisory lock so two booting instances serialise. */
export async function applyPgMigrations(
  url: string = process.env.DATABASE_URL!,
  schemaName?: string,
): Promise<string[]> {
  const sql = postgres(url, { ssl: sslFor(url) });
  try {
    if (schemaName) {
      assertSchemaName(schemaName);
      await sql`CREATE SCHEMA IF NOT EXISTS ${sql.unsafe(schemaName)}`;
    }
    const files = migrationFiles("pg");
    for (const f of files) {
      const text = readFileSync(join(PG_MIGRATIONS, f), "utf-8");
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`SELECT pg_advisory_xact_lock(${PG_MIGRATION_LOCK})`);
          await tx.unsafe(`SET LOCAL search_path TO ${schemaName ?? "public"}`);
          await tx.unsafe(text);
        });
      } catch (e: any) {
        throw new Error(`migration ${f} failed: ${e?.message ?? e}`);
      }
    }
    return files;
  } finally {
    await sql.end().catch(() => {});
  }
}

function assertSchemaName(schemaName: string): void {
  const pattern = new RegExp("^[a-z_][a-z0-9_]*$");
  if (!pattern.test(schemaName)) throw new Error(`unsafe schema name: ${schemaName}`);
}

function migrateSqlite(dbPath: string): string[] {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma("foreign_keys = ON");
  const files = migrationFiles("sqlite");
  for (const f of files) raw.exec(readFileSync(join(SQLITE_MIGRATIONS, f), "utf-8"));

  // drafts.expires_at (REVIEW.md M7, brief §1.5) is added here rather than in a
  // migration file because SQLite has no `ADD COLUMN IF NOT EXISTS`, and the loop
  // above re-runs every file on every boot with no tracking table — so a bare ALTER
  // in a .sql file succeeds once and then crashes the app on its second start.
  // Guarding on the catalogue is idempotent by construction. Postgres does have the
  // clause and gets a normal migration: migrations/pg/0013_draft_expires_at.sql.
  const draftCols = raw.prepare("PRAGMA table_info(drafts)").all() as { name: string }[];
  if (!draftCols.some((c) => c.name === "expires_at")) {
    raw.exec("ALTER TABLE drafts ADD COLUMN expires_at INTEGER");
  }

  raw.close();
  return files;
}

/**
 * Idempotent: every migration is CREATE ... IF NOT EXISTS (plus, on Postgres,
 * CREATE OR REPLACE FUNCTION and DROP TRIGGER IF EXISTS), so this is safe to run
 * on every boot - which it is.
 */
export function migrateDb(dbPath: string = dbFile()): string[] {
  const result = dialect() === "pg" ? applyPgMigrations() : migrateSqlite(dbPath);
  return result as unknown as string[];
}

/** migrateDb() with the type it actually has on Postgres. Awaitable on both. */
export function migrateDbAsync(dbPath: string = dbFile()): Promise<string[]> {
  return Promise.resolve(migrateDb(dbPath) as unknown as string[] | Promise<string[]>);
}
