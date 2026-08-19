
import { eq, sql } from 'drizzle-orm';
import { migrateDb, openDb } from './src/db/client';
import { workspaces } from './src/db/schema';
process.env.SEROS_DB = '/tmp/probe.db';
async function main() {
  migrateDb('/tmp/probe.db');
  const db: any = openDb('/tmp/probe.db');
  await db.insert(workspaces).values({ id: 'P1', name: 'n', status: 'active', retentionContentDays: 30, dailyBudgetCents: 0, monthlyBudgetCents: 0, createdAt: Date.now() }).onConflictDoNothing();
  const res: any = await db.update(workspaces).set({ name: 'x' }).where(eq(workspaces.id, 'P1'));
  console.log('sqlite update await result:', JSON.stringify(res));
  const res0: any = await db.update(workspaces).set({ name: 'x' }).where(eq(workspaces.id, 'nope'));
  console.log('no-match:', JSON.stringify(res0));
  const ins: any = await db.insert(workspaces).values({ id: 'P2', name: 'n', createdAt: 1 }).onConflictDoNothing();
  console.log('insert:', JSON.stringify(ins));
  console.log('select all:', (await db.select().from(workspaces)).length);
  const one = (await db.select().from(workspaces).where(eq(workspaces.id, 'zz')).limit(1))[0];
  console.log('missing:', one);
}
main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
