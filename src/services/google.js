import { token, sha256, sign, unsign, safeEqual } from '../lib/crypto.js';
import { HttpError, safeNext } from '../lib/http.js';
import crypto from 'node:crypto';

const COOKIE = 'ink_oauth';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export function createGoogleService({ cfg, auth }) {
  const redirectUri = `${cfg.appUrl}/api/auth/google/callback`;
  const enabled = () => !!(cfg.google.clientId && cfg.google.clientSecret);

  return {
    enabled,
    cookie: COOKIE,
    redirectUri,

    // Step 1: send the user to Google with state, nonce and a PKCE challenge.
    begin(nextPath) {
      if (!enabled()) throw new HttpError(503, 'GOOGLE_DISABLED', 'Google sign-in is not configured.');
      const state = token(24), nonce = token(24), verifier = token(48);
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const url = new URL(cfg.google.authUrl);
      url.search = new URLSearchParams({
        client_id: cfg.google.clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
        prompt: 'select_account',
      }).toString();
      const cookieValue = sign(cfg.sessionSecret, { state, nonce, verifier, next: safeNext(nextPath), exp: Date.now() + 10 * 60_000 });
      return { url: url.toString(), cookieValue };
    },

    // Step 2: verify state, trade the code for tokens, validate the ID token, upsert the user.
    async complete({ code, state, cookieValue }) {
      const saved = unsign(cfg.sessionSecret, cookieValue);
      if (!saved || saved.exp < Date.now() || !state || !safeEqual(saved.state, state)) {
        throw new HttpError(400, 'OAUTH_STATE', 'Your sign-in session expired. Please try again.');
      }
      if (!code) throw new HttpError(400, 'OAUTH_NO_CODE', 'Google did not return a sign-in code.');
      let tok;
      try {
        const res = await fetch(cfg.google.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code, client_id: cfg.google.clientId, client_secret: cfg.google.clientSecret,
            redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: saved.verifier,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        tok = await res.json();
        if (!res.ok || !tok.id_token) throw new Error(tok.error_description || tok.error || `status ${res.status}`);
      } catch (e) {
        console.error('[google] token exchange failed:', e.message);
        throw new HttpError(502, 'OAUTH_EXCHANGE', 'Google sign-in failed. Please try again.');
      }
      // The ID token came straight from Google's token endpoint over TLS, so its claims are checked, not re-signed.
      let claims;
      try { claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString()); }
      catch { throw new HttpError(502, 'OAUTH_TOKEN', 'Google returned an unreadable token.'); }
      const ok = ISSUERS.includes(claims.iss) && claims.aud === cfg.google.clientId && claims.exp * 1000 > Date.now()
        && claims.nonce === saved.nonce && claims.sub && claims.email;
      if (!ok) throw new HttpError(401, 'OAUTH_CLAIMS', 'Google sign-in could not be verified.');
      if (claims.email_verified !== true && claims.email_verified !== 'true') {
        throw new HttpError(403, 'OAUTH_UNVERIFIED', 'Your Google email is not verified.');
      }
      const user = auth.upsertGoogleUser({ sub: claims.sub, email: claims.email, name: claims.name, picture: claims.picture });
      return { user, next: saved.next };
    },
  };
}
