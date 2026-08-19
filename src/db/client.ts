import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dbFile = () => process.env.SEROS_DB || join(__dirname, '..', '..', 'seros.db');
const MIGRATIONS = join(__dirname, '..', '..', 'migrations');

export function openDb(dbPath: string = dbFile()) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite);
}

/** Idempotent: every migration is CREATE TABLE IF NOT EXISTS. */
export function migrateDb(dbPath: string = dbFile()) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma('foreign_keys = ON');
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) raw.exec(readFileSync(join(MIGRATIONS, f), 'utf-8'));
  raw.close();
  return files;
}
