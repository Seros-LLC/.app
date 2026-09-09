import { isPgUrl } from './db/driver';

const requireSecret = (env: NodeJS.ProcessEnv, name: string): void => {
  const value = env[name];
  if (!value || value.length < 16) {
    throw new Error(`${name} is unset or too short (>=16 chars required)`);
  }
};

/**
 * Vercel has no durable writable filesystem. Refuse to boot unless the deployment
 * has real signing material and a Postgres database. Keeping this pure makes the
 * fail-closed contract directly testable without importing the serverless handler.
 */
/**
 * A serverless deployment has no localhost, so an `ollama` transport can never
 * answer there. Booting without a reachable provider produced the worst failure
 * mode we have: the app reports healthy, accepts Slack events, and silently
 * drafts nothing, because the transport error surfaces one request at a time and
 * never at startup. Refuse the deployment instead of shipping a queue that stays
 * empty for reasons no operator can see.
 */
const requireUsableProvider = (env: NodeJS.ProcessEnv): void => {
  if (env.SEROS_PROVIDER === 'fake') {
    throw new Error('SEROS_PROVIDER=fake must never serve a deployment: it fabricates model output');
  }
  const chain = (env.SEROS_PROVIDER_CHAIN || 'ollama')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (chain.includes('fake')) {
    throw new Error('SEROS_PROVIDER_CHAIN must not contain `fake` on Vercel: it fabricates model output');
  }
  if (!chain.includes('http')) {
    throw new Error(
      'SEROS_PROVIDER_CHAIN must include `http` on Vercel: the default `ollama` transport ' +
      'points at localhost:11434, which does not exist in a serverless runtime, so every ' +
      'draft would fail silently',
    );
  }
  if (!env.SEROS_PROVIDER_BASE_URL || !env.SEROS_PROVIDER_API_KEY) {
    throw new Error(
      'SEROS_PROVIDER_BASE_URL and SEROS_PROVIDER_API_KEY are required when the chain includes `http`',
    );
  }
};

export function validateServerlessEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  requireSecret(env, 'SEROS_SESSION_SECRET');
  requireSecret(env, 'SEROS_SIGNING_SECRET');
  if (!isPgUrl(env.DATABASE_URL)) {
    throw new Error('DATABASE_URL must be a postgres:// or postgresql:// URL on Vercel');
  }
  requireUsableProvider(env);
}
