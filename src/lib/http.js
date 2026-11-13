export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status; this.code = code; this.extra = extra;
  }
}
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const normEmail = (e) => String(e ?? '').trim().toLowerCase();
export function safeNext(n) {          // only allow same-site relative redirects
  return typeof n === 'string' && /^\/[^/\\]/.test(n) || n === '/' ? n : '/';
}
