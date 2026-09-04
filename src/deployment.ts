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
export function validateServerlessEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  requireSecret(env, 'SEROS_SESSION_SECRET');
  requireSecret(env, 'SEROS_SIGNING_SECRET');
  if (!isPgUrl(env.DATABASE_URL)) {
    throw new Error('DATABASE_URL must be a postgres:// or postgresql:// URL on Vercel');
  }
}
