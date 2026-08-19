/**
 * src/db/tx.ts - one transaction helper that works on BOTH drivers.
 *
 * The two drizzle drivers disagree about what a transaction callback may be:
 *
 *   node-postgres  db.transaction(async (tx) => ...)   the callback MUST be async
 *   better-sqlite3 db.transaction((tx) => ...)         the callback MUST NOT be:
 *                                                      better-sqlite3 throws
 *                                                      "Transaction function
 *                                                      cannot return a promise"
 *
 * Since every data-access function in this app is now async (so that the same
 * code runs on both), a SQLite transaction can no longer be expressed as a
 * callback at all. It is expressed as what it really is instead: BEGIN IMMEDIATE
 * / COMMIT / ROLLBACK issued on the connection. That is correct on better-sqlite3
 * precisely because there is exactly ONE connection per handle - the `tx` handed
 * to the callback IS `db`, and any statement issued on `db` inside the callback is
 * inside the transaction. On Postgres the pooled driver's own transaction() is
 * used, which pins one client for the duration and hands back a real tx handle.
 *
 * BEGIN IMMEDIATE, not a bare BEGIN: the write lock is taken up front, so a
 * writer cannot discover halfway through that another writer holds it and fail
 * with SQLITE_BUSY after having already read.
 *
 * Not re-entrant on SQLite (SQLite has no nested transactions without
 * savepoints), which matches the previous behaviour of db.transaction().
 */
import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { dialect } from './client';

export async function withTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  if (dialect() === 'pg') {
    // The pg driver awaits the callback, commits on resolve, rolls back on throw.
    return (db as any).transaction((tx: any) => fn(tx as Db)) as Promise<T>;
  }
  const raw = db as any;
  raw.run(sql`BEGIN IMMEDIATE`);
  let out: T;
  try {
    out = await fn(db);
  } catch (e) {
    try { raw.run(sql`ROLLBACK`); } catch { /* already rolled back by the driver */ }
    throw e;
  }
  raw.run(sql`COMMIT`);
  return out;
}
