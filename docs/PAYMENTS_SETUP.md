# Getting paid: YOUPI setup, step by step

Money path: customer pays by UPI -> straight into YOUR bank account -> your bank sends a credit alert -> YOUPI sees the alert -> the shop unlocks the download.
Your bank login, account number and UPI PIN are never entered anywhere.

YOUPI is experimental (its README says so) and has no LICENSE file. Read SECURITY notes in its repo before taking real money.

## A. Rent a server (you, ~10 min)
- Ubuntu 22.04/24.04 VPS, 1 GB RAM is enough (Hetzner, DigitalOcean, Contabo...). Note its IP.
- Buy or use a domain; add a DNS **A record**: `pay.yourdomain.com` -> server IP.

## B. Install YOUPI (you paste one command, ~5 min)
SSH in as root and run:
```
curl -fsSL https://raw.githubusercontent.com/atharva8736/inkdrift-shop/main/deploy/setup-youpi.sh -o setup-youpi.sh
bash setup-youpi.sh pay.yourdomain.com https://inkdrift-shop-fvfb.vercel.app
```
It installs Node 24, YOUPI, pm2 (auto-restart) and Caddy (automatic HTTPS), and generates the secrets.
Check: `curl https://pay.yourdomain.com/health` should show `{"status":"UP"}`.

## C. Your bank (you, in YOUPI's admin panel)
The admin panel is deliberately not public. From your laptop: `ssh -L 6001:localhost:6001 root@SERVER_IP`, then open http://localhost:6001
1. Log in (admin credentials/token are in `/home/youpi/youpi-pg/.env` and `data/.secrets/`).
2. **Receiving Accounts**: enter your UPI ID and the name on the bank account. This is the only bank detail anywhere.
3. **Observers & Pairing** (pick one):
   - Android: install `apps/android-observer-app/youpi-sms-gateway.apk` on a phone that receives your bank SMS/UPI notifications, pair with the QR/token, grant Notification access.
   - Gmail: make your bank send alerts to a Gmail address, create Google OAuth credentials (Gmail API), put `GMAIL_CLIENT_ID/SECRET` in `.env`, authorise.
4. Copy the **merchant webhook secret** shown for the merchant (default merchant id `00000000-0000-0000-0000-000000000001`).
5. Set the merchant **webhook URL** to `https://inkdrift-shop-fvfb.vercel.app/api/webhooks/youpi`.

## D. Connect the shop (you, in Vercel -> Settings -> Environment Variables, Production)
- `YOUPI_API_URL` = `https://pay.yourdomain.com`
- `YOUPI_WEBHOOK_SECRET` = the merchant webhook secret from step C4 (also used as the merchant key)
- `YOUPI_UNLOCK_POLICY` = `reconciled` (safe: unlocks after you import your bank statement CSV in YOUPI) or `observed` (unlocks on the bank alert; faster, but a fake alert could fool it)
Redeploy. Don't paste these values into chat.

## E. Test
Buy one Rs 99 wallpaper yourself. Check: payment appears in YOUPI, money in your bank, download unlocks.
With `reconciled`, import your statement in YOUPI first, then the download unlocks.
