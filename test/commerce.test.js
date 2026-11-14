import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, signupAndVerify, webhook } from './helpers.js';

const buy = (c, items = ['time~windows'], extra = {}, headers) => c.post('/api/orders', { items, ...extra }, headers);
const pay = async (ctx, order, patch) => { const id = (await ctx.db.prepare('SELECT provider_payment_id p FROM payments WHERE order_id=?').get(order.id)).p; ctx.gw.set(id, patch); return id; };
const hook = (ctx, order, id, extra = {}) => webhook(ctx, { event: 'OBSERVED_SUCCESS', settlementState: 'NOT_RECONCILED', orderId: order.id, amountPaise: order.amountPaise, paymentId: id, utr: '123456789012', ...extra });

test('catalog is public, ordering needs login, and totals are priced on the server', async () => {
  const ctx = await boot(); const anon = ctx.client();
  const cat = await anon.get('/api/catalog');
  assert.equal(cat.json.wallpapers.length, 20); assert.equal(cat.json.wallpapers[0].variants.length, 4); assert.equal(cat.json.products.find((p) => p.id === 'time~windows').price_paise, 39900); assert.equal(cat.json.products.some((p) => p.id === 'bundle'), false);
  assert.equal((await anon.post('/api/orders', { items: ['time~windows'] })).status, 401);
  const c = await signupAndVerify(ctx);
  const r = await c.post('/api/orders', { items: ['time~windows'], amountPaise: 1, price: 1, total: 1 });   // forged price fields are ignored
  assert.equal(r.status, 201); assert.equal(r.json.order.amountPaise, 39900);
  assert.equal(r.json.order.payment.checkoutUrl.startsWith('https://pay.example/checkout/'), true);
  assert.equal(ctx.gw.calls.find((x) => x[0] === 'create')[1].amountPaise, 39900);
  assert.equal((await c.post('/api/orders', { items: ['nope'] })).json.error.code, 'UNKNOWN_PRODUCT');
  assert.equal((await c.post('/api/orders', { items: [] })).json.error.code, 'EMPTY_CART');
  await ctx.close();
});

test('coupons apply on the server; an item already inside a bigger item is not charged twice', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const q = await c.post('/api/quote', { items: ['time~windows', 'time-2~windows', 'bundle~windows'], coupon: 'ink10' });
  assert.deepEqual(q.json.items, ['bundle~windows']); assert.equal(q.json.subtotalPaise, 99900); assert.equal(q.json.discountPaise, 9990); assert.equal(q.json.amountPaise, 89910);
  assert.equal((await c.post('/api/quote', { items: ['time~windows'], coupon: 'FAKE' })).json.error.code, 'BAD_COUPON');
  await ctx.close();
});

test('successful payment: signed webhook is confirmed with the gateway, order becomes Paid, content unlocks', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c, ['time~windows'])).json;
  assert.equal((await c.get('/api/download/time~windows')).status, 403);                        // locked before payment
  assert.equal((await c.get('/api/library')).json.files.length, 0);
  const id = await pay(ctx, order, { status: 'OBSERVED_SUCCESS', settlementState: 'NOT_RECONCILED', utr: '123456789012' });
  const w = await hook(ctx, order, id);
  assert.equal(w.status, 200); assert.equal(w.json.outcome, 'paid');
  assert.ok(ctx.gw.calls.some((x) => x[0] === 'get'), 'backend asked the gateway to confirm');
  const o = (await c.get(`/api/orders/${order.id}`)).json.order;
  assert.equal(o.status, 'paid'); assert.equal(o.payment.transactionId, id); assert.equal(o.payment.utr, '123456789012'); assert.ok(o.paidAt);
  const lib = (await c.get('/api/library')).json;
  assert.equal(lib.files.length, 5); assert.deepEqual(lib.archives.map((a) => a.productId), ['time~windows']);
  const dl = await fetch(c.base + '/api/download/time~windows', { headers: { cookie: Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'application/zip'); assert.equal((await dl.arrayBuffer()).byteLength > 1_000_000, true);
  assert.equal((await c.get('/api/download/machines~windows')).status, 403);                    // other packs stay locked
  await ctx.close();
});

