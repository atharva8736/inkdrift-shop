import { token, sha256, safeEqual } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';

export const cookieName = (cfg) => (cfg.appUrl.startsWith('https://') ? '__Host-ink_sid' : 'ink_sid');
export const cookieOpts = (cfg, maxAge) => ({
  httpOnly: true, sameSite: 'lax', secure: cfg.appUrl.startsWith('https://'), path: '/', maxAge,
});

export function createSession(db, cfg, userId, req) {
  const raw = token(32), csrf = token(24), now = Date.now();
  db.prepare('INSERT INTO sessions(id_hash,user_id,csrf_token,created_at,expires_at,ip,user_agent) VALUES (?,?,?,?,?,?,?)')
    .run(sha256(raw), userId, csrf, now, now + cfg.sessionTtlMs, req?.ip ?? null, String(req?.get?.('user-agent') ?? '').slice(0, 200));
  db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(now, userId);
  return { raw, csrf, maxAge: cfg.sessionTtlMs };
}

export const destroySession = (db, raw) => raw && db.prepare('DELETE FROM sessions WHERE id_hash=?').run(sha256(raw));
export const purgeSessions = (db) => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

export function sessionMiddleware(db, cfg) {
  const name = cookieName(cfg);
  return (req, res, next) => {
    const raw = req.cookies?.[name];
    req.sessionRaw = raw;
    if (raw) {
      const row = db.prepare(`SELECT s.csrf_token, s.expires_at, u.id, u.email, u.name, u.avatar_url, u.status
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`).get(sha256(raw));
      if (row && row.expires_at > Date.now() && row.status === 'active') {
        req.user = { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatar_url };
        req.csrf = row.csrf_token;
      }
    }
    next();
  };
}

export const requireAuth = (req, res, next) =>
  req.user ? next() : next(new HttpError(401, 'AUTH_REQUIRED', 'Please log in to continue.'));

// State-changing requests must be JSON (blocks cross-site form posts) and, when logged in, carry the CSRF token.
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/webhooks/')) return next();
  if (!req.is('application/json')) return next(new HttpError(415, 'JSON_REQUIRED', 'Send JSON.'));
  if (req.user && !safeEqual(req.get('x-csrf-token') ?? '', req.csrf)) {
    return next(new HttpError(403, 'CSRF', 'Your session token is missing or stale. Refresh the page.'));
  }
  next();
}
