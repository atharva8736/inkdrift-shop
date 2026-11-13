import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, stubServer } from './helpers.js';

const idToken = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

// A local stand-in for Google's token endpoint. It echoes the nonce we sent in the first leg.
async function setup(over = {}) {
  const g = { claims: {}, status: 200 };
  const stub = await stubServer((r) => {
    const form = new URLSearchParams(r.body); g.lastForm = form;
    if (g.status !== 200) return { status: g.status, json: { error: 'invalid_grant' } };
    return { json: { id_token: idToken({ iss: 'https://accounts.google.com', aud: 'gid.apps.googleusercontent.com', exp: Math.floor(Date.now() / 1000) + 600, nonce: g.nonce, sub: 'g-123', email: 'maya@gmail.com', email_verified: true, name: 'Maya Iyer', picture: 'https://lh3.googleusercontent.com/a/x', ...g.claims }) } };
  });
  const ctx = await boot({ cfg: { google: { clientId: 'gid.apps.googleusercontent.com', clientSecret: 'gsecret', tokenUrl: stub.url + '/token', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth' }, ...over } });
  const start = async (c, next) => {
    const r = await c.get('/api/auth/google' + (next ? `?next=${encodeURIComponent(next)}` : ''));
    const loc = new URL(r.headers.get('location')); g.nonce = loc.searchParams.get('nonce');
    return { r, loc, state: loc.searchParams.get('state') };
  };
  return { ctx, stub, g, start };
}

test('Google login: redirects to Google with state+PKCE, then creates the account and a session', async () => {
  const { ctx, stub, g, start } = await setup(); const c = ctx.client();
  assert.equal((await c.get('/api/config')).json.googleEnabled, true);
  const { r, loc, state } = await start(c);
  assert.equal(r.status, 302); assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('client_id'), 'gid.apps.googleusercontent.com'); assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(loc.searchParams.get('redirect_uri'), 'http://localhost:3000/api/auth/google/callback'); assert.match(loc.searchParams.get('scope'), /openid email profile/);
  const cb = await c.get(`/api/auth/google/callback?code=abc&state=${state}`);
  assert.equal(cb.status, 302); assert.equal(cb.headers.get('location'), '/#dashboard');
  assert.equal(g.lastForm.get('code'), 'abc'); assert.equal(g.lastForm.get('client_secret'), 'gsecret'); assert.ok(g.lastForm.get('code_verifier'));
  const me = (await c.get('/api/me')).json.user;
  assert.equal(me.email, 'maya@gmail.com'); assert.equal(me.name, 'Maya Iyer'); assert.match(me.avatarUrl, /googleusercontent/);
  const row = await ctx.db.prepare('SELECT status,email_verified,google_sub,password_hash FROM users').get();
  assert.deepEqual({ ...row }, { status: 'active', email_verified: 1, google_sub: 'g-123', password_hash: null });
  // logging out and in again reuses the same account
  await c.post('/api/auth/logout'); assert.equal((await c.get('/api/me')).json.user, null);
  const again = await start(c); await c.get(`/api/auth/google/callback?code=zzz&state=${again.state}`);
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) c FROM users').get()).c, 1);
  await stub.close(); await ctx.close();
});

test('Google login links to an existing email account instead of creating a duplicate', async () => {
  const { ctx, stub, g, start } = await setup(); g.claims = { email: 'asha@example.com', sub: 'g-777', name: 'Asha G' };
  const { signupAndVerify } = await import('./helpers.js');
  const owner = await signupAndVerify(ctx, 'Asha Rao', 'asha@example.com');
  const c = ctx.client(); const { state } = await start(c); await c.get(`/api/auth/google/callback?code=c&state=${state}`);
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) c FROM users').get()).c, 1);
  const row = await ctx.db.prepare('SELECT google_sub,name FROM users').get(); assert.equal(row.google_sub, 'g-777'); assert.equal(row.name, 'Asha Rao');
  assert.equal((await c.get('/api/me')).json.user.email, 'asha@example.com');
  assert.equal((await owner.post('/api/auth/login', { email: 'asha@example.com', password: 'correct-horse-9' })).status, 200);   // password login still works
  await stub.close(); await ctx.close();
});

test('Google failures are handled: wrong state, cancelled consent, token error, wrong audience, unverified email', async () => {
  const { ctx, stub, g, start } = await setup(); const c = ctx.client();
  const loc = (r) => r.headers.get('location');
  let s = await start(c);
  assert.match(loc(await c.get(`/api/auth/google/callback?code=a&state=tampered`)), /auth_error=google_failed/);
  assert.equal((await c.get('/api/me')).json.user, null);
  s = await start(c); assert.match(loc(await c.get(`/api/auth/google/callback?error=access_denied&state=${s.state}`)), /auth_error=google_cancelled/);
  s = await start(c); g.status = 400; assert.match(loc(await c.get(`/api/auth/google/callback?code=a&state=${s.state}`)), /auth_error=google_failed/); g.status = 200;
  s = await start(c); g.claims = { aud: 'someone-elses-client' }; assert.match(loc(await c.get(`/api/auth/google/callback?code=a&state=${s.state}`)), /auth_error=google_failed/);
  s = await start(c); g.claims = { email_verified: false }; assert.match(loc(await c.get(`/api/auth/google/callback?code=a&state=${s.state}`)), /auth_error=google_failed/);
  s = await start(c); g.claims = { nonce: 'replayed' }; assert.match(loc(await c.get(`/api/auth/google/callback?code=a&state=${s.state}`)), /auth_error=google_failed/);
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) c FROM users').get()).c, 0);
  await stub.close(); await ctx.close();
});

test('open redirects are blocked and Google is reported disabled when not configured', async () => {
  const { ctx, stub, g, start } = await setup(); const c = ctx.client();
  const s = await start(c, 'https://evil.example/steal'); const cb = await c.get(`/api/auth/google/callback?code=a&state=${s.state}`);
  assert.equal(cb.headers.get('location'), '/#dashboard');
  const s2 = await start(c, '/?order=abc#done'); await c.post('/api/auth/logout');
  const s3 = await start(c, '/?order=abc#done'); assert.equal((await c.get(`/api/auth/google/callback?code=a&state=${s3.state}`)).headers.get('location'), '/?order=abc#done');
  await stub.close(); await ctx.close();
  const plain = await boot(); assert.equal((await plain.client().get('/api/config')).json.googleEnabled, false);
  assert.equal((await plain.client().get('/api/auth/google')).status, 503); await plain.close();
});