test('bundle purchase unlocks the whole collection for that device; already-owned items cannot be bought again', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c, ['bundle~windows'])).json; assert.equal(order.amountPaise, 99900);
  await hook(ctx, order, await pay(ctx, order, { status: 'OBSERVED_SUCCESS' }));
  assert.equal((await c.get('/api/library')).json.files.length, 20);
  assert.equal((await buy(c, ['bundle~windows'])).json.error.code, 'ALREADY_OWNED');
  assert.equal((await buy(c, ['time~windows'])).json.error.code, 'ALREADY_OWNED');
  await ctx.close();
});

test('bad webhook signature, stale timestamp and tampered amount never unlock anything', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c)).json; const id = await pay(ctx, order, { status: 'OBSERVED_SUCCESS' });
  assert.equal((await hook(ctx, order, id, {})).status, 200);                           // sanity: valid works...
  const ctx2 = await boot(); const c2 = await signupAndVerify(ctx2); const o2 = (await buy(c2)).json.order; const id2 = await pay(ctx2, o2, { status: 'OBSERVED_SUCCESS' });
  const base = { event: 'OBSERVED_SUCCESS', orderId: o2.id, amountPaise: o2.amountPaise, paymentId: id2 };
  assert.equal((await webhook(ctx2, base, { badSig: true })).status, 401);
  assert.equal((await webhook(ctx2, base, { secret: 'wrong' })).status, 401);
  assert.equal((await webhook(ctx2, base, { ts: Date.now() - 6 * 3_600_000 })).status, 401);
  const tampered = await webhook(ctx2, { ...base, amountPaise: 100 });
  assert.equal(tampered.json.outcome, 'amount_mismatch');
  const wrongOrder = await webhook(ctx2, { ...base, orderId: 'someone-elses' });
  assert.equal(wrongOrder.json.outcome, 'order_mismatch');
  assert.equal((await ctx2.db.prepare("SELECT status FROM orders").get()).status, 'pending');
  assert.equal((await c2.get('/api/download/time~windows')).status, 403);
  await ctx.close(); await ctx2.close();
});

test('a webhook that claims success is not trusted if the gateway itself says otherwise', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c)).json; const id = await pay(ctx, order, { status: 'ACTIVE' });       // gateway: still waiting
  const w = await hook(ctx, order, id);
  assert.equal(w.status, 503);                                                          // asks the gateway to retry later
  assert.equal((await ctx.db.prepare('SELECT status FROM orders').get()).status, 'pending');
  ctx.gw.failGet = true;                                                                // gateway unreachable: also no unlock
  assert.equal((await hook(ctx, order, id)).status, 500);
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) c FROM entitlements').get()).c, 0);
  ctx.gw.failGet = false; ctx.gw.set(id, { status: 'OBSERVED_SUCCESS' });
  assert.equal((await hook(ctx, order, id)).json.outcome, 'paid');                      // a retry then succeeds
  await ctx.close();
});

test('duplicate deliveries and repeated events never double-grant or double-pay', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c)).json; const id = await pay(ctx, order, { status: 'OBSERVED_SUCCESS' });
  const first = await webhook(ctx, { event: 'OBSERVED_SUCCESS', orderId: order.id, amountPaise: order.amountPaise, paymentId: id }, { deliveryId: 'dlv-1' });
  const again = await webhook(ctx, { event: 'OBSERVED_SUCCESS', orderId: order.id, amountPaise: order.amountPaise, paymentId: id }, { deliveryId: 'dlv-1' });
  const other = await webhook(ctx, { event: 'RECONCILED', settlementState: 'RECONCILED', orderId: order.id, amountPaise: order.amountPaise, paymentId: id }, { deliveryId: 'dlv-2' });
  assert.equal(first.json.outcome, 'paid'); assert.equal(again.json.duplicate, true); assert.equal(other.json.outcome, 'already_paid');
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) c FROM entitlements').get()).c, 1);
  assert.equal((await ctx.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='order_paid'").get()).c, 1);
  await ctx.close();
});

