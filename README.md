# Inkdrift – store with real backend

Node ≥22.5, Express on Vercel serverless, Turso (libSQL) database, Vercel Blob file storage. Frontend is `public/index.html` (same design as the preview).

## 1. Features
Google OAuth (code+PKCE+state+nonce, one account per email) · passwordless email OTP for both signup and login (6 digits, HMAC-hashed, 5-min expiry, 5 attempts, 60 s resend cooldown, 5 sends/h) · httpOnly sessions + CSRF header · server-priced orders and coupons · YOUPI UPI payments with signed webhook, server-side re-confirmation, duplicate prevention · entitlements per pack (bundle = itself + 4 packs) · private ZIP downloads only for owners · purchase history · admin CLI.

## 2. APIs / services
Google OAuth 2.0, Resend (`POST /emails`), YOUPI PG (`POST /api/v1/payments`, `GET /api/v1/payments/{id}`, webhook). Own routes: `/api/auth/*`, `/api/catalog`, `/api/quote`, `/api/orders[/:id[/cancel]]`, `/api/library`, `/api/download/:packId`, `/api/webhooks/youpi`, `/api/me`, `/api/health`.

## 3. Environment variables
See `.env.example`. Extras: `SESSION_TTL_DAYS, OTP_TTL_SECONDS, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_SECONDS, OTP_MAX_SENDS_PER_HOUR, YOUPI_WEBHOOK_MAX_AGE_MINUTES, YOUPI_TIMEOUT_MS, ORDER_PENDING_WINDOW_MINUTES, MAX_PAID_ORDERS_PER_USER_PER_DAY, BRAND_NAME`. Production start refuses to boot if required ones are missing.

## 4. Google OAuth credentials
1. console.cloud.google.com → new project → APIs & Services → OAuth consent screen (External; add scopes openid, email, profile; add yourself as test user, then Publish).
2. Credentials → Create credentials → OAuth client ID → Web application.
3. Authorized redirect URI: `APP_URL/api/auth/google/callback` (exact; add `http://localhost:3000/...` for dev).
4. Copy Client ID/secret into `GOOGLE_CLIENT_ID/SECRET`. The Google button appears automatically once set.

## 5. Email OTP (Brevo or Resend)
**Brevo (no domain needed):** brevo.com → sign up → Senders, Domains & Dedicated IPs → add and verify a sender email (you click a link sent to it) → SMTP & API → API Keys → create → set `BREVO_API_KEY` and `EMAIL_FROM="Inkdrift <your-verified-sender@gmail.com>"`. Brevo is used automatically when `BREVO_API_KEY` is set.

**Resend (needs your own domain):**
resend.com → Domains → add & verify your domain (DNS SPF/DKIM) → API Keys → create → `RESEND_API_KEY`. Set `EMAIL_FROM` to an address on that domain. A failed send returns an error and does not burn the resend cooldown.

## 6. Payment gateway (YOUPI PG) and connecting it to your bank
YOUPI is **not a bank-licensed gateway**. It watches your UPI receiving account for credit alerts and matches them to orders. Its own README calls it experimental, not for critical payments; it has no LICENSE file (package.json says "Commercial") – confirm you may use it.

**Connect to your bank**
1. Deploy YOUPI (payment-api, checkout-portal, merchant-admin, observers; Node ≥24, long-running host, HTTPS) following its README.
2. In Merchant Admin → Receiving Accounts add your UPI ID (VPA) and payee name of the bank account that should receive money.
3. Add an **observer** so YOUPI can see credits: Gmail observer (bank alert emails), Android observer app (pair via Merchant Admin → Observers & Pairing; reads bank SMS), or SMS/Google Messages observer. Make sure your bank sends credit alerts to that email/phone.
4. For strongest safety, import your bank statement CSV in Merchant Admin regularly → payments become RECONCILED.
5. Create a merchant → copy Merchant ID + API key → `YOUPI_MERCHANT_ID`, `YOUPI_MERCHANT_API_KEY`, set `YOUPI_API_URL`.
6. In YOUPI set the webhook URL `APP_URL/api/webhooks/youpi` and a secret → `YOUPI_WEBHOOK_SECRET`.
7. In YOUPI set `YOUPI_ALLOWED_ORIGINS` and `YOUPI_ALLOWED_RETURN_ORIGINS` to your storefront's exact HTTPS origin.
8. Make a ₹ small real test purchase. Check your bank's / NPCI's terms on collecting business payments via a personal UPI ID (a current/merchant account is advisable).

**Unlock policy** `YOUPI_UNLOCK_POLICY`: `observed` (default, your choice) unlocks when YOUPI sees a matching UPI credit alert and the backend re-confirms order id + amount with YOUPI. YOUPI's docs warn alerts (SMS/email) could be spoofed – so `reconciled` (unlock only after statement import) is the safe setting if files are valuable. Limits: ~20 attempts/day per receiving account, one payer at a time per VPA, INR only. Wallpapers use brand characters/logos – check IP risk before selling.

