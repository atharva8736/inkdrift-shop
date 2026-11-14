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
