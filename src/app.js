import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { sessionMiddleware, csrfGuard, requireAuth, createSession, destroySession, cookieName, cookieOpts } from './services/sessions.js';
import { createAuthService } from './services/auth.js';
import { createGoogleService } from './services/google.js';
import { createEmailService } from './services/email.js';
import { createYoupiClient } from './services/youpi.js';
import { createOrderService } from './services/orders.js';
import { listCatalog, ownedProductIds } from './services/catalog.js';
import { HttpError, wrap, normEmail } from './lib/http.js';
import { hmacHex, safeEqual } from './lib/crypto.js';
import { audit } from './db.js';
import { createStorage } from './services/storage.js';

// deps lets tests inject an email transport and a gateway client; production uses the real ones.
export function createApp({ db, cfg, emailTransport, youpiClient, storage: storageOverride }) {
  const app = express();
  const email = createEmailService(cfg, emailTransport);
  const youpi = youpiClient ?? createYoupiClient(cfg);
  const auth = createAuthService({ db, cfg, email });
  const google = createGoogleService({ cfg, auth });
  const orders = createOrderService({ db, cfg, youpi });
  const storage = storageOverride ?? createStorage(cfg);
  const limiter = (windowMs, limit, keyFn) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false,
    keyGenerator: keyFn, validate: false, handler: (req, res, next) => next(new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Please wait a moment.')) });
  const byIp = (req) => req.ip;
  const byIpEmail = (req) => `${req.ip}|${normEmail(req.body?.email)}`;

  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https://lh3.googleusercontent.com'],
      connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'", ...(cfg.youpi.apiUrl ? [cfg.youpi.apiUrl] : [])],
    } },
    crossOriginEmbedderPolicy: false,
  }));

  // ---- Webhook: needs the raw bytes, so it is mounted before the JSON parser ----
  app.post('/api/webhooks/youpi', express.raw({ type: '*/*', limit: '256kb' }), wrap(async (req, res) => {
    const raw = req.body;
    if (!Buffer.isBuffer(raw) || !raw.length) throw new HttpError(400, 'EMPTY', 'Empty body.');
    const secret = cfg.youpi.webhookSecret;
    const sig = String(req.get('x-gateway-signature') ?? '');
    const sig2 = String(req.get('x-gateway-signature-v2') ?? '');
    const ts = Number(req.get('x-gateway-timestamp') ?? NaN);
    const ok1 = safeEqual(sig, `sha256=${hmacHex(secret, raw)}`);
    const ok2 = sig2 && Number.isFinite(ts) ? safeEqual(sig2, `sha256=${hmacHex(secret, `${ts}.${raw.toString('utf8')}`)}`) : null;
    if (!secret || !ok1 || ok2 === false) { await audit(db, 'webhook', 'bad_signature', null, { ip: req.ip }); throw new HttpError(401, 'BAD_SIGNATURE', 'Invalid signature.'); }
    // Retries keep the original timestamp, so the window must cover the gateway's retry schedule.
    if (Number.isFinite(ts) && (Date.now() - ts > cfg.youpi.webhookMaxAgeMs || ts - Date.now() > 5 * 60_000)) throw new HttpError(401, 'STALE', 'Webhook timestamp outside the accepted window.');
    let p; try { p = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'BAD_JSON', 'Invalid JSON.'); }
    const deliveryId = String(req.get('x-gateway-delivery-id') ?? p.deliveryId ?? '');
    if (!deliveryId) throw new HttpError(400, 'NO_DELIVERY_ID', 'Missing delivery id.');
    const seen = await db.prepare('SELECT outcome FROM webhook_events WHERE delivery_id=?').get(deliveryId);
    if (seen && seen.outcome !== 'retry') return res.json({ ok: true, duplicate: true });
    const r = await orders.applyWebhook(p);
    await db.prepare('INSERT OR REPLACE INTO webhook_events(delivery_id,payment_id,event,outcome,received_at) VALUES (?,?,?,?,?)')
      .run(deliveryId, p.paymentId ?? null, p.event ?? null, r.retry ? 'retry' : r.outcome, Date.now());
    if (r.retry) return res.status(503).json({ ok: false, retry: true });   // gateway will redeliver
    res.json({ ok: true, outcome: r.outcome });
  }));

  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  app.use('/api', sessionMiddleware(db, cfg), csrfGuard);
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const startSession = async (req, res, user) => {
    const s = await createSession(db, cfg, user.id, req);
    res.cookie(cookieName(cfg), s.raw, cookieOpts(cfg, s.maxAge));
    return s;
  };
  const me = (req) => ({ user: req.user ?? null, csrfToken: req.csrf ?? null });

  // ---- Public ----
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => res.json({ googleEnabled: google.enabled(), currency: 'INR', otpLength: 6 }));
  app.get('/api/catalog', wrap(async (req, res) => res.json({ currency: 'INR', products: await listCatalog(db), owned: req.user ? await ownedProductIds(db, req.user.id) : [] })));
  app.get('/api/me', (req, res) => res.json(me(req)));

  // ---- Email + password with OTP ----
  const authLimit = limiter(15 * 60_000, 20, byIp);
  app.post('/api/auth/signup', authLimit, wrap(async (req, res) => res.status(201).json(await auth.signup(req.body ?? {}))));
  app.post('/api/auth/verify-otp', limiter(15 * 60_000, 30, byIpEmail), wrap(async (req, res) => {
    const user = await auth.verifyOtp(req.body?.email, req.body?.code);
    const s = await startSession(req, res, user);
    res.json({ user, csrfToken: s.csrf });
  }));
  app.post('/api/auth/resend-otp', limiter(15 * 60_000, 15, byIpEmail), wrap(async (req, res) => res.json(await auth.resendOtp(req.body?.email))));
  app.post('/api/auth/login', limiter(15 * 60_000, 10, byIpEmail), wrap(async (req, res) => {
    const user = await auth.login(req.body?.email, req.body?.password);
    const s = await startSession(req, res, user);
    res.json({ user, csrfToken: s.csrf });
  }));
  app.post('/api/auth/logout', wrap(async (req, res) => {
    await destroySession(db, req.sessionRaw);
    res.clearCookie(cookieName(cfg), cookieOpts(cfg));
    res.json({ ok: true });
  }));

  // ---- Google OAuth 2.0 (authorization code + PKCE) ----
  app.get('/api/auth/google', authLimit, wrap(async (req, res) => {
    if (!google.enabled()) return res.redirect('/?auth_error=google_not_configured#login');
    const { url, cookieValue } = google.begin(req.query.next);
    res.cookie(google.cookie, cookieValue, { httpOnly: true, sameSite: 'lax', secure: cfg.appUrl.startsWith('https://'), path: '/api/auth/google', maxAge: 10 * 60_000 });
    res.redirect(url);
  }));
  app.get('/api/auth/google/callback', wrap(async (req, res) => {
    const fail = (code) => res.redirect(`/?auth_error=${encodeURIComponent(code)}#login`);
    res.clearCookie(google.cookie, { path: '/api/auth/google' });
    if (req.query.error) return fail(req.query.error === 'access_denied' ? 'google_cancelled' : 'google_failed');
    try {
      const { user, next } = await google.complete({ code: req.query.code, state: req.query.state, cookieValue: req.cookies?.[google.cookie] });
      await startSession(req, res, user);
      res.redirect(next && next !== '/' ? next : '/#dashboard');
    } catch (e) {
      console.error('[google]', e.code ?? e.message);
      fail(e.code === 'ACCOUNT_DISABLED' ? 'account_disabled' : 'google_failed');
    }
  }));

  // ---- Orders and payments (login required) ----
  app.post('/api/orders', requireAuth, limiter(60_000, 10, (r) => r.user.id), wrap(async (req, res) => {
    const out = await orders.create(req.user, { items: req.body?.items, couponCode: req.body?.coupon, idempotencyKey: req.get('idempotency-key') });
    res.status(out.reused ? 200 : 201).json(out);
  }));
  app.get('/api/orders', requireAuth, wrap(async (req, res) => res.json({ orders: await orders.list(req.user.id) })));
  app.get('/api/orders/:id', requireAuth, wrap(async (req, res) => res.json({ order: await orders.get(req.user.id, req.params.id) })));
  app.post('/api/orders/:id/cancel', requireAuth, wrap(async (req, res) => res.json({ order: await orders.cancel(req.user.id, req.params.id) })));
  app.post('/api/quote', requireAuth, wrap(async (req, res) => {
    const q = await orders.quote(req.user.id, req.body?.items, req.body?.coupon);
    res.json({ items: q.ids, subtotalPaise: q.subtotal, discountPaise: q.discount, amountPaise: q.amount, couponCode: q.code });
  }));

  // ---- Purchased content ----
  app.get('/api/library', requireAuth, wrap(async (req, res) => res.json({ packs: await orders.library(req.user.id) })));
  app.get('/api/download/:packId', requireAuth, wrap(async (req, res) => {
    const row = await db.prepare(`SELECT p.file_name FROM entitlements e JOIN products p ON p.id=e.product_id
      WHERE e.user_id=? AND e.product_id=? AND e.revoked_at IS NULL AND p.type='pack'`).get(req.user.id, req.params.packId);
    if (!row?.file_name) throw new HttpError(403, 'NOT_PURCHASED', 'You have not purchased this pack.');
    const name = path.basename(row.file_name);
    const f = await storage.open(name);
    if (!f) throw new HttpError(404, 'FILE_MISSING', 'The file is not available yet. Contact support.');
    await audit(db, req.user.id, 'download', req.params.packId);
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store', ...(f.size ? { 'Content-Length': String(f.size) } : {}) });
    f.stream.on('error', (e) => { console.error('[download]', e.message); res.destroy(e); });
    f.stream.pipe(res);
  }));

  app.use('/api', (req, res, next) => next(new HttpError(404, 'NOT_FOUND', 'Not found.')));

  // ---- Static site (the existing Inkdrift front end, unchanged) ----
  const pub = path.resolve(cfg.publicDir);
  app.use(express.static(pub, { index: 'index.html', maxAge: cfg.env === 'production' ? '1h' : 0, setHeaders: (r, f) => { if (f.endsWith('index.html')) r.setHeader('Cache-Control', 'no-cache'); } }));

  // ---- Errors ----
  app.use((err, req, res, next) => {            // eslint-disable-line no-unused-vars
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Invalid JSON.' } });
    console.error('[error]', err);
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' } });
  });
  return app;
}
