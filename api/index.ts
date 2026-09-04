/**
 * Vercel serverless entry. The whole Express app becomes one function.
 *
 * Migrations run once per cold start, guarded, because there is no deploy step on
 * this platform that owns "apply the schema" and every migration in this repo is
 * written to be a no-op when it has already run.
 */
import { createApp } from '../src/server';
import { migrateDbAsync } from '../src/db/client';
import { validateServerlessEnvironment } from '../src/deployment';

// A serverless deployment without real credentials or durable storage is a
// failed deployment, not a public demo with source-controlled keys and /tmp data.
validateServerlessEnvironment();

// On Postgres the migration is asynchronous, so the first request must WAIT for
// it instead of racing it: one promise per cold start, awaited by every request
// until it settles. A failed migration is not cached as success - the next
// request retries rather than serving a half-built schema forever.
let booting: Promise<void> | undefined;
function boot(): Promise<void> {
  if (process.env.SEROS_SKIP_MIGRATE === '1') return Promise.resolve();
  booting ??= migrateDbAsync().then(() => undefined).catch((err) => {
    booting = undefined;
    throw err;
  });
  return booting;
}

const app = createApp();

export default async function handler(req: any, res: any) {
  await boot();
  return app(req, res);
}
