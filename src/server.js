import { loadConfig, validateConfig } from './config.js';
import { openDb, migrate } from './db.js';
import { seedCatalog } from './services/catalog.js';
import { createApp } from './app.js';
import { purgeSessions } from './services/sessions.js';

const cfg = loadConfig();
const problems = validateConfig(cfg);
if (problems.length) {
  console.error('Configuration problems:\n - ' + problems.join('\n - '));
  if (cfg.env === 'production') process.exit(1);
  console.error('(continuing because NODE_ENV is not production; features that need these will return errors)');
}
const db = openDb(cfg.dbPath);
migrate(db); seedCatalog(db);
setInterval(() => purgeSessions(db), 3_600_000).unref();
createApp({ db, cfg }).listen(cfg.port, () => console.log(`Inkdrift listening on ${cfg.appUrl} (port ${cfg.port})`));
