/**
 * Runs the REAL production boot contract (src/deployment.ts) against the REAL
 * production environment pulled from Vercel, and reports every reason it would
 * refuse to boot — not just the first one.
 *
 * Secret VALUES cannot be pulled from Vercel, so they arrive as the literal
 * placeholder "[SENSITIVE]". Those are reported separately as "cannot verify
 * locally" rather than being counted as passes or failures: this script proves
 * what IS broken, and is honest about what it cannot see.
 */
import { readFileSync } from 'node:fs';
import { validateServerlessEnvironment } from '../src/deployment';

const PLACEHOLDER = '[SENSITIVE]';
const ENV_FILE = process.argv[2] ?? '/tmp/seros-prod.env';

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)="?(.*?)"?$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const real = parseEnvFile(ENV_FILE);
const secretsWeCannotSee = Object.entries(real)
  .filter(([, v]) => v === PLACEHOLDER)
  .map(([k]) => k);

// Vercel sets this at runtime; the pulled file describes the same deployment.
const env: NodeJS.ProcessEnv = { ...real, VERCEL: '1' };

// Substitute plausible values ONLY for secrets whose value is hidden, so that a
// length/format rule about a secret cannot masquerade as a provider misconfig.
const assumed: string[] = [];
for (const key of secretsWeCannotSee) {
  assumed.push(key);
  env[key] = key === 'DATABASE_URL'
    ? 'postgresql://assumed:assumed@db.example.com:5432/seros'
    : 'assumed-secret-value-not-verifiable-locally';
}

console.log(`Boot contract: src/deployment.ts against production env (${ENV_FILE})\n`);

/** Every failure, not just the first: re-run, removing each cause as it is found. */
const failures: string[] = [];
for (let i = 0; i < 12; i++) {
  try {
    validateServerlessEnvironment(env);
    break;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (failures.includes(msg)) break;
    failures.push(msg);
    // Neutralise this cause so the next call reveals the next one.
    if (msg.includes('SEROS_PROVIDER_CHAIN must not contain `fake`') || msg.includes('must include `http`')) {
      env.SEROS_PROVIDER_CHAIN = 'http';
    } else if (msg.includes('SEROS_PROVIDER=fake')) {
      delete env.SEROS_PROVIDER;
    } else if (msg.includes('SEROS_PROVIDER_API_KEY')) {
      env.SEROS_PROVIDER_API_KEY = 'assumed-api-key';
    } else if (msg.includes('SEROS_PROVIDER_ALLOWED_HOSTS')) {
      env.SEROS_PROVIDER_ALLOWED_HOSTS = new URL(env.SEROS_PROVIDER_BASE_URL!).hostname;
    } else if (msg.includes('SEROS_PROVIDER_BASE_URL')) {
      env.SEROS_PROVIDER_BASE_URL = 'https://assumed.example.com';
    } else if (msg.includes('DATABASE_URL')) {
      env.DATABASE_URL = 'postgresql://assumed:assumed@db.example.com:5432/seros';
    } else {
      break; // unrecognised: stop rather than guess
    }
  }
}

if (failures.length === 0) {
  console.log('PASS — nothing in the visible configuration blocks boot.');
} else {
  console.log(`BLOCKED — ${failures.length} reason(s) the deployment would refuse to boot:\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
}

console.log('\nNot verifiable locally (Vercel hides secret values); assumed valid above:');
for (const k of assumed) console.log(`  - ${k}`);
console.log('\nThese still need a human check for the rules the contract enforces:');
console.log('  - SEROS_SESSION_SECRET, SEROS_SIGNING_SECRET, CRON_SECRET: each >= 16 chars');
console.log('  - DATABASE_URL: must start postgres:// or postgresql://');
