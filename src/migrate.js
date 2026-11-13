import { loadConfig } from './config.js';
import { openDb, migrate } from './db.js';
import { seedCatalog } from './services/catalog.js';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const applied = migrate(db);
seedCatalog(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database already up to date.');
console.log('Catalog ensured (existing prices are never overwritten).');
