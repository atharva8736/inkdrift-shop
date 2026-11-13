// Small operator CLI.  npm run admin -- orders | order <id> | revoke <orderId> | restore <orderId> | disable <email>
import { loadConfig } from './config.js';
import { openDb, migrate, audit } from './db.js';
const [cmd, arg] = process.argv.slice(2);
const cfg = loadConfig();
const db = openDb({ url: cfg.dbUrl, authToken: cfg.dbAuthToken }); await migrate(db);
const money = (p) => `₹${(p / 100).toFixed(2)}`;
if (cmd === 'orders') {
  for (const o of await db.prepare(`SELECT o.id,o.status,o.amount_paise,o.created_at,u.email,p.provider_payment_id,p.utr FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN payments p ON p.order_id=o.id ORDER BY o.created_at DESC LIMIT 50`).all())
    console.log(`${new Date(o.created_at).toISOString()}  ${o.status.padEnd(20)} ${money(o.amount_paise).padStart(10)}  ${o.email}  order=${o.id}  txn=${o.provider_payment_id ?? '-'}  utr=${o.utr ?? '-'}`);
} else if (cmd === 'revoke' && arg) {      // use when the bank shows the money never arrived
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').get(arg); if (!o) throw new Error('No such order');
  await db.prepare("UPDATE entitlements SET revoked_at=? WHERE order_id=? AND revoked_at IS NULL").run(Date.now(), arg);
  await db.prepare("UPDATE orders SET status='failed', updated_at=? WHERE id=?").run(Date.now(), arg);
  await audit(db, 'operator', 'revoke_order', arg); console.log('Access revoked and order marked failed.');
} else if (cmd === 'disable' && arg) {
  await db.prepare("UPDATE users SET status='disabled' WHERE email=?").run(arg.toLowerCase());
  await db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email=?)').run(arg.toLowerCase());
  await audit(db, 'operator', 'disable_user', arg); console.log('User disabled.');
} else console.log('Usage: npm run admin -- orders | revoke <orderId> | disable <email>');
db.close();