## 7. Database (Turso / libSQL)
Schema: `src/migrations/001_init.sql` (embedded via `npm run build:migrations` into `src/migrations/index.js`). Tables: users, email_otps, sessions, products, product_items, wallpapers, coupons, orders, order_items, payments, webhook_events, entitlements, audit_log. Money in paise. Migrations and the catalog seed run automatically on the first request after a deploy; `npm run migrate` does the same by hand. Locally (no `DATABASE_URL`) it uses a SQLite file in `data/`.

## 8. Tests
`npm install && npm test` → 36/36 backend tests (signup, OTP correct/wrong/expired/resend/limits, Google flow incl. state/nonce/existing user, login/logout/session persistence, pack+bundle purchase, success/failed/cancelled/pending, duplicate prevention, unlock only after confirmed payment, history isolation, downloads, webhook signature/replay). `node e2e/smoke.mjs` drives the real UI in headless Chrome. Resend/YOUPI/Google are local stand-ins in tests only; **live calls with real credentials, Turso and Vercel Blob were not possible in the build sandbox**, so do a real test after setup.

## 9. Deploy on Vercel (serverless)
Architecture: `public/` is served by Vercel's CDN, `api/index.js` runs the Express app as a function (`vercel.json` routes `/api/*` to it), Turso stores the data, a **private Vercel Blob** store holds the ZIPs.

1. **Turso**: turso.tech → sign up → Create database (region closest to Mumbai) → copy the *URL* (`libsql://...`) and create a *token* → these are `DATABASE_URL` and `DATABASE_AUTH_TOKEN`.
2. **Vercel Blob**: Vercel dashboard → your project → Storage → Create → Blob → choose **Private** → Connect to the project (this adds `BLOB_READ_WRITE_TOKEN` automatically).
3. **Upload the 4 ZIPs** into that Blob store using exactly these names: `Inkdrift_Vol1_Old_Money.zip`, `Inkdrift_Vol2_Time.zip`, `Inkdrift_Vol3_Machines.zip`, `Inkdrift_Vol4_Late_Nights.zip` (dashboard upload, or `npm run upload-packs -- <folder>` with the token in `.env`).
4. **Environment variables** (Project → Settings → Environment Variables, Production): `SESSION_SECRET` (`openssl rand -hex 32`), `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, plus when ready `RESEND_API_KEY`, `EMAIL_FROM`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `YOUPI_API_URL`, `YOUPI_MERCHANT_ID`, `YOUPI_MERCHANT_API_KEY`, `YOUPI_WEBHOOK_SECRET`, `YOUPI_UNLOCK_POLICY`. `APP_URL` is optional (defaults to your production Vercel address; set it for a custom domain).
5. Redeploy. Open `/api/health` → `{"ok":true}`. If it shows "Server is not configured. Set: …", add the variables it names and redeploy.
6. Admin CLI against the live DB: put `DATABASE_URL`/`DATABASE_AUTH_TOKEN` in a local `.env`, then `npm run admin -- orders | revoke <orderId> | disable <email>`.

Notes: rate limits are per serverless instance (best effort); OTP attempt limits, cooldowns and duplicate-payment protection are enforced in the database. YOUPI itself still needs its own always-on server (it is not hosted on Vercel).

Contact form and newsletter are still preview-only.

## Wallpaper protection

- **Visitors only ever receive watermarked, low-resolution previews.** `public/img/*` is generated by `python3 scripts/make-previews.py` from the clean sources in `private/preview-src` (INKdrift tiled watermark plus a "PREVIEW ONLY" band baked into the pixels, ~1100px wide, compressed).
- **Clean previews are owner-only**: `GET /api/preview/:packId/:n[?m=phone]` requires login and an active purchase (403 otherwise, `Cache-Control: no-store`).
- **Originals (4K ZIPs) are never public**: private Vercel Blob / private folder, streamed through `GET /api/download/:packId` after an ownership check. No storage path or key reaches the browser.
- **Front end deterrents** (right-click, drag, selection, copy blocked on previews; transparent overlay in the viewer) are only a deterrent. The real protection is that the original is never sent before purchase.
- **Adding or replacing artwork**: put clean previews in `private/preview-src` (`d_VolN_0K.jpg` desktop, `p_VolN_0K.jpg` phone), run `scripts/make-previews.py`, commit `public/img`.
- Tests: `test/protection.test.js` covers non-buyers, buyers and other customers.

## Design credit

The visual redesign follows the "unslop" method by Damir Sokolovsky (https://github.com/heydamir/unslop), licensed CC BY 4.0. Animations and all front-end behaviour are unchanged from the earlier version.
