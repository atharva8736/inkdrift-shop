import { HttpError } from '../lib/http.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Real email delivery through the Resend REST API. The key stays on the server.
export function resendTransport(cfg) {
  return async ({ to, subject, html, text }) => {
    const res = await fetch(cfg.email.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.email.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.email.from, to: [to], subject, html, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json().catch(() => ({}));
  };
}

// Real email delivery through the Brevo transactional API. EMAIL_FROM must be a sender verified in Brevo.
export function brevoTransport(cfg) {
  const m = String(cfg.email.from).match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  const sender = m ? { name: (m[1] || cfg.email.brand).trim(), email: m[2].trim() } : { name: cfg.email.brand, email: String(cfg.email.from).trim() };
  return async ({ to, subject, html, text }) => {
    const res = await fetch(cfg.email.apiUrl, {
      method: 'POST',
      headers: { 'api-key': cfg.email.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Brevo responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json().catch(() => ({}));
  };
}

export function createEmailService(cfg, transport = cfg.email.provider === 'brevo' ? brevoTransport(cfg) : resendTransport(cfg)) {
  const brand = cfg.email.brand;
  return {
    async sendOtp({ to, name, code, ttlMinutes, purpose = 'signup' }) {
      const login = purpose === 'login';
      const subject = `${code} is your ${brand} ${login ? 'login' : 'verification'} code`;
      const text = `Hi ${name},\n\nYour ${brand} ${login ? 'login' : 'verification'} code is ${code}.\nIt expires in ${ttlMinutes} minutes. If you did not ${login ? 'try to log in' : 'create an account'}, ignore this email.\n`;
      const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:32px;background:#07080c;color:#ece7db">
<h1 style="margin:0 0 4px;font-size:28px">INK<i style="color:#4a63ff">drift</i></h1>
<p style="color:#8e93a3;margin:0 0 28px">${login ? 'Log in' : 'Verify your email'}</p>
<p>Hi ${esc(name)}, enter this code to ${login ? 'log in' : 'finish creating your account'}:</p>
<p style="font-size:40px;letter-spacing:10px;font-weight:700;margin:24px 0">${code}</p>
<p style="color:#8e93a3">The code expires in ${ttlMinutes} minutes. If you did not ${login ? 'try to log in' : 'create an account'}, you can ignore this email.</p></div>`;
      try { await transport({ to, subject, html, text }); }
      catch (e) {
        console.error('[email] send failed:', e.message);
        throw new HttpError(502, 'EMAIL_SEND_FAILED', 'We could not send the verification email. Please try again in a moment.');
      }
    },
  };
}
