/**
 * M5: tenancy was structural inside WorkspaceScope and a convention everywhere else.
 * A scope you can walk around is a naming convention with extra steps.
 *
 * This fails the build if any module outside the allowlist imports a tenant-owned
 * table declaration. Everything else must go through WorkspaceScope, which cannot be
 * built without a workspace and injects the id into every query itself.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const TENANT_TABLES = [
  'members', 'memberCredentials', 'sourceMessages', 'drafts', 'confirmations', 'tasks',
  'auditEvents', 'actionMeter', 'jobs', 'taskWrites', 'oauthProviders',
  'sourceConnections', 'sourceChannels',
];

/** Files that are allowed to name a tenant table, and why. */
const ALLOWED = new Map<string, string>([
  ['src/db/scope.ts', 'the scope itself: the one legitimate door'],
  ['src/db/system.ts', 'the queue poller: the single audited cross-tenant path'],
  ['src/db/schema.ts', 'the declarations'],
  ['src/password.ts', 'the credential store: MemberCredentials cannot be constructed without a workspace scope and injects the workspace id into every statement, exactly as WorkspaceScope does'],
  ['src/retention.ts', 'the sweeper: deletes across tables by design, opens a scope first'],
  ['src/limits.ts', 'growth limits and draft expiry: opens a scope first'],
  ['src/provider/meter.ts', 'the meter writer itself: it is the authority for action_meter, and it is constructed per workspace via dbMeterContext(db, workspaceId)'],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const offenders: string[] = [];
for (const file of walk(join(ROOT, 'src'))) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (ALLOWED.has(rel)) continue;
  const src = readFileSync(file, 'utf8');
  const imports = [...src.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"][^'"]*db\/schema['"]/g)];
  for (const m of imports) {
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0]!.trim();
      if (TENANT_TABLES.includes(name)) offenders.push(`${rel} imports tenant table '${name}'`);
    }
  }
}

if (offenders.length) {
  console.error('TENANCY CHECK FAILED - these modules reach past WorkspaceScope:');
  for (const o of offenders) console.error('  ' + o);
  console.error('\nEither route the query through WorkspaceScope, or add the file to ALLOWED in tools/check-tenancy.ts with a reason.');
  process.exit(1);
}
console.log(JSON.stringify({ level: 'info', event: 'tenancy.check_ok', allowed: [...ALLOWED.keys()] }));
