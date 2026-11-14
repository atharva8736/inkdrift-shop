import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, signupAndVerify } from './helpers.js';

const cfg = { upi: { id: 'shop@okhdfcbank', payeeName: 'Inkdrift' }, adminEmails: ['owner@example.com'], youpi: { apiUrl: '' } };
const buy = (c, items = ['old-money-1~iphone']) => c.post('/api/orders', { items });

test('manual UPI: order shows your UPI ID, QR and exact amount; no gateway call is made', async () => {
  const ctx = await boot({ cfg }); const c = await signupAndVerify(ctx);
  const r = await buy(c);
  assert.equal(r.status, 201);
  const p = r.json.order.payment;
  assert.equal(p.manual, true); assert.equal(p.upi.upiId, 'shop@okhdfcbank'); assert.equal(p.upi.amount, '99.00');
  assert.match(p.upi.link, /^upi:\/\/pay\?pa=shop%40okhdfcbank&pn=Inkdrift&am=99\.00&cu=INR/); assert.match(p.upi.qrSvg, /^<svg/);
  assert.equal(ctx.gw.calls.length, 0);
  assert.equal((await buy(c)).json.order.id, r.json.order.id, 'same cart reuses the open order');
  await ctx.close();
});

test('manual UPI: UTR is validated, unique, and nothing unlocks until the admin approves', async () => {
  const ctx = await boot({ cfg }); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c)).json;
  assert.equal((await c.post(`/api/orders/${order.id}/utr`, { utr: '123' })).json.error.code, 'BAD_UTR');
  const ok = await c.post(`/api/orders/${order.id}/utr`, { utr: '4123 4567 8901' });
  assert.equal(ok.status, 200); assert.equal(ok.json.order.status, 'pending_verification'); assert.equal(ok.json.order.payment.utr, '412345678901');
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) c FROM entitlements').get()).c, 0);
  assert.equal((await c.get(`/api/download/${'old-money-1~iphone'}`)).status, 403);
  // a second customer cannot reuse the same UTR
  const b = await signupAndVerify(ctx, 'Bo', 'bo@example.com'); const o2 = (await buy(b, ['old-money-2~iphone'])).json.order;
  assert.equal((await b.post(`/api/orders/${o2.id}/utr`, { utr: '412345678901' })).json.error.code, 'UTR_USED');
  await ctx.close();
});

test('manual UPI: only an admin can approve; approval unlocks the download; reject closes the order', async () => {
  const ctx = await boot({ cfg }); const c = await signupAndVerify(ctx);
  const { order } = (await buy(c)).json; await c.post(`/api/orders/${order.id}/utr`, { utr: '412345678901' });
  assert.equal((await c.get('/api/admin/orders')).status, 403);
  assert.equal((await c.post(`/api/admin/orders/${order.id}/approve`)).status, 403);
  assert.equal((await c.get('/api/me')).json.isAdmin, false);
  const a = await signupAndVerify(ctx, 'Owner', 'owner@example.com');
  assert.equal((await a.get('/api/me')).json.isAdmin, true);
  const list = (await a.get('/api/admin/orders')).json.orders;
  assert.equal(list[0].utr, '412345678901'); assert.equal(list[0].amountPaise, 9900);
  assert.equal((await a.post(`/api/admin/orders/${order.id}/approve`)).json.status, 'paid');
  assert.equal((await a.post(`/api/admin/orders/${order.id}/approve`)).json.already, true);
  assert.equal((await c.get(`/api/orders/${order.id}`)).json.order.status, 'paid');
  const dl = await c.get('/api/download/old-money-1~iphone'); assert.equal(dl.status, 200);
  const o2 = (await buy(c, ['old-money-2~android'])).json.order; await c.post(`/api/orders/${o2.id}/utr`, { utr: '999999999999' });
  assert.equal((await a.post(`/api/admin/orders/${o2.id}/reject`)).json.status, 'failed');
  assert.equal((await c.get('/api/download/old-money-2~android')).status, 403);
  await ctx.close();
});

