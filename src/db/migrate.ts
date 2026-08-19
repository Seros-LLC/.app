import { migrateDbAsync } from './client';
// Awaitable on both dialects: synchronous underneath on SQLite, a real round trip
// to the server on Postgres.
migrateDbAsync().then((applied) => {
  console.log(JSON.stringify({ level: 'info', event: 'migrate.done', files: applied }));
}).catch((e) => {
  console.error(JSON.stringify({ level: 'error', event: 'migrate.failed', message: String(e?.message ?? e) }));
  process.exit(1);
});
