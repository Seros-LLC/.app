/**
 * The database handle, kept as the import path the whole app already uses.
 * The actual driver choice - SQLite file (local, tests) vs Postgres (production
 * on Vercel), selected by DATABASE_URL - lives in ./driver, which also documents
 * the environment contract. This file exists so that `import { openDb } from
 * '../db/client'` in a dozen modules did not have to change.
 */
export { 
  openDb, 
  migrateDb, 
  migrateDbAsync, 
  closeDb, 
  dialect, 
  isPgUrl, 
  applyPgMigrations, 
  affectedRows,
  migrationFiles, 
  migrationsDir, 
  pgClientOptions 
} from './driver';

export type { 
  Dialect, 
  Db 
} from './driver';
