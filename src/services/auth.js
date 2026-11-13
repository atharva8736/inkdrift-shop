import { uuid, hashPassword, verifyPassword, burnPasswordTime, generateOtp, otpHash, safeEqual } from '../lib/crypto.js';
import { HttpError, EMAIL_RE, normEmail } from '../lib/http.js';
import { audit } from '../db.js';

export function createAuthService({ db, cfg, email }) {
  const now = () => Date.now();
  const byEmail = async (e) => db.prepare('SELECT * FROM users WHERE email = ?').get(e);
  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, avatarUrl: u.avatar_url });

  function validateSignup({ name, email: e, password }) {
    const n = String(name ?? '').trim();
    if (n.length < 2 || n.length > 80) throw new HttpError(400, 'INVALID_NAME', 'Enter your name (2 to 80 characters).');
    if (!EMAIL_RE.test(e) || e.length > 254) throw new HttpError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
    const p = String(password ?? '');
    if (p.length < 8 || p.length > 128) throw new HttpError(400, 'WEAK_PASSWORD', 'Use a password of 8 to 128 characters.');
    return n;
  }

  // Creates a fresh OTP and emails it. Enforces the resend cooldown and an hourly cap.
  async function issueOtp(user) {
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
      await db.prepare('INSERT INTO email_otps(id,user_id,code_hash,expires_at,created_at) VALUES (?,?,?,?,?)')
        .run(id, user.id, otpHash(cfg.sessionSecret, id, code), t + cfg.otp.ttlMs, t);
    });
    try {
      await email.sendOtp({ to: user.email, name: user.name, code, ttlMinutes: Math.round(cfg.otp.ttlMs / 60000) });
    } catch (e) {
      await db.prepare('DELETE FROM email_otps WHERE id=?').run(id);     // a failed send must not burn the cooldown
      throw e;
    }
    return { expiresInSeconds: Math.round(cfg.otp.ttlMs / 1000), resendInSeconds: Math.round(cfg.otp.resendCooldownMs / 1000) };
  }

  return {
    publicUser,

    async signup(input) {
      const e = normEmail(input.email);
      const name = validateSignup({ ...input, email: e });
      const existing = await byEmail(e);
      if (existing?.status === 'disabled') throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is disabled.');
      if (existing?.status === 'active') {
        throw new HttpError(409, 'EMAIL_EXISTS', existing.password_hash
          ? 'An account with this email already exists. Log in instead.'
          : 'This email is registered with Google. Use Continue with Google.');
      }
      const hash = await hashPassword(input.password);
      let user = existing;
      if (user) await db.prepare('UPDATE users SET name=?, password_hash=?, updated_at=? WHERE id=?').run(name, hash, now(), user.id);
      else {
        const id = uuid();
        await db.prepare('INSERT INTO users(id,email,name,password_hash,status,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(id, e, name, hash, 'pending', 0, now(), now());
        user = await byEmail(e);
      }
      const sent = await issueOtp(user);
      return { email: e, ...sent };
    },

    async resendOtp(rawEmail) {
      const user = await byEmail(normEmail(rawEmail));
      if (!user || user.status !== 'pending') return { ok: true };      // same answer for every email
      return { ok: true, ...(await issueOtp(user)) };
    },

    async verifyOtp(rawEmail, rawCode) {
      const user = await byEmail(normEmail(rawEmail));
      const code = String(rawCode ?? '').trim();
      const invalid = new HttpError(400, 'INVALID_CODE', 'That code is not valid. Check the email and try again.');
      if (!user || user.status !== 'pending' || !/^\d{6}$/.test(code)) throw invalid;
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
      await audit(db, user.id, 'signup_verified', user.id);
      return publicUser(await byEmail(user.email));
    },

    async login(rawEmail, password) {
      const user = await byEmail(normEmail(rawEmail));
      const bad = new HttpError(401, 'BAD_CREDENTIALS', 'Incorrect email or password.');
      if (!user || !user.password_hash) { await burnPasswordTime(String(password ?? '')); throw bad; }
      if (!(await verifyPassword(String(password ?? ''), user.password_hash))) throw bad;
      if (user.status === 'disabled') throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is disabled.');
      if (user.status === 'pending') throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email to finish creating the account.', { email: user.email });
      return publicUser(user);
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
