import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { prepareDb } from './runtime.js';

const cfg = loadConfig();
const db = openDb({ url: cfg.dbUrl, authToken: cfg.dbAuthToken });
const applied = await prepareDb(db, { force: true });
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database already up to date.');
console.log('Catalog ensured (existing prices are never overwritten).');
db.close();
