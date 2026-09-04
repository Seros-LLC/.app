/**
 * Creates the demo workspace and its people - now WITH passwords, because a member
 * you can become by picking their name from a list is not a member you can attribute
 * a confirmation to (README, "known hole").
 *
 * The generated passwords are printed ONCE, here, on stdout, and are nowhere else:
 * not in the audit log (which gets `password.set` with a member id and nothing more),
 * not in the database (which gets a scrypt hash), and not in any other log line.
 * Re-running is safe: a member who already has a password keeps it unless
 * SEROS_SEED_RESET=1 says otherwise, so a stray `npm run seed` cannot quietly
 * replace a real credential.
 */
import crypto from 'node:crypto';
import { migrateDbAsync, openDb } from './db/client';
import { WorkspaceScope } from './db/scope';
import { MemberCredentials, hashPassword, passwordPolicyError } from './password';

const WS = process.env.SEROS_WORKSPACE || 'demo';

const PEOPLE = [
  { id: 'u-ana', name: 'Ana Okafor',    role: 'owner'     as const, email: 'ana@demo.invalid' },
  { id: 'u-bo',  name: 'Bo Lindqvist',  role: 'confirmer' as const, email: 'bo@demo.invalid' },
  { id: 'u-vic', name: 'Vic Reyes',     role: 'viewer'    as const, email: 'vic@demo.invalid' },
];

/** 16 characters out of 96 bits of randomness. Never derived from the member id. */
function generatePassword(): string {
  for (let i = 0; i < 8; i++) {
    const candidate = crypto.randomBytes(12).toString('base64url');
    if (!passwordPolicyError(candidate)) return candidate;
  }
  return crypto.randomBytes(24).toString('base64url');
}

async function main() {
  await migrateDbAsync();
  const db = openDb();
  const scope = await WorkspaceScope.ensure(db, WS, 'Demo workspace');
  const creds = MemberCredentials.for(db, scope);
  const supplied = process.env.SEROS_SEED_PASSWORD;
  const reset = process.env.SEROS_SEED_RESET === '1';

  const shown: { member_id: string; email: string; password: string }[] = [];
  let kept = 0;

  for (const p of PEOPLE) {
    await scope.addMember(p.id, p.name, p.role);
    await creds.setEmail(p.id, p.email);

    if ((await creds.get(p.id))?.passwordHash && !reset) { kept++; continue; }

    const password = supplied ?? generatePassword();
    const problem = passwordPolicyError(password);
    if (problem) throw new Error(`SEROS_SEED_PASSWORD is not acceptable: ${problem}`);

    await creds.setPassword(p.id, await hashPassword(password));
    await scope.audit('password.set', 'ok', { member_id: p.id, method: 'seed' },
                      { actorType: 'operator', objectType: 'member', objectId: p.id });
    shown.push({ member_id: p.id, email: p.email, password: supplied ? '<SEROS_SEED_PASSWORD>' : password });
  }

  // The one and only place a seeded password is ever printed.
  if (shown.length) {
    console.log('');
    console.log('  Sign in at /login with the email or the member id, and the password below.');
    console.log('  This is the only time these are printed. They are stored only as scrypt hashes.');
    console.log('');
    for (const s of shown) console.log(`    ${s.member_id.padEnd(8)} ${s.email.padEnd(20)} ${s.password}`);
    console.log('');
  }

  console.log(JSON.stringify({
    level: 'info', event: 'seed.done', workspace: WS, members: PEOPLE.length,
    passwords_set: shown.length, passwords_kept: kept,
  }));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(JSON.stringify({ level: 'error', event: 'seed.failed', error: String(err?.message ?? err) }));
    process.exitCode = 1;
  });
}
