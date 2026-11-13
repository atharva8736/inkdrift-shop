// Builds the app once per process (one per serverless instance): config, database, migrations, catalog seed.
import { loadConfig, validateConfig, fatalProblems } from './config.js';
import { openDb, migrate } from './db.js';
import { seedCatalog } from './services/catalog.js';
import { createApp } from './app.js';

export async function prepareDb(db, { force = false } = {}) {
  const applied = await migrate(db);
  const { n } = (await db.prepare('SELECT COUNT(*) n FROM products').get()) ?? { n: 0 };
  if (force || applied.length || n < 5) await seedCatalog(db);
  return applied;
}

export async function createRuntime(env = process.env) {
  const cfg = loadConfig(env);
  const missing = fatalProblems(cfg);
  if (missing.length) {
    const e = new Error(`Server is not configured. Set: ${missing.join(', ')}`);
    e.code = 'NOT_CONFIGURED'; throw e;
  }
  const warnings = validateConfig(cfg);
  if (warnings.length) console.warn('Configuration warnings (these features are disabled):\n - ' + warnings.join('\n - '));
  const db = openDb({ url: cfg.dbUrl, authToken: cfg.dbAuthToken });
  try { await prepareDb(db); }
  catch (e) {
    // Safe diagnostics: never print secret values, only their shape.
    let host = '?'; try { host = new URL(String(cfg.dbUrl).trim().replace(/^libsql:/i, 'https:')).host; } catch { host = 'INVALID_URL'; }
    const t = String(cfg.dbAuthToken ?? '');
    console.error(`[db] connect failed: ${e.message} | urlHost=${host} | tokenLen=${t.length} | tokenParts=${t.split('.').length} | tokenHasSpace=${/\s/.test(t)} | tokenStartsEy=${t.startsWith('eyJ')}`);
    throw e;
  }
  return { cfg, db, app: createApp({ db, cfg }), warnings };
}