test('failed, cancelled and expired payments leave content locked and show the right status', async () => {
  for (const [gwStatus, expected] of [['FAILED', 'failed'], ['EXPIRED', 'expired'], ['CANCELLED', 'cancelled']]) {
    const ctx = await boot(); const c = await signupAndVerify(ctx);
    const { order } = (await buy(c)).json; const id = await pay(ctx, order, { status: gwStatus });
    const w = await webhook(ctx, { event: gwStatus, orderId: order.id, amountPaise: order.amountPaise, paymentId: id });
    assert.equal(w.json.outcome, expected);
    assert.equal((await c.get(`/api/orders/${order.id}`)).json.order.status, expected);
    assert.equal((await c.get('/api/download/time~windows')).status, 403);
    await ctx.close();
  }
});

test('buyer cancels a pending payment; a fresh attempt creates a new order', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c)).json;
  const r = await c.post(`/api/orders/${order.id}/cancel`);
  assert.equal(r.json.order.status, 'cancelled'); assert.ok(ctx.gw.calls.some((x) => x[0] === 'cancel'));
  const again = await buy(c); assert.equal(again.status, 201); assert.notEqual(again.json.order.id, order.id);
  await ctx.close();
});

test('manual-review payments stay pending and never unlock', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c)).json; const id = await pay(ctx, order, { status: 'MANUAL_REVIEW' });
  const w = await webhook(ctx, { event: 'MANUAL_REVIEW', orderId: order.id, amountPaise: order.amountPaise, paymentId: id });
  assert.equal(w.json.outcome, 'pending_verification');
  assert.equal((await c.get('/api/download/time~windows')).status, 403);
  await ctx.close();
});

test('duplicate payment prevention: same cart reuses the open payment, idempotency keys replay, different carts retire the old one', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const a = (await buy(c, ['time~windows'], {}, { 'idempotency-key': 'k1' })).json.order;
  const b = await buy(c, ['time~windows'], {}, { 'idempotency-key': 'k1' });
  assert.equal(b.json.order.id, a.id); assert.equal(b.json.reused, true);
  assert.equal((await buy(c, ['machines~windows'], {}, { 'idempotency-key': 'k1' })).json.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await buy(c, ['time~windows'])).json.order.id, a.id);                          // double-click: same order, no second charge
  assert.equal(ctx.gw.calls.filter((x) => x[0] === 'create').length, 1);
  const other = (await buy(c, ['machines~windows'])).json.order;
  assert.notEqual(other.id, a.id);
  assert.equal((await ctx.db.prepare('SELECT status FROM orders WHERE id=?').get(a.id)).status, 'cancelled');
  await ctx.close();
});

test('if the gateway is down at checkout the order is marked failed and the user sees a clear error', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  ctx.gw.createPayment = async () => { const { HttpError } = await import('../src/lib/http.js'); throw new HttpError(502, 'GATEWAY_UNREACHABLE', 'The payment service is unreachable. Please try again shortly.'); };
  const r = await buy(c); assert.equal(r.status, 502);
  assert.equal((await ctx.db.prepare('SELECT status FROM orders').get()).status, 'failed');
  await ctx.close();
});

test('missed webhook: polling the order confirms payment with the gateway and unlocks', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c)).json;
  assert.equal((await c.get(`/api/orders/${order.id}`)).json.order.status, 'pending');
  await pay(ctx, order, { status: 'OBSERVED_SUCCESS', utr: '999999999999' });
  await ctx.db.prepare('UPDATE payments SET last_checked_at=0').run();
  const o = (await c.get(`/api/orders/${order.id}`)).json.order;
  assert.equal(o.status, 'paid'); assert.equal((await c.get('/api/library')).json.archives.length, 1);
  await ctx.close();
});

