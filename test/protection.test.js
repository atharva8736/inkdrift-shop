import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, signupAndVerify, webhook } from './helpers.js';

const buy = (c, items = ['time']) => c.post('/api/orders', { items });
const pay = async (ctx, order, patch) => { const id = (await ctx.db.prepare('SELECT provider_payment_id p FROM payments WHERE order_id=?').get(order.id)).p; ctx.gw.set(id, patch); return id; };
const hook = (ctx, order, id) => webhook(ctx, { event: 'OBSERVED_SUCCESS', settlementState: 'NOT_RECONCILED', orderId: order.id, amountPaise: order.amountPaise, paymentId: id, utr: '123456789012' });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cookie = (c) => Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ');

test('public previews are watermarked, small, and never byte-identical to the clean sources', () => {
  const src = path.join(root, 'private/preview-src'), pub = path.join(root, 'public/img');
  const names = fs.readdirSync(src).filter((f) => f.endsWith('.jpg'));
  assert.equal(names.length, 40);
  for (const n of names) {
    const a = fs.readFileSync(path.join(src, n)), b = fs.readFileSync(path.join(pub, n));
    assert.notDeepEqual(a, b, `${n} must not be served clean`);
    assert.ok(b.length < a.length * 1.2, `${n} preview must stay low-resolution/compressed`);
  }
});

test('visitors and non-buyers cannot reach clean previews or originals', async () => {
  const ctx = await boot();
  const anon = await fetch(ctx.base + '/api/preview/time/1');
  assert.equal(anon.status, 401);
  const c = await signupAndVerify(ctx);
  assert.equal((await c.get('/api/preview/time/1')).status, 403);
  assert.equal((await c.get('/api/preview/time/1?m=phone')).status, 403);
  assert.equal((await c.get('/api/download/time')).status, 403);
  assert.equal((await c.get('/api/preview/time/9')).status, 404);
  // public catalog only lists the watermarked /img files, never a clean path
  const cat = (await c.get('/api/catalog')).json;
  assert.ok(JSON.stringify(cat).includes('img/d_Vol2_01.jpg'));
  assert.ok(!JSON.stringify(cat).includes('preview-src') && !JSON.stringify(cat).includes('.zip'));
  await ctx.close();
});

test('after server-verified payment the buyer gets clean previews and the original; others still do not', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c, ['time'])).json;
  const id = await pay(ctx, order, { status: 'OBSERVED_SUCCESS', settlementState: 'NOT_RECONCILED', utr: '123456789012' });
  assert.equal((await hook(ctx, order, id)).status, 200);
  const r = await fetch(ctx.base + '/api/preview/time/2', { headers: { cookie: cookie(c) } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.match(r.headers.get('cache-control'), /no-store/);
  const clean = Buffer.from(await r.arrayBuffer());
  assert.deepEqual(clean, fs.readFileSync(path.join(root, 'private/preview-src/d_Vol2_02.jpg')));
  const lib = (await c.get('/api/library')).json.packs[0];
  assert.equal(lib.wallpapers[1].clean_desktop, '/api/preview/time/2');
  assert.equal((await c.get('/api/preview/machines/1')).status, 403);          // other packs stay locked
  const other = await signupAndVerify(ctx, 'Ravi Kumar', 'other@example.com');
  assert.equal((await other.get('/api/preview/time/2')).status, 403);         // another customer cannot reach it
  assert.equal((await other.get('/api/download/time')).status, 403);
  await ctx.close();
});
