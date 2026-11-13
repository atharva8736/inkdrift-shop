import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const N = 32768, R = 8, P = 1, KEYLEN = 64;

export const uuid = () => crypto.randomUUID();
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [alg, n, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const key = await scrypt(password, Buffer.from(salt, 'base64'), KEYLEN, { N: +n, r: +r, p: +p, maxmem: 128 * 1024 * 1024 });
    return crypto.timingSafeEqual(key, Buffer.from(hash, 'base64'));
  } catch { return false; }
}

// A dummy hash so unknown emails cost the same time as wrong passwords.
let dummy;
export async function burnPasswordTime(password) {
  dummy ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummy);
}

// Cryptographically random 6-digit code. The code is only ever stored as an HMAC.
export const generateOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
export const otpHash = (secret, otpId, code) => hmacHex(secret, `otp:${otpId}:${code}`);

// Short-lived signed blob used for the OAuth state cookie.
export const sign = (secret, obj) => {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${body}.${hmacHex(secret, body)}`;
};
export const unsign = (secret, str) => {
  if (typeof str !== 'string') return null;
  const [body, mac] = str.split('.');
  if (!body || !mac || !safeEqual(mac, hmacHex(secret, body))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
};
