/**
 * Vercel serverless entry. The whole Express app becomes one function.
 *
 * Migrations run once per cold start, guarded, because there is no deploy step on
 * this platform that owns "apply the schema" and every migration in this repo is
 * written to be a no-op when it has already run.
 */
import { createApp } from '../src/server';
import { migrateDb } from '../src/db/client';

let ready = false;
function boot() {
  if (ready) return;
  if (process.env.SEROS_SKIP_MIGRATE !== '1') migrateDb();
  ready = true;
}

const app = createApp();

export default function handler(req: any, res: any) {
  boot();
  return app(req, res);
}
