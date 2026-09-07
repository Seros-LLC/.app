/**
 * tests/eval-logging.test.ts — M14 corpus-text logging guard.
 *
 * The evaluation CLI is allowed to print aggregate metrics, but customer or
 * corpus text must not enter ordinary CI logs. Misclassified examples are
 * available only after an explicit SEROS_EVAL_SHOW_TEXT=1 opt-in. Exercise the
 * CLI itself rather than testing an internal formatting helper that does not
 * exist in this repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = join(__dirname, '..');

function runEval(showText = false): string {
  const dbDir = mkdtempSync(join(tmpdir(), 'seros-eval-log-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SEROS_PROVIDER: 'fake',
    SEROS_DB: join(dbDir, 'eval.db'),
    SEROS_DETECT_THRESHOLD: '55',
  };
  if (showText) env.SEROS_EVAL_SHOW_TEXT = '1';
  else delete env.SEROS_EVAL_SHOW_TEXT;
  return execFileSync('npx', ['tsx', 'evals/detection.ts'], {
    cwd: APP,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('evaluation output reports errors without printing corpus text by default', () => {
  const output = runEval();
  assert.match(output, /examples\s+217/);
  assert.match(output, /misclassified\. Re-run with SEROS_EVAL_SHOW_TEXT=1/);
  assert.doesNotMatch(output, /Someone will need to send the deck/,
    'default CI output must not contain a corpus example');
  assert.doesNotMatch(output, /I will review your PR tomorrow morning/,
    'default CI output must not contain a correctly classified example either');
});

test('evaluation text requires the explicit opt-in flag', () => {
  const output = runEval(true);
  assert.ok(output.includes('Someone will need to send the deck at some point.'),
    'the explicit debugging opt-in still provides useful misclassification detail');
});
