/**
 * tests/oauth.test.ts - the OAuth sign-in compile contract.
 *
 * The working tree broke `npx tsc --noEmit` (and therefore the build) in three
 * places at once. This file pins each one:
 *
 *   1. passport.use(strategy) must typecheck with the installed @types/passport
 *      when a strategy is constructed from env-var strings.
 *   2. passport.authenticate(['google','github'], cb) — the array form — must
 *      be accepted by the installed types.
 *   3. WorkspaceScope.memberByEmail returns the drizzle JOINED row
 *      { members, member_credentials }; callers must read members.id, not a
 *      flat memberId.
 *
 * It is deliberately a typecheck test: these are compile-time contracts, and
 * node:test can assert on them by invoking tsc as a subprocess.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

function typecheck(): { ok: boolean; output: string } {
  try {
    execFileSync(TSC, ['--noEmit'], { cwd: ROOT, encoding: 'utf8' });
    return { ok: true, output: '' };
  } catch (e: any) {
    return { ok: false, output: String(e.stdout || '') + String(e.stderr || '') };
  }
}

test('typecheck: the whole tree compiles (passport.use + authenticate array + memberByEmail)', () => {
  const r = typecheck();
  assert.equal(
    r.ok, true,
    'npx tsc --noEmit failed:\n' + r.output,
  );
});

test('typecheck: reading .memberId off memberByEmail joined row is a type error', () => {
  // The negative control: if this ever PASSES, the guard above is vacuous.
  const probe = `
type Row = { members: { id: string }, member_credentials: { memberId: string } };
declare function memberByEmail(e: string): Promise<Row | undefined>;
async function main() { const m = await memberByEmail('a@b.c'); if (m) console.log(m.memberId); }
main();
`;
  const tmp = join(ROOT, '.seros', 'probe-memberid.ts');
  require('node:fs').mkdirSync(join(ROOT, '.seros'), { recursive: true });
  require('node:fs').writeFileSync(tmp, probe);
  let failed = false;
  try {
    execFileSync(TSC, ['--noEmit', '--strict', tmp], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    failed = true;
  } finally {
    require('node:fs').rmSync(tmp, { force: true });
  }
  assert.equal(failed, true, '.memberId should NOT typecheck on the joined row');
});
