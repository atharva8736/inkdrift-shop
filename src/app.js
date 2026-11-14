import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sessionMiddleware, csrfGuard, requireAuth, createSession, destroySession, cookieName, cookieOpts } from './services/sessions.js';
import { createAuthService } from './services/auth.js';
import { createGoogleService } from './services/google.js';
import { createEmailService } from './services/email.js';
import { createYoupiClient } from './services/youpi.js';
import { createOrderService } from './services/orders.js';
import { listCatalog, ownedProductIds, accessibleVariant, loadCoverage, ownedProducts, DEVICES, VARIANT_DIR } from './services/catalog.js';
import { writeZip } from './lib/zip.js';
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
  const isAdmin = (req) => !!req.user && cfg.adminEmails.includes(String(req.user.email).toLowerCase());
  const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admins only.' } }));
  const me = (req) => ({ user: req.user ?? null, csrfToken: req.csrf ?? null, isAdmin: isAdmin(req) });

  // ---- Public ----
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => res.json({ googleEnabled: google.enabled(), currency: 'INR', otpLength: 6 }));
  app.get('/api/catalog', wrap(async (req, res) => res.json({ currency: 'INR', ...(await listCatalog(db)), owned: req.user ? await ownedProductIds(db, req.user.id) : [] })));
  app.get('/api/me', (req, res) => res.json(me(req)));

  // ---- Email + password with OTP ----
  const authLimit = limiter(15 * 60_000, 20, byIp);
  app.post('/api/auth/start', authLimit, limiter(15 * 60_000, 10, byIpEmail), wrap(async (req, res) => res.status(201).json(await auth.start(req.body ?? {}))));
  app.post('/api/auth/verify-otp', limiter(15 * 60_000, 30, byIpEmail), wrap(async (req, res) => {
    const user = await auth.verifyOtp(req.body?.email, req.body?.code);
    const s = await startSession(req, res, user);
    res.json({ user, csrfToken: s.csrf });
  }));
  app.post('/api/auth/resend-otp', limiter(15 * 60_000, 15, byIpEmail), wrap(async (req, res) => res.json(await auth.resendOtp(req.body?.email))));
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
  app.post('/api/orders/:id/utr', requireAuth, limiter(60_000, 10, (r) => r.user.id), wrap(async (req, res) => res.json({ order: await orders.submitUtr(req.user.id, req.params.id, req.body?.utr) })));
  app.get('/api/admin/orders', requireAuth, requireAdmin, wrap(async (req, res) => res.json(await orders.adminList())));
  app.post('/api/admin/orders/:id/approve', requireAuth, requireAdmin, wrap(async (req, res) => res.json(await orders.adminApprove(req.user.id, req.params.id))));
  app.post('/api/admin/orders/:id/reject', requireAuth, requireAdmin, wrap(async (req, res) => res.json(await orders.adminReject(req.user.id, req.params.id))));
  app.post('/api/orders/:id/cancel', requireAuth, wrap(async (req, res) => res.json({ order: await orders.cancel(req.user.id, req.params.id) })));
  app.post('/api/quote', requireAuth, wrap(async (req, res) => {
    const q = await orders.quote(req.user.id, req.body?.items, req.body?.coupon);
    res.json({ items: q.ids, subtotalPaise: q.subtotal, discountPaise: q.discount, amountPaise: q.amount, couponCode: q.code });
  }));

  // ---- Purchased content ----
  app.get('/api/library', requireAuth, wrap(async (req, res) => res.json(await orders.library(req.user.id))));

  const VAR_DIR = fileURLToPath(VARIANT_DIR);
  const fileFor = (v) => path.join(VAR_DIR, path.basename(path.dirname(v.file)), path.basename(v.file));
  const slug = (t) => String(t).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const niceName = (v) => `Inkdrift_${slug(v.title)}_${DEVICES[v.device].label}_${v.width}x${v.height}.jpg`;
  const sendJpeg = (res, v, disposition) => {
    const file = fileFor(v);
    if (!fs.existsSync(file)) throw new HttpError(404, 'FILE_MISSING', 'The file is not available yet. Contact support.');
    res.set({ 'Content-Type': 'image/jpeg', 'Content-Length': String(fs.statSync(file).size), 'Cache-Control': 'private, no-store',
      'Content-Disposition': `${disposition}; filename="${niceName(v)}"` });
    fs.createReadStream(file).pipe(res);
  };
  // The exact file for one wallpaper on one device. Only for people who bought a product that includes it.
  app.get('/api/file/:wallpaperId/:device', requireAuth, wrap(async (req, res) => {
    if (!DEVICES[req.params.device]) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    const v = await accessibleVariant(db, req.user.id, req.params.wallpaperId, req.params.device);
    if (!v) throw new HttpError(403, 'NOT_PURCHASED', 'You have not purchased this wallpaper for this device.');
    await audit(db, req.user.id, 'download', `${v.wallpaper_id}/${v.device}`);
    sendJpeg(res, v, 'attachment');
  }));
  // Clean preview (same file, shown inline) for owners. Everyone else only sees the watermarked /img/v previews.
  app.get('/api/preview/:wallpaperId/:device', requireAuth, wrap(async (req, res) => {
    if (!DEVICES[req.params.device]) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    const v = await accessibleVariant(db, req.user.id, req.params.wallpaperId, req.params.device);
    if (!v) throw new HttpError(403, 'NOT_PURCHASED', 'You have not purchased this wallpaper for this device.');
    sendJpeg(res, v, 'inline');
  }));
  // A whole purchase: one file as a JPG, several files as a ZIP.
  app.get('/api/download/:productId', requireAuth, wrap(async (req, res) => {
    const owned = (await ownedProducts(db, req.user.id)).find((p) => p.id === req.params.productId);
    if (!owned) throw new HttpError(403, 'NOT_PURCHASED', 'You have not purchased this item.');
    const keys = [...(await loadCoverage(db))(owned)];
    if (!keys.length) throw new HttpError(404, 'FILE_MISSING', 'The files are not available yet. Contact support.');
    const rows = (await db.prepare('SELECT v.*, w.title, w.pack_id, w.position FROM variants v JOIN wallpapers w ON w.id=v.wallpaper_id').all())
      .filter((v) => keys.includes(`${v.wallpaper_id}|${v.device}`)).sort((a, b) => a.pack_id.localeCompare(b.pack_id) || a.position - b.position || a.device.localeCompare(b.device));
    await audit(db, req.user.id, 'download', owned.id);
    if (rows.length === 1) return sendJpeg(res, rows[0], 'attachment');
    const multiDevice = new Set(rows.map((r) => r.device)).size > 1;
    const zipName = `Inkdrift_${slug(owned.name)}.zip`;
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${zipName}"`, 'Cache-Control': 'private, no-store' });
    await writeZip(res, rows.map((v) => ({
      name: multiDevice ? `${slug(v.title)}/${DEVICES[v.device].label}_${v.width}x${v.height}.jpg` : niceName(v).replace(/^Inkdrift_/, ''),
      read: async () => fs.promises.readFile(fileFor(v)),
    })));
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
