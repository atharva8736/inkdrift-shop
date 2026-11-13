// Database layer: libSQL (Turso in production, a local SQLite file in dev/tests).
// Keeps the familiar db.prepare(sql).get/all/run(...) shape, but every call is async.
import { createClient } from '@libsql/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations/index.js';

export function openDb({ url, authToken }) {
  if (url.startsWith('file:')) fs.mkdirSync(path.dirname(path.resolve(url.slice(5))), { recursive: true });
  const client = createClient({ url, authToken: authToken || undefined });
  const als = new AsyncLocalStorage();      // statements inside db.transaction() run on that transaction
  const exec = (sql, args) => (als.getStore() ?? client).execute({ sql, args: args.map((v) => (v === undefined ? null : v)) });
  const plain = (rs) => rs.rows.map((row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]])));
  return {
    client,
    prepare: (sql) => ({
      get: async (...a) => plain(await exec(sql, a))[0],
      all: async (...a) => plain(await exec(sql, a)),
      run: async (...a) => { const r = await exec(sql, a); return { changes: r.rowsAffected }; },
    }),
    async transaction(fn) {
      if (als.getStore()) return fn();                       // already inside one: join it
      const tx = await client.transaction('write');
      try { const r = await als.run(tx, fn); await tx.commit(); return r; }
      catch (e) { try { await tx.rollback(); } catch { /* already closed */ } throw e; }
      finally { tx.close(); }
    },
    close: () => client.close(),
  };
}

export async function migrate(db) {
  const c = db.client;
  await c.execute('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = [];
  for (const m of MIGRATIONS) {
    const isDone = async () => (await c.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE name=?', args: [m.name] })).rows.length > 0;
    if (await isDone()) continue;
    try { await c.executeMultiple(m.sql); }
    catch (e) { if (await isDone()) continue; throw e; }          // another instance applied it first
    await c.execute({ sql: 'INSERT OR IGNORE INTO schema_migrations(name, applied_at) VALUES (?, ?)', args: [m.name, Date.now()] });
    applied.push(m.name);
  }
  return applied;
}

export async function audit(db, actor, action, subject, detail) {
  await db.prepare('INSERT INTO audit_log(at, actor, action, subject, detail) VALUES (?,?,?,?,?)')
    .run(Date.now(), actor, action, subject ?? null, detail === undefined ? null : JSON.stringify(detail));
}
