import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, lastCode, signupAndVerify, sleep } from './helpers.js';

const signup = (c, email = 'a@x.com', name = 'Asha Rao') => c.post('/api/auth/start', { mode: 'signup', name, email });
const login = (c, email) => c.post('/api/auth/start', { mode: 'login', email });

test('signup emails a real 6-digit OTP, there is no password anywhere, and the account stays inactive until verified', async () => {
  const ctx = await boot(); const c = ctx.client();
  const r = await signup(c, 'Asha@Example.com');
  assert.equal(r.status, 201);
  assert.equal(ctx.mailbox.length, 1);
  assert.equal(ctx.mailbox[0].to, 'asha@example.com');
  assert.match(ctx.mailbox[0].text, /code is \d{6}/); assert.match(ctx.mailbox[0].html, /\d{6}/);
  const u = await ctx.db.prepare('SELECT status,email_verified,password_hash FROM users').get();
  assert.equal(u.status, 'pending'); assert.equal(u.email_verified, 0); assert.equal(u.password_hash, null);
  assert.doesNotMatch(JSON.stringify(await ctx.db.prepare('SELECT * FROM email_otps').all()), new RegExp(lastCode(ctx.mailbox)));   // OTP never stored in clear
  assert.equal((await login(c, 'asha@example.com')).json.error.code, 'NO_ACCOUNT');       // pending accounts cannot log in
  assert.equal((await c.get('/api/me')).json.user, null);
  assert.equal((await c.post('/api/auth/login', { email: 'asha@example.com', password: 'x' })).status, 404);   // password login no longer exists
  await ctx.close();
});

test('correct OTP activates the account, starts a session and persists it', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const me = await c.get('/api/me');
  assert.equal(me.json.user.email, 'asha@example.com'); assert.ok(me.json.csrfToken);
  assert.equal((await ctx.db.prepare('SELECT status,email_verified FROM users').get()).status, 'active');
  const again = ctx.client(); again.jar = { ...c.jar };
  assert.equal((await again.get('/api/me')).json.user.name, 'Asha Rao');
  await ctx.close();
});

test('existing user logs in with an emailed OTP, gets the same account, and can log out', async () => {
  const ctx = await boot(); const first = await signupAndVerify(ctx);
  await first.post('/api/auth/logout');
  await sleep(120);
  const c = ctx.client();
  const r = await login(c, 'ASHA@example.com');
  assert.equal(r.status, 201); assert.equal(r.json.mode, 'login');
  assert.equal(ctx.mailbox.length, 2); assert.match(ctx.mailbox[1].subject, /login code/);
  const v = await c.post('/api/auth/verify-otp', { email: 'asha@example.com', code: lastCode(ctx.mailbox) });
  assert.equal(v.status, 200); assert.equal(v.json.user.name, 'Asha Rao');
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) c FROM users').get()).c, 1);          // same account, no duplicate
  assert.equal((await c.get('/api/me')).json.user.email, 'asha@example.com');
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/me')).json.user, null);
  await ctx.close();
});

test('login with an unknown email is refused and sends nothing', async () => {
  const ctx = await boot(); const c = ctx.client();
  const r = await login(c, 'nobody@example.com');
  assert.equal(r.status, 404); assert.equal(r.json.error.code, 'NO_ACCOUNT');
  assert.equal(ctx.mailbox.length, 0);
  await ctx.close();
});

test('wrong OTP is rejected, attempts are limited, and the code is then dead', async () => {
  const ctx = await boot(); const c = ctx.client();
  await signup(c);
  const good = lastCode(ctx.mailbox); const wrong = good === '000000' ? '111111' : '000000';
  const first = await c.post('/api/auth/verify-otp', { email: 'a@x.com', code: wrong });
  assert.equal(first.status, 400); assert.equal(first.json.error.attemptsLeft, 4);
  for (let i = 0; i < 3; i++) await c.post('/api/auth/verify-otp', { email: 'a@x.com', code: wrong });
  const last = await c.post('/api/auth/verify-otp', { email: 'a@x.com', code: wrong });
  assert.equal(last.status, 429); assert.equal(last.json.error.code, 'TOO_MANY_ATTEMPTS');
  assert.notEqual((await c.post('/api/auth/verify-otp', { email: 'a@x.com', code: good })).status, 200);   // even the right code is dead
  assert.equal((await ctx.db.prepare('SELECT status FROM users').get()).status, 'pending');
  await ctx.close();
});

test('an expired OTP is refused', async () => {
  const ctx = await boot({ cfg: { otp: { ttlMs: 60, resendCooldownMs: 10 } } }); const c = ctx.client();
  await signup(c);
  await sleep(120);
  const r = await c.post('/api/auth/verify-otp', { email: 'a@x.com', code: lastCode(ctx.mailbox) });
  assert.equal(r.status, 400); assert.equal(r.json.error.code, 'CODE_EXPIRED');
  await ctx.close();
});

