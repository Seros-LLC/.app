import { migrateDb } from './client';
const applied = migrateDb();
console.log(JSON.stringify({ level: 'info', event: 'migrate.done', files: applied }));
