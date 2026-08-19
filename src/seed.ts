/** Creates the demo workspace and its people, so there is something to sign in as. */
import { migrateDb, openDb } from './db/client';
import { WorkspaceScope } from './db/scope';

const WS = process.env.SEROS_WORKSPACE || 'demo';
migrateDb();
const db = openDb();
const scope = WorkspaceScope.ensure(db, WS, 'Demo workspace');
scope.addMember('u-ana', 'Ana Okafor', 'owner');
scope.addMember('u-bo', 'Bo Lindqvist', 'confirmer');
scope.addMember('u-vic', 'Vic Reyes', 'viewer');
console.log(JSON.stringify({ level: 'info', event: 'seed.done', workspace: WS, members: 3 }));