test('a late payment arriving after the order expired still unlocks it', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c)).json; const id = await pay(ctx, order, { status: 'EXPIRED' });
  await webhook(ctx, { event: 'EXPIRED', orderId: order.id, amountPaise: order.amountPaise, paymentId: id });
  ctx.gw.set(id, { status: 'OBSERVED_SUCCESS' });
  const w = await hook(ctx, order, id); assert.equal(w.json.outcome, 'paid');
  await ctx.close();
});

test("policy 'reconciled' refuses bank-alert matches and only unlocks after statement reconciliation", async () => {
  const ctx = await boot({ cfg: { youpi: { unlockPolicy: 'reconciled' } } }); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c)).json; const id = await pay(ctx, order, { status: 'OBSERVED_SUCCESS', settlementState: 'NOT_RECONCILED' });
  assert.equal((await hook(ctx, order, id)).json.outcome, 'no_change');
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) c FROM entitlements').get()).c, 0);
  ctx.gw.set(id, { status: 'RECONCILED', settlementState: 'RECONCILED' });
  assert.equal((await hook(ctx, order, id, { event: 'RECONCILED', settlementState: 'RECONCILED' })).json.outcome, 'paid');
  await ctx.close();
});

test('cash-on-delivery or counter payments can never unlock a download', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c)).json; const id = await pay(ctx, order, { status: 'SUCCESS', method: 'COD', settlementState: 'NOT_BANK_SETTLEMENT' });
  const w = await webhook(ctx, { event: 'SUCCESS', orderId: order.id, amountPaise: order.amountPaise, paymentId: id });
  assert.equal(w.status, 200);   // acknowledged, but never unlocks
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) c FROM entitlements').get()).c, 0);
  await ctx.close();
});

test('users only see their own orders and files; purchase history carries every required field', async () => {
  const ctx = await boot(); const a = await signupAndVerify(ctx, 'Asha', 'asha@example.com'); const b = await signupAndVerify(ctx, 'Bo', 'bo@example.com');
  const { order } = (await buy(a, ['time~windows'], { coupon: 'INK10' })).json;
  await hook(ctx, order, await pay(ctx, order, { status: 'OBSERVED_SUCCESS' }));
  assert.equal((await b.get(`/api/orders/${order.id}`)).status, 404);
  assert.equal((await b.get('/api/download/time~windows')).status, 403);
  assert.equal((await b.get('/api/orders')).json.orders.length, 0);
  const h = (await a.get('/api/orders')).json.orders[0];
  assert.equal(h.items[0].productId, 'time~windows'); assert.equal(h.items[0].name, 'Vol. II · Time · Windows'); assert.equal(h.amountPaise, 35910);
  assert.equal(h.status, 'paid'); assert.ok(h.payment.transactionId); assert.ok(h.createdAt); assert.ok(h.paidAt);
  assert.ok(!('checkoutUrl' in h.payment) || h.payment.checkoutUrl === undefined);
  await ctx.close();
});

test('purchases and sessions persist across a restart of the app (same database)', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c)).json; await hook(ctx, order, await pay(ctx, order, { status: 'OBSERVED_SUCCESS' }));
  const { createApp } = await import('../src/app.js'); const http = await import('node:http');
  const app2 = createApp({ db: ctx.db, cfg: ctx.cfg, emailTransport: async () => {}, youpiClient: ctx.gw });
  const s2 = await new Promise((r) => { const s = http.createServer(app2).listen(0, () => r(s)); });
  const c2 = ctx.client(); c2.base = `http://127.0.0.1:${s2.address().port}`; c2.jar = { ...c.jar };
  assert.equal((await c2.get('/api/library')).json.archives[0].productId, 'time~windows');
  s2.closeAllConnections(); s2.close(); await ctx.close();
});
