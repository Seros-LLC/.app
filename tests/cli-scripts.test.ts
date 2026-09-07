/**
 * Every `npm run X` a source file tells an operator to run must exist in
 * package.json.
 *
 * src/sweep.ts (the retention sweeper, invariant 24), src/prune.ts (the replay
 * nonce cleaner, H5) and src/limits-cli.ts (the draft-expiry and cap pass, M7/M3)
 * each documented their own entry point in a header comment, and none of the three
 * was wired into package.json. `npm run sweep` failed with "Missing script", so the
 * three scheduled maintenance jobs the runbook depends on were unreachable in the
 * shape they were documented in. The code was right; the manifest had drifted.
 *
 * This test is the check that would have caught it: it reads the scripts operators
 * are told to run out of the source itself, so a new CLI cannot be documented
 * without being runnable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const scripts: Record<string, string> = pkg.scripts ?? {};

test('every `npm run X` named in src/ or tools/ is a real package.json script', () => {
  const missing: string[] = [];
  for (const file of [...tsFiles(join(ROOT, 'src')), ...tsFiles(join(ROOT, 'tools'))]) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
      const name = m[1];
      if (name === undefined) continue;
      if (!(name in scripts)) missing.push(`${relative(ROOT, file)} -> npm run ${name}`);
    }
  }
  assert.deepEqual(missing, [], `documented but not defined:\n  ${missing.join('\n  ')}`);
});

test('the three scheduled maintenance jobs are runnable by name', () => {
  // Named explicitly, not derived: these are the ones the runbook schedules, and
  // deleting the comment that mentions them should not silently delete the check.
  for (const [name, entry] of [
    ['sweep', 'src/sweep.ts'],        // retention: nulls content past the window
    ['prune', 'src/prune.ts'],        // replay nonce store
    ['limits', 'src/limits-cli.ts'],  // draft expiry + cap report
    ['worker', 'src/worker.ts'],      // the queue drain itself
    ['migrate', 'src/db/migrate.ts'],
  ] as const) {
    assert.ok(scripts[name], `package.json has no "${name}" script`);
    assert.match(scripts[name], new RegExp(entry.replace(/[.]/g, '\\.')),
      `"${name}" should run ${entry}, runs: ${scripts[name]}`);
  }
});

test('each maintenance entry point actually executes when run directly', () => {
  // A script that points at a module with no top-level main() is a script that
  // exits 0 having done nothing, which is the failure mode this whole file exists
  // to prevent. Cheap structural check: the module must self-start.
  for (const rel of ['src/sweep.ts', 'src/prune.ts', 'src/limits-cli.ts', 'src/worker.ts']) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    const selfStarts = /require\.main === module/.test(text)
      || /^main\(\)/m.test(text)
      || /\nmain\(\)\s*[.;]/.test(text);
    assert.ok(selfStarts, `${rel} is wired to an npm script but never invokes itself`);
  }
});
