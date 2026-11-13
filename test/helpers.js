import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db.js';
import { seedCatalog } from '../src/services/catalog.js';
import { createApp } from '../src/app.js';

export const SECRET = 'whsec_test_secret';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-process stand-in for the YOUPI API so tests control every gateway state.
export function fakeGateway() {
  const payments = new Map(); let n = 0; const calls = [];
  return {
    payments, calls,
    async createPayment(p) { calls.push(['create', p]); const id = `pay_${++n}`;
      payments.set(id, { paymentId: id, orderId: p.orderId, amountPaise: p.amountPaise, amount: (p.amountPaise / 100).toFixed(2), status: 'INITIATED', method: 'UPI' });
      return { paymentId: id, orderId: p.orderId, status: 'INITIATED', checkoutUrl: `https://pay.example/checkout/${id}` }; },
    async getPayment(id) { calls.push(['get', id]); if (this.failGet) throw new Error('down'); const p = payments.get(id); if (!p) throw new Error('404'); return { ...p }; },
    async cancelPayment(id) { calls.push(['cancel', id]); const p = payments.get(id); if (p) p.status = 'CANCELLED'; return { success: true }; },
    set(id, patch) { Object.assign(payments.get(id), patch); },
  };
}

export async function boot({ cfg: over = {}, failEmail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-'));
  for (const f of ['Inkdrift_Vol1_Old_Money', 'Inkdrift_Vol2_Time', 'Inkdrift_Vol3_Machines', 'Inkdrift_Vol4_Late_Nights']) fs.writeFileSync(path.join(dir, f + '.zip'), `ZIPDATA:${f}`);
  const overrides = {
    email: { apiKey: 'k', from: 'Inkdrift <no-reply@example.com>' },
    youpi: { apiUrl: 'https://pay.example', merchantId: 'm1', apiKey: 'mk', webhookSecret: SECRET },
    otp: { resendCooldownMs: 100 },
  };
  for (const [k, v] of Object.entries(over)) overrides[k] = typeof v === "object" ? { ...overrides[k], ...v } : v;
  const cfg = loadConfig({ SESSION_SECRET: 'x'.repeat(48), APP_URL: 'http://localhost:3000', PUBLIC_DIR: dir, PACKS_DIR: dir, PACK_STORAGE: "disk" }, overrides);
  const db = openDb({ url: `file:${path.join(dir, 'test.sqlite')}` }); await migrate(db); await seedCatalog(db);
  const mailbox = [];
  const emailTransport = async (m) => { if (mailbox.failNext || failEmail) { mailbox.failNext = false; throw new Error('smtp down'); } mailbox.push(m); };
  const gw = fakeGateway();
  const app = createApp({ db, cfg, emailTransport, youpiClient: gw });
  const server = await new Promise((r) => { const s = http.createServer(app).listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, cfg, mailbox, gw, base, dir, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }), client: () => new Client(base) };
}

export class Client {
  constructor(base) { this.base = base; this.jar = {}; this.csrf = null; }
  async req(method, url, body, headers = {}) {
    const res = await fetch(this.base + url, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(';'); const [k, ...v] = pair.split('=');
      const gone = attrs.some((a) => /expires=.*1970/i.test(a) || /max-age=0/i.test(a));
      if (gone) delete this.jar[k.trim()]; else this.jar[k.trim()] = v.join('=');
    }
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    if (json?.csrfToken) this.csrf = json.csrfToken;
    return { status: res.status, json, text, headers: res.headers };
  }
  get(u, h) { return this.req('GET', u, undefined, h); }
  post(u, b = {}, h) { return this.req('POST', u, b, h); }
}

export const lastCode = (mailbox) => mailbox.at(-1).text.match(/code is (\d{6})/)[1];

export async function signupAndVerify(ctx, name = 'Asha Rao', email = 'asha@example.com', password = 'correct-horse-9') {
  const c = ctx.client();
  const s = await c.post('/api/auth/signup', { name, email, password });
  if (s.status !== 201) throw new Error('signup failed ' + s.text);
  const v = await c.post('/api/auth/verify-otp', { email, code: lastCode(ctx.mailbox) });
  if (v.status !== 200) throw new Error('verify failed ' + v.text);
  return c;
}

// Sends a correctly signed webhook the way the gateway would.
export function webhook(ctx, payload, { secret = SECRET, deliveryId = crypto.randomUUID(), ts = Date.now(), badSig = false } = {}) {
  const body = JSON.stringify({ deliveryId, timestamp: ts, ...payload });
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  const sig2 = `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  return fetch(ctx.base + '/api/webhooks/youpi', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gateway-signature': badSig ? 'sha256=' + '0'.repeat(64) : sig, 'x-gateway-signature-v2': sig2, 'x-gateway-timestamp': String(ts), 'x-gateway-delivery-id': deliveryId },
    body }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

export function stubServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const s = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString(); const rec = { method: req.method, url: req.url, headers: req.headers, body }; requests.push(rec);
      const out = await handler(rec); res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.json ?? {}));
    }).listen(0, () => resolve({ url: `http://127.0.0.1:${s.address().port}`, requests, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
  });
}
