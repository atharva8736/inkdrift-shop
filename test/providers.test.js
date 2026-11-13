import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from "node:os";
import path from "node:path";
import { boot, stubServer, signupAndVerify } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { createEmailService } from '../src/services/email.js';
import { createYoupiClient } from '../src/services/youpi.js';
import { openDb, migrate } from '../src/db.js';

test('Resend transport makes a real authenticated API call carrying the OTP', async () => {
  const stub = await stubServer(() => ({ json: { id: 'em_1' } }));
  const cfg = loadConfig({ SESSION_SECRET: 'x'.repeat(40) }, { email: { apiKey: 're_secret', from: 'Inkdrift <hi@example.com>', apiUrl: stub.url + '/emails' } });
  await createEmailService(cfg).sendOtp({ to: 'a@x.com', name: 'A<b>', code: '482913', ttlMinutes: 5 });
  const r = stub.requests[0];
  assert.equal(r.method, 'POST'); assert.equal(r.headers.authorization, 'Bearer re_secret');
  const body = JSON.parse(r.body); assert.deepEqual(body.to, ['a@x.com']); assert.match(body.text, /482913/); assert.match(body.html, /A&lt;b&gt;/);   // name is HTML-escaped
  await stub.close();
});

test('Resend failure surfaces as a clean 502 to the caller', async () => {
  const stub = await stubServer(() => ({ status: 403, json: { message: 'domain not verified' } }));
  const cfg = loadConfig({ SESSION_SECRET: 'x'.repeat(40) }, { email: { apiKey: 'k', from: 'a@b.c', apiUrl: stub.url } });
  await assert.rejects(createEmailService(cfg).sendOtp({ to: 'a@x.com', name: 'A', code: '123456', ttlMinutes: 5 }), (e) => e.status === 502 && e.code === 'EMAIL_SEND_FAILED');
  await stub.close();
});

test('YOUPI client sends merchant id/key server-side, an idempotency key and the exact amount', async () => {
  const stub = await stubServer((r) => r.method === 'POST' && r.url.endsWith('/payments') ? { status: 201, json: { paymentId: 'p1', checkoutUrl: 'https://c/1', status: 'INITIATED' } } : { json: { status: 'ACTIVE' } });
  const cfg = loadConfig({ SESSION_SECRET: 'x'.repeat(40) }, { youpi: { apiUrl: stub.url, merchantId: 'merch-1', apiKey: 'sekret', webhookSecret: 'w' } });
  const y = createYoupiClient(cfg);
  const out = await y.createPayment({ orderId: 'o-1', amountPaise: 39900, customer: { name: 'A', email: 'a@x.com' }, returnUrl: 'https://s/?order=o-1#done' });
  assert.equal(out.paymentId, 'p1');
  const r = stub.requests[0];
  assert.equal(r.headers['x-merchant-id'], 'merch-1'); assert.equal(r.headers['x-merchant-key'], 'sekret'); assert.equal(r.headers['idempotency-key'], 'inkdrift-o-1');
  assert.equal(JSON.parse(r.body).amount, '399.00'); assert.equal(JSON.parse(r.body).currency, 'INR');
  await y.getPayment('p1'); assert.equal(stub.requests[1].url, '/api/v1/payments/p1');
  await y.cancelPayment('p1'); assert.equal(stub.requests[2].url, '/api/v1/checkout/p1/cancel');
  await stub.close();
});

test('YOUPI client maps a busy gateway (409) and an unreachable gateway to clear errors', async () => {
  const stub = await stubServer(() => ({ status: 409, json: { error: 'duplicate' } }));
  const cfg = loadConfig({ SESSION_SECRET: 'x'.repeat(40) }, { youpi: { apiUrl: stub.url, merchantId: 'm', apiKey: 'k', webhookSecret: 'w', timeoutMs: 500 } });
  await assert.rejects(createYoupiClient(cfg).createPayment({ orderId: 'o', amountPaise: 100 }), (e) => e.code === 'GATEWAY_BUSY');
  await stub.close();
  await assert.rejects(createYoupiClient(cfg).getPayment('x'), (e) => e.code === 'GATEWAY_UNREACHABLE');
});

test('migrations are idempotent and the seed never overwrites a price you changed', async () => {
  const db = openDb({ url: `file:${path.join(os.tmpdir(), 'ink-mig-' + Date.now() + '.sqlite')}` }); assert.equal((await migrate(db)).length, 1); assert.equal((await migrate(db)).length, 0);
  const { seedCatalog } = await import('../src/services/catalog.js'); await seedCatalog(db);
  await db.prepare("UPDATE products SET price_paise=49900 WHERE id='time'").run(); await seedCatalog(db);
  assert.equal((await db.prepare("SELECT price_paise p FROM products WHERE id='time'").get()).p, 49900);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM wallpapers').get()).c, 20);
});

test('config validation flags missing production secrets', async () => {
  const { validateConfig } = await import('../src/config.js');
  const bad = validateConfig(loadConfig({ NODE_ENV: 'production', APP_URL: 'http://x' }));
  assert.ok(bad.length >= 3);
  const { fatalProblems } = await import('../src/config.js');
  assert.ok(fatalProblems(loadConfig({ NODE_ENV: 'production', APP_URL: 'http://x' })).length >= 3);
  assert.equal(fatalProblems(loadConfig({ NODE_ENV: 'production', APP_URL: 'https://x.com', SESSION_SECRET: 'y'.repeat(40), DATABASE_URL: 'libsql://x.turso.io', DATABASE_AUTH_TOKEN: 't' })).length, 0);
  assert.equal(validateConfig(loadConfig({ NODE_ENV: 'production', APP_URL: 'https://x.com', SESSION_SECRET: 'y'.repeat(40), RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c', YOUPI_API_URL: 'https://p', YOUPI_MERCHANT_ID: 'm', YOUPI_MERCHANT_API_KEY: 'k', YOUPI_WEBHOOK_SECRET: 's', DATABASE_URL: 'libsql://x.turso.io', DATABASE_AUTH_TOKEN: 't' })).length, 0);
});

test('Brevo transport posts the documented request (sender parsed from EMAIL_FROM, api-key header)', async () => {
  const { brevoTransport } = await import('../src/services/email.js');
  const stub = await stubServer(() => ({ status: 201, json: { messageId: 'm1' } }));
  const cfg = loadConfig({ BREVO_API_KEY: 'xkeysib-test', EMAIL_FROM: 'Inkdrift <hello@example.com>', EMAIL_API_URL: stub.url + '/v3/smtp/email' });
  assert.equal(cfg.email.provider, 'brevo');
  await brevoTransport(cfg)({ to: 'buyer@x.com', subject: 'S', html: '<b>h</b>', text: 't' });
  const req = stub.requests[0], body = JSON.parse(req.body);
  assert.equal(req.headers['api-key'], 'xkeysib-test');
  assert.deepEqual(body.sender, { name: 'Inkdrift', email: 'hello@example.com' });
  assert.deepEqual(body.to, [{ email: 'buyer@x.com' }]); assert.equal(body.htmlContent, '<b>h</b>');
  await stub.close();
});