test('resend has a cooldown, a fresh code replaces the old one, and an hourly cap', async () => {
  const ctx = await boot({ cfg: { otp: { resendCooldownMs: 150, maxSendsPerHour: 3 } } }); const c = ctx.client();
  await signup(c);
  const old = lastCode(ctx.mailbox);
  const early = await c.post('/api/auth/resend-otp', { email: 'a@x.com' });
  assert.equal(early.status, 429); assert.equal(early.json.error.code, 'OTP_COOLDOWN');
  await sleep(170);
  assert.equal((await c.post('/api/auth/resend-otp', { email: 'a@x.com' })).status, 200);
  assert.equal(ctx.mailbox.length, 2);
  const fresh = lastCode(ctx.mailbox);
  if (fresh !== old) assert.equal((await c.post('/api/auth/verify-otp', { email: 'a@x.com', code: old })).status, 400);
  await sleep(170); await c.post('/api/auth/resend-otp', { email: 'a@x.com' });
  await sleep(170);
  assert.equal((await c.post('/api/auth/resend-otp', { email: 'a@x.com' })).json.error.code, 'OTP_HOURLY_LIMIT');
  assert.equal((await c.post('/api/auth/verify-otp', { email: 'a@x.com', code: lastCode(ctx.mailbox) })).status, 200);
  await ctx.close();
});

test('if the email provider fails the user gets a clear error and no cooldown is burned', async () => {
  const ctx = await boot({ cfg: { otp: { resendCooldownMs: 60_000 } } }); const c = ctx.client();
  ctx.mailbox.failNext = true;
  const r = await signup(c);
  assert.equal(r.status, 502); assert.equal(r.json.error.code, 'EMAIL_SEND_FAILED');
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) c FROM email_otps').get()).c, 0);
  assert.equal((await signup(c)).status, 201);          // immediate retry works
  await ctx.close();
});

test('duplicate email is blocked and validation errors are clear', async () => {
  const ctx = await boot(); await signupAndVerify(ctx);
  const dupe = await signup(ctx.client(), 'ASHA@example.com', 'Other');
  assert.equal(dupe.status, 409); assert.equal(dupe.json.error.code, 'EMAIL_EXISTS');
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) c FROM users').get()).c, 1);
  assert.equal((await signup(ctx.client(), 'b@x.com', 'A')).json.error.code, 'INVALID_NAME');
  assert.equal((await signup(ctx.client(), 'bad', 'Ann')).json.error.code, 'INVALID_EMAIL');
  await ctx.close();
});

test('logout kills the server-side session even if the cookie is replayed; CSRF and JSON are enforced', async () => {
  const ctx = await boot(); const c = await signupAndVerify(ctx);
  const replay = ctx.client(); replay.jar = { ...c.jar };
  await c.post('/api/auth/logout');
  assert.equal((await replay.get('/api/me')).json.user, null);
  const c2 = await signupAndVerify(ctx, 'Bo', 'bo@example.com');
  const noCsrf = await fetch(c2.base + '/api/orders', { method: 'POST', headers: { 'content-type': 'application/json', cookie: Object.entries(c2.jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: '{}' });
  assert.equal(noCsrf.status, 403);
  const form = await fetch(c2.base + '/api/auth/start', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a' });
  assert.equal(form.status, 415);
  await ctx.close();
});

test('fake or throwaway sign-ups are refused', async () => {
  const ctx = await boot(); const c = ctx.client();
  assert.equal((await signup(c, 'x@mailinator.com')).json.error.code, 'DISPOSABLE_EMAIL');
  assert.equal((await signup(c, 'a@real.com', '12')).json.error.code, 'INVALID_NAME');
  assert.equal(ctx.mailbox.length, 0);
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) c FROM users').get()).c, 0);
  await ctx.close();
});

test('with checkEmailDomain on, a domain that cannot receive mail is refused', async () => {
  const ctx = await boot({ cfg: { checkEmailDomain: true } }); const c = ctx.client();
  const r = await signup(c, 'a@this-domain-does-not-exist-inkdrift.invalid');
  assert.equal(r.status, 400); assert.equal(r.json.error.code, 'INVALID_EMAIL');
  await ctx.close();
});

test('Google button without credentials sends the user back to login with a clear message', async () => {
  const ctx = await boot(); const c = ctx.client();
  const r = await c.get('/api/auth/google');
  assert.equal(r.status, 302); assert.match(r.headers.get('location'), /auth_error=google_not_configured/);
  await ctx.close();
});
