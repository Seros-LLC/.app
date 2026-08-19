
import { randomBytes } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { applyPgMigrations, openDb, closeDb, dialect } from './src/db/client';
import { workspaces, jobs, auditEvents } from './src/db/schema';

const URL = process.env.TEST_DATABASE_URL!;
const SCHEMA = 'seros_smoke_' + randomBytes(4).toString('hex');

async function main() {
  await applyPgMigrations(URL, SCHEMA);
  process.env.DATABASE_URL = URL.replace('-pooler.', '.');
  process.env.PGSCHEMA = SCHEMA;
  console.log('dialect', dialect());
  const db: any = openDb();
  try {
    await db.insert(workspaces).values({ id: 'W1', name: 'w', status: 'active', retentionContentDays: 30, dailyBudgetCents: 0, monthlyBudgetCents: 0, createdAt: Date.now() }).onConflictDoNothing();
    const rows = await db.select().from(workspaces).where(eq(workspaces.id, 'W1'));
    console.log('select rows', JSON.stringify(rows));
    const one = (await db.select().from(workspaces).where(eq(workspaces.id, 'W1')).limit(1))[0];
    console.log('limit1', JSON.stringify(one), 'createdAt type', typeof one?.createdAt);
    const missing = (await db.select().from(workspaces).where(eq(workspaces.id, 'nope')).limit(1))[0];
    console.log('missing is', missing);
    // audit insert (autoincrement id, default request_id)
    await db.insert(auditEvents).values({ workspaceId: 'W1', event: 'smoke', outcome: 'ok', actorType: 'system', actorId: null, objectType: null, objectId: null, detail: null, at: Date.now() });
    const a = await db.select().from(auditEvents);
    console.log('audit rows', a.length, JSON.stringify(a[0]));
    // update returning changes?
    const res: any = await db.update(workspaces).set({ name: 'w2' }).where(eq(workspaces.id, 'W1'));
    console.log('update result keys', Object.keys(res||{}), 'rowCount', res?.rowCount, 'changes', res?.changes);
    // onConflictDoUpdate
    await db.insert(jobs).values({ workspaceId: 'W1', id: 'j1', queue: 'q', status: 'queued', payload: '{}', runAt: Date.now(), attempts: 0, createdAt: Date.now() });
    // transaction
    try {
      await db.transaction(async (tx: any) => {
        await tx.insert(jobs).values({ workspaceId: 'W1', id: 'j2', queue: 'q', status: 'queued', payload: '{}', runAt: Date.now(), attempts: 0, createdAt: Date.now() });
        throw new Error('boom');
      });
    } catch (e: any) { console.log('tx rejected:', e.message); }
    const js = await db.select().from(jobs);
    console.log('jobs after rollback', js.map((j: any) => j.id).join(','));
    // raw sql execute
    const ex = await db.execute(sql`SELECT 1 as one`);
    console.log('execute rows', JSON.stringify(ex.rows ?? ex));
  } finally {
    await closeDb();
    const pg = require('pg');
    const c = new pg.Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
    await c.connect(); await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await c.end();
    console.log('dropped schema');
  }
}
main().catch((e) => { console.error('FAILED', e?.message, e?.stack?.split('\n').slice(0,4).join(' | ')); process.exit(1); });