test('manual UPI: approval needs a UTR and the customer cannot cancel after submitting', async () => {
  const ctx = await boot({ cfg }); const c = await signupAndVerify(ctx); const a = await signupAndVerify(ctx, 'Owner', 'owner@example.com');
  const { order } = (await buy(c)).json;
  assert.equal((await a.post(`/api/admin/orders/${order.id}/approve`)).json.error.code, 'NO_UTR');
  await c.post(`/api/orders/${order.id}/utr`, { utr: '412345678901' });
  assert.equal((await c.post(`/api/orders/${order.id}/cancel`)).json.error.code, 'UNDER_REVIEW');
  await ctx.close();
});

test('manual UPI: unpaid orders expire, unchecked UTRs expire later, expired ones cannot take a new UTR but the admin can still approve a real payment', async () => {
  const ctx = await boot({ cfg }); const c = await signupAndVerify(ctx); const a = await signupAndVerify(ctx, 'Owner', 'owner@example.com');
  const old = Date.now() - 2 * 3_600_000;
  // 1) never paid: expires after the pay window; the customer's page shows it
  const o1 = (await buy(c)).json.order;
  await ctx.db.prepare('UPDATE orders SET created_at=? WHERE id=?').run(old, o1.id);
  const seen = (await c.get(`/api/orders/${o1.id}`)).json.order;
  assert.equal(seen.status, 'expired');
  assert.equal((await c.post(`/api/orders/${o1.id}/utr`, { utr: '111111111111' })).json.error.code, 'ORDER_CLOSED');
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) c FROM entitlements').get()).c, 0);
  // 2) UTR submitted but not checked for longer than the deadline: expires, then a late approval still works
  const o2 = (await buy(c, ['old-money-2~iphone'])).json.order; await c.post(`/api/orders/${o2.id}/utr`, { utr: '222222222222' });
  assert.equal((await c.get(`/api/orders/${o2.id}`)).json.order.status, 'pending_verification', 'inside the deadline it stays pending');
  await ctx.db.prepare('UPDATE orders SET updated_at=? WHERE id=?').run(Date.now() - 49 * 3_600_000, o2.id);
  const list = (await a.get('/api/admin/orders')).json;
  const row = list.orders.find((o) => o.id === o2.id);
  assert.equal(row.status, 'expired'); assert.equal(row.utr, '222222222222'); assert.equal(row.verification, 'Deadline passed');
  assert.equal(list.deadlines.payMinutes, 60); assert.equal(list.deadlines.verifyHours, 48);
  assert.equal((await a.post(`/api/admin/orders/${o2.id}/approve`)).json.status, 'paid');
  assert.equal((await c.get(`/api/orders/${o2.id}`)).json.order.status, 'paid', 'a refresh shows the true status');
  assert.equal((await c.get('/api/download/old-money-2~iphone')).status, 200);
  await ctx.close();
});

test('manual UPI: admin list carries every field and totals; customers still see the right status after a refresh', async () => {
  const ctx = await boot({ cfg }); const c = await signupAndVerify(ctx); const a = await signupAndVerify(ctx, 'Owner', 'owner@example.com');
  const o = (await buy(c)).json.order; await c.post(`/api/orders/${o.id}/utr`, { utr: '333333333333' });
  const before = (await a.get('/api/admin/orders')).json;
  assert.equal(before.totals.awaitingPaise, 9900); assert.equal(before.totals.verifiedPaise, 0);
  const r = before.orders[0];
  for (const k of ['id', 'status', 'amountPaise', 'createdAt', 'utr', 'utrSubmittedAt', 'email', 'name', 'items', 'verification', 'ref']) assert.ok(r[k] !== undefined && r[k] !== null, k);
  await a.post(`/api/admin/orders/${o.id}/approve`);
  const after = (await a.get('/api/admin/orders')).json;
  assert.equal(after.totals.verifiedPaise, 9900); assert.ok(after.orders[0].verifiedAt);
  assert.equal((await c.get(`/api/orders/${o.id}`)).json.order.status, 'paid');
  await ctx.close();
});
