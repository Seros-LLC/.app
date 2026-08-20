/**
 * src/auth-cli.ts - credentials from the command line (`npm run set-password`,
 * `npm run invite`). Everything here goes through the same MemberCredentials the
 * web routes use, so the same rules apply: scrypt with per-user salt, invites
 * stored only as a hash, and an audit row for every change.
 *
 * A password or a token is printed exactly once, to stdout, and is never logged.
 */
import crypto from 'node:crypto';
import { migrateDbAsync, openDb } from './db/client';
import { WorkspaceScope } from './db/scope';
import {
  MemberCredentials, hashPassword, passwordPolicyError, newInviteToken, inviteTtlMs,
} from './password';

const WS = process.env.SEROS_WORKSPACE || 'demo';

const USAGE = `usage:
  npm run set-password -- <memberId> [password]   set or replace a password (generated if omitted)
  npm run invite       -- <memberId>              issue a single-use, expiring invite link
  npm run auth         -- unlock <memberId>       clear a lockout without touching the password
  npm run auth         -- email <memberId> <addr> set the address that member signs in with
  npm run auth         -- status [memberId]       who has a credential (no hashes, no tokens)`;

const generate = () => crypto.randomBytes(12).toString('base64url');

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); return; }

  // await, not migrateDb(): on Postgres the migration is a promise, and a CLI that
  // does not wait for it opens a handle against tables that may not be there yet.
  await migrateDbAsync();
  const db = openDb();
  const scope = await WorkspaceScope.open(db, WS);
  const creds = MemberCredentials.for(db, scope);

  const need = async (id: string | undefined) => {
    const m = id ? await scope.member(id) : undefined;
    if (!m) { console.error(JSON.stringify({ level: 'error', event: 'auth.cli_failed', reason: 'no_such_member' })); process.exit(2); }
    return m;
  };

  switch (cmd) {
    case 'set-password': {
      const m = await need(a);
      const password = b ?? process.env.SEROS_NEW_PASSWORD ?? generate();
      const problem = passwordPolicyError(password);
      if (problem) { console.error(problem); process.exit(2); }
      await creds.setPassword(m.id, await hashPassword(password));
      await scope.audit('password.set', 'ok', { member_id: m.id, method: 'cli' },
                        { actorType: 'operator', objectType: 'member', objectId: m.id });
      if (!b && !process.env.SEROS_NEW_PASSWORD) {
        console.log(`\n  ${m.id}  ${password}\n\n  Printed once. Stored only as a scrypt hash.\n`);
      }
      console.log(JSON.stringify({ level: 'info', event: 'password.set', workspace: WS, member_id: m.id }));
      return;
    }
    case 'invite': {
      const m = await need(a);
      const { token, hash } = newInviteToken();
      const expiresAt = await creds.issueInvite(m.id, hash);
      await scope.audit('invite.issued', 'ok', { member_id: m.id, expires_at: expiresAt },
                        { actorType: 'operator', objectType: 'member', objectId: m.id });
      console.log(`\n  /set-password?token=${token}\n\n  Single use. Expires ${new Date(expiresAt).toISOString()} (${Math.round(inviteTtlMs() / 3_600_000)}h).\n  Printed once; only its SHA-256 is stored.\n`);
      console.log(JSON.stringify({ level: 'info', event: 'invite.issued', workspace: WS, member_id: m.id, expires_at: expiresAt }));
      return;
    }
    case 'unlock': {
      const m = await need(a);
      await creds.clearLock(m.id);
      await scope.audit('lockout.cleared', 'ok', { member_id: m.id },
                        { actorType: 'operator', objectType: 'member', objectId: m.id });
      console.log(JSON.stringify({ level: 'info', event: 'lockout.cleared', workspace: WS, member_id: m.id }));
      return;
    }
    case 'email': {
      const m = await need(a);
      await creds.setEmail(m.id, String(b));
      await scope.audit('member.identifier_set', 'ok', { member_id: m.id },
                        { actorType: 'operator', objectType: 'member', objectId: m.id });
      console.log(JSON.stringify({ level: 'info', event: 'member.identifier_set', workspace: WS, member_id: m.id }));
      return;
    }
    case 'status': {
      const ids = a ? [(await need(a)).id] : (await scope.rosterWithRoles()).map((m) => m.id);
      for (const id of ids) console.log(JSON.stringify({ workspace: WS, ...(await creds.status(id)) }));
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'error', event: 'auth.cli_failed', error: String(err?.message ?? err) }));
  process.exitCode = 1;
});
