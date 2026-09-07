/**
 * Keep the operator README aligned with the production route surface and
 * package scripts. This guards against resurrecting the removed synthetic demo
 * path or hiding the maintenance jobs from operators.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

test('README does not direct operators to the removed synthetic demo route', () => {
  // The README may mention that `/demo` was removed. It must not contain a
  // clickable demo URL or tell an operator to open that path.
  assert.doesNotMatch(readme, /<https?:\/\/[^>]*\/demo\b|open[^\n]*\/demo\b/i,
    'README must not advertise or direct operators to the removed /demo route');
  assert.match(readme, /http:\/\/localhost:3000\/login/,
    'README should direct local operators to authenticated login');
});

test('README documents each maintenance CLI exposed by package.json', () => {
  for (const [name, entry] of [
    ['sweep', 'src/sweep.ts'],
    ['prune', 'src/prune.ts'],
    ['limits', 'src/limits-cli.ts'],
  ] as const) {
    assert.equal(typeof packageJson.scripts?.[name], 'string',
      `package.json must define npm run ${name}`);
    assert.match(readme, new RegExp(`npm run ${name}`),
      `README must document npm run ${name}`);
    assert.match(packageJson.scripts?.[name] ?? '', new RegExp(entry.replace(/[.]/g, '\\.'), 'u'),
      `npm run ${name} should execute ${entry}`);
  }
});

test('README links the human-confirmation ADR to the product repository', () => {
  assert.match(readme,
    /https:\/\/github\.com\/Seros-LLC\/seros\/blob\/main\/docs\/adr\/0002-human-confirmation-is-mandatory\.md/);
  assert.doesNotMatch(readme, /\.\.\/seros\/product\/docs\/adr/,
    'README must not use the invalid cross-repository path');
});
