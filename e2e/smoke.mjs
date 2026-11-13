// End-to-end browser run against the real server. Only the three EXTERNAL services (Resend, YOUPI, nothing else) are local stand-ins.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';

const SECRET = 'whsec_e2e', tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-e2e-'));
for (const f of ['Inkdrift_Vol1_Old_Money', 'Inkdrift_Vol2_Time', 'Inkdrift_Vol3_Machines', 'Inkdrift_Vol4_Late_Nights']) fs.writeFileSync(path.join(tmp, f + '.zip'), 'ZIP:' + f);
const listen = (h) => new Promise((r) => { const s = http.createServer(h).listen(0, () => r(s)); });
const body = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString(); };

const mails = [], gwPay = new Map();
const resend = await listen(async (req, res) => { mails.push(JSON.parse(await body(req))); res.end('{"id":"e1"}'); });
let gwBase;
const gw = await listen(async (req, res) => {
  const b = req.method === 'POST' ? JSON.parse((await body(req)) || '{}') : {};
  res.setHeader('content-type', 'application/json');
  if (req.method === 'POST' && req.url === '/api/v1/payments') {
    const id = 'pay_' + (gwPay.size + 1);
    gwPay.set(id, { paymentId: id, orderId: b.orderId, amountPaise: Math.round(parseFloat(b.amount) * 100), status: 'ACTIVE', method: 'UPI', returnUrl: b.returnUrl });
    res.statusCode = 201; return res.end(JSON.stringify({ paymentId: id, orderId: b.orderId, status: 'INITIATED', checkoutUrl: `${gwBase}/checkout/${id}` }));
  }
  const m = req.url.match(/^\/api\/v1\/payments\/(.+)$/);
  if (m && gwPay.has(m[1])) return res.end(JSON.stringify(gwPay.get(m[1])));
  if (req.url.startsWith('/checkout/')) { res.setHeader('content-type', 'text/html'); return res.end('<h1>YOUPI checkout (stand-in)</h1>'); }
  res.statusCode = 404; res.end('{}');
});
gwBase = `http://127.0.0.1:${gw.address().port}`;

const PORT = 3999, base = `http://localhost:${PORT}`;
const srv = spawn('node', ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), APP_URL: base, NODE_ENV: 'development', DATABASE_PATH: path.join(tmp, 'db.sqlite'), PACKS_DIR: tmp,
  SESSION_SECRET: 'z'.repeat(48), RESEND_API_KEY: 're_x', EMAIL_FROM: 'Inkdrift <no-reply@example.com>', RESEND_API_URL: `http://127.0.0.1:${resend.address().port}/emails`,
  YOUPI_API_URL: gwBase, YOUPI_MERCHANT_ID: 'm', YOUPI_MERCHANT_API_KEY: 'k', YOUPI_WEBHOOK_SECRET: SECRET }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => /listening/.test(d) && r()));

const out = (n) => path.join('/home/claude/work', `e2e_${n}.png`);
const step = (m) => console.log('•', m);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(base); await page.waitForFunction(() => document.getElementById('loader').style.display === 'none', null, { timeout: 15000 });
  step('site loaded through the Express server');
  await page.evaluate(() => go('login')); await page.waitForSelector('#aForm input', { timeout: 8000 }); await page.waitForTimeout(1200);
  await page.click('[data-t="up"]'); await page.fill('#aN', 'Asha Rao'); await page.fill('#aE', 'asha@example.com');
  await page.screenshot({ path: out('1_signup') });
  await page.click('#aForm .btn'); await page.waitForSelector('#otp input', { timeout: 8000 });
  step('signup → OTP screen; email delivered to Resend API stand-in: ' + mails.length);
  await page.waitForTimeout(600); await page.screenshot({ path: out('2_otp') });
  const code = mails.at(-1).text.match(/code is (\d{6})/)[1];
  const wrong = code === '000000' ? '111111' : '000000';
  for (const [i, ch] of [...wrong].entries()) await page.fill(`#otp input:nth-child(${i + 1})`, ch);
  await page.waitForFunction(() => document.getElementById('aErr').textContent.includes('not correct'), null, { timeout: 8000 });
  step('wrong OTP rejected with message: ' + await page.textContent('#aErr'));
  for (const [i, ch] of [...code].entries()) await page.fill(`#otp input:nth-child(${i + 1})`, ch);
  await page.waitForFunction(() => document.body.classList.contains('has-user') && location.hash === '#dashboard', null, { timeout: 15000 });
  step('correct OTP → logged in → dashboard');
  await page.waitForTimeout(1800); await page.screenshot({ path: out('3_dashboard_empty') });

  await page.evaluate(() => go('home', null, 'packs')); await page.waitForTimeout(2500);
  await page.evaluate(() => add('time', document.querySelector('.pc .add')));
  await page.waitForTimeout(900); await page.click('#dFoot .btn'); await page.waitForSelector('#coSide .tot', { timeout: 8000 }); await page.waitForTimeout(1500);
  await page.screenshot({ path: out('4_checkout') });
  step('checkout total (server quote): ' + (await page.textContent('#coSide .tot')).replace(/\s+/g, ' '));
  await Promise.all([page.waitForURL(/\/checkout\/pay_1/), page.click('#payBtn')]);
  step('redirected to gateway checkout: ' + page.url());
  const pay = gwPay.get('pay_1');
  // the gateway "observes" the bank credit and sends its signed webhook
  const payload = JSON.stringify({ event: 'OBSERVED_SUCCESS', settlementState: 'NOT_RECONCILED', orderId: pay.orderId, amountPaise: pay.amountPaise, paymentId: 'pay_1', utr: '412345678901', deliveryId: crypto.randomUUID(), timestamp: Date.now() });
  pay.status = 'OBSERVED_SUCCESS'; pay.utr = '412345678901';
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  const w = await fetch(base + '/api/webhooks/youpi', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-signature': sig, 'x-gateway-delivery-id': JSON.parse(payload).deliveryId }, body: payload });
  step('signed webhook accepted: ' + w.status + ' ' + (await w.text()));
  await page.goto(pay.returnUrl); await page.waitForSelector('.dl a[download]', { timeout: 20000 });
  await page.waitForTimeout(2200); await page.screenshot({ path: out('5_paid') });
  step('payment-confirmed page shows download link');
  const href = await page.getAttribute('.dl a[download]', 'href');
  const dl = await ctx.request.get(base + href);
  step(`download → ${dl.status()} ${(await dl.text())}`);
  const locked = await ctx.request.get(base + '/api/download/machines'); step('locked pack download → ' + locked.status());
  await page.evaluate(() => go('dashboard')); await page.waitForSelector('.dpack', { timeout: 8000 }); await page.waitForTimeout(1500);
  await page.screenshot({ path: out('6_dashboard_owned') });
  await page.click('[data-dt="hist"]'); await page.waitForSelector('.hrow', { timeout: 8000 }); await page.waitForTimeout(800); await page.screenshot({ path: out('7_history') });
  step('history row: ' + (await page.textContent('.hrow')).replace(/\s+/g, ' ').slice(0, 140));
  await page.click('#logoutBtn'); await page.waitForFunction(() => !document.body.classList.contains('has-user'), null, { timeout: 8000 });
  step('logout ok; page errors: ' + JSON.stringify(errors));
} catch (e) { await page.screenshot({ path: out('fail') }); console.error('E2E FAILED:', e.message, errors); process.exitCode = 1; }
finally { await browser.close(); srv.kill(); resend.close(); gw.close(); }
