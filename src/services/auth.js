import { uuid, generateOtp, otpHash, safeEqual } from '../lib/crypto.js';
import { HttpError, EMAIL_RE, normEmail } from '../lib/http.js';
import { audit } from '../db.js';
import dns from 'node:dns/promises';

const DISPOSABLE = new Set(['mailinator.com','guerrillamail.com','guerrillamail.net','10minutemail.com','10minutemail.net','tempmail.com','temp-mail.org','yopmail.com','trashmail.com','throwawaymail.com','getnada.com','sharklasers.com','maildrop.cc','dispostable.com','fakeinbox.com','mintemail.com','mailnesia.com','tempail.com','emailondeck.com','mohmal.com']);

export function createAuthService({ db, cfg, email }) {
  const now = () => Date.now();
  const byEmail = async (e) => db.prepare('SELECT * FROM users WHERE email = ?').get(e);
  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, avatarUrl: u.avatar_url });

  async function checkEmailDomain(e) {
    const domain = e.split('@')[1] ?? '';
    if (DISPOSABLE.has(domain)) throw new HttpError(400, 'DISPOSABLE_EMAIL', 'Temporary email addresses are not accepted. Use your real email.');
    if (!cfg.checkEmailDomain) return;
    try {
      const mx = await Promise.race([dns.resolveMx(domain), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 3000))]);
      if (!mx.length) throw Object.assign(new Error('no mx'), { code: 'ENODATA' });
    } catch (err) {
      if (['ENOTFOUND', 'ENODATA'].includes(err.code)) throw new HttpError(400, 'INVALID_EMAIL', 'That email domain cannot receive email. Check the spelling.');
      /* a DNS hiccup must not block a real customer */
    }
  }

  function validateName(name) {
    const n = String(name ?? '').trim();
    if (n.length < 2 || n.length > 80 || !/\p{L}/u.test(n)) throw new HttpError(400, 'INVALID_NAME', 'Enter your name (2 to 80 characters).');
    return n;
  }
  function validateEmail(e) {
    if (!EMAIL_RE.test(e) || e.length > 254) throw new HttpError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  }

  // Creates a fresh OTP and emails it. Enforces the resend cooldown and an hourly cap.
  async function issueOtp(user, purpose = 'login') {
    const t = now();
    const last = await db.prepare('SELECT created_at FROM email_otps WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(user.id);
    if (last && t - last.created_at < cfg.otp.resendCooldownMs) {
      const wait = Math.ceil((cfg.otp.resendCooldownMs - (t - last.created_at)) / 1000);
      throw new HttpError(429, 'OTP_COOLDOWN', `Please wait ${wait}s before requesting another code.`, { retryAfterSeconds: wait });
    }
    const { c } = await db.prepare('SELECT COUNT(*) c FROM email_otps WHERE user_id=? AND created_at > ?').get(user.id, t - 3_600_000);
    if (c >= cfg.otp.maxSendsPerHour) throw new HttpError(429, 'OTP_HOURLY_LIMIT', 'Too many codes requested. Try again in an hour.', { retryAfterSeconds: 3600 });

    const id = uuid(), code = generateOtp();
    await db.transaction(async () => {
      await db.prepare('UPDATE email_otps SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL').run(t, user.id); // old codes die
      await db.prepare('INSERT INTO email_otps(id,user_id,purpose,code_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, user.id, purpose, otpHash(cfg.sessionSecret, id, code), t + cfg.otp.ttlMs, t);
    });
    try {
      await email.sendOtp({ to: user.email, name: user.name, code, purpose, ttlMinutes: Math.round(cfg.otp.ttlMs / 60000) });
    } catch (e) {
      await db.prepare('DELETE FROM email_otps WHERE id=?').run(id);     // a failed send must not burn the cooldown
      throw e;
    }
    return { expiresInSeconds: Math.round(cfg.otp.ttlMs / 1000), resendInSeconds: Math.round(cfg.otp.resendCooldownMs / 1000) };
  }

  return {
    publicUser,

    // One entry point for "Log in" and "Create account": nobody has a password, everybody proves the email with a code.
    async start({ mode, name, email: rawEmail }) {
      const e = normEmail(rawEmail);
      validateEmail(e);
      const existing = await byEmail(e);
      if (existing?.status === 'disabled') throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is disabled.');
      if (mode === 'signup') {
        const n = validateName(name);
        if (existing?.status === 'active') throw new HttpError(409, 'EMAIL_EXISTS', 'An account with this email already exists. Log in instead.');
        await checkEmailDomain(e);
        let user = existing;
        if (user) await db.prepare('UPDATE users SET name=?, updated_at=? WHERE id=?').run(n, now(), user.id);
        else {
          await db.prepare('INSERT INTO users(id,email,name,status,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
            .run(uuid(), e, n, 'pending', 0, now(), now());
          user = await byEmail(e);
        }
        return { email: e, mode: 'signup', ...(await issueOtp(user, 'signup')) };
      }
      if (!existing || existing.status !== 'active') throw new HttpError(404, 'NO_ACCOUNT', 'No account found for this email. Create an account first.');
      return { email: e, mode: 'login', ...(await issueOtp(existing, 'login')) };
    },

    async resendOtp(rawEmail) {
      const user = await byEmail(normEmail(rawEmail));
      if (!user || user.status === 'disabled') return { ok: true };      // same answer for every email
      return { ok: true, ...(await issueOtp(user, user.status === 'pending' ? 'signup' : 'login')) };
    },

    async verifyOtp(rawEmail, rawCode) {
      const user = await byEmail(normEmail(rawEmail));
      const code = String(rawCode ?? '').trim();
      const invalid = new HttpError(400, 'INVALID_CODE', 'That code is not valid. Check the email and try again.');
      if (!user || !['pending', 'active'].includes(user.status) || !/^\d{6}$/.test(code)) throw invalid;
      const otp = await db.prepare('SELECT * FROM email_otps WHERE user_id=? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1').get(user.id);
      if (!otp) throw new HttpError(400, 'CODE_EXPIRED', 'This code has expired. Request a new one.');
      if (otp.expires_at < now()) {
        await db.prepare('UPDATE email_otps SET consumed_at=? WHERE id=?').run(now(), otp.id);
        throw new HttpError(400, 'CODE_EXPIRED', 'This code has expired. Request a new one.');
      }
      if (otp.attempts >= cfg.otp.maxAttempts) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Request a new one.');
      await db.prepare('UPDATE email_otps SET attempts = attempts + 1 WHERE id=?').run(otp.id);
      if (!safeEqual(otpHash(cfg.sessionSecret, otp.id, code), otp.code_hash)) {
        const left = cfg.otp.maxAttempts - (otp.attempts + 1);
        if (left <= 0) {
          await db.prepare('UPDATE email_otps SET consumed_at=? WHERE id=?').run(now(), otp.id);
          throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Request a new one.');
        }
        throw new HttpError(400, 'INVALID_CODE', `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`, { attemptsLeft: left });
      }
      await db.transaction(async () => {
        await db.prepare('UPDATE email_otps SET consumed_at=? WHERE id=?').run(now(), otp.id);
        await db.prepare("UPDATE users SET status='active', email_verified=1, updated_at=? WHERE id=?").run(now(), user.id);
      });
      await audit(db, user.id, otp.purpose === 'signup' ? 'signup_verified' : 'login_otp', user.id);
      return publicUser(await byEmail(user.email));
    },

    // Google sign-in: one account per email. Existing accounts are linked, never duplicated.
    async upsertGoogleUser({ sub, email: rawEmail, name, picture }) {
      const e = normEmail(rawEmail);
      const t = now();
      return db.transaction(async () => {
        let u = (await db.prepare('SELECT * FROM users WHERE google_sub=?').get(sub)) ?? (await byEmail(e));
        if (u?.status === 'disabled') throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is disabled.');
        if (u) {
          await db.prepare(`UPDATE users SET google_sub=?, status='active', email_verified=1, avatar_url=COALESCE(?, avatar_url), name=COALESCE(NULLIF(name,''), ?), updated_at=? WHERE id=?`)
            .run(sub, picture ?? null, name || e, t, u.id);
          // A pending email signup that Google just proved ownership of is activated and its unverified password is dropped.
          if (u.status === 'pending') await db.prepare('UPDATE users SET password_hash=NULL WHERE id=?').run(u.id);
        } else {
          const id = uuid();
          await db.prepare('INSERT INTO users(id,email,name,avatar_url,google_sub,status,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(id, e, name || e.split('@')[0], picture ?? null, sub, 'active', 1, t, t);
        }
        return publicUser(await byEmail(e));
      });
    },
  };
}
