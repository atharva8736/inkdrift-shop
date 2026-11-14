#!/usr/bin/env bash
# Run on a fresh Ubuntu 22.04/24.04 VPS as root:  bash setup-youpi.sh pay.yourdomain.com https://inkdrift-shop-fvfb.vercel.app
# Installs Node 24, YOUPI PG, runs it under pm2, and puts Caddy (automatic HTTPS) in front of it.
set -euo pipefail
DOMAIN="${1:?usage: setup-youpi.sh pay.yourdomain.com https://your-shop-origin}"; SHOP="${2:?shop origin missing}"
apt-get update -y && apt-get install -y curl git ca-certificates debian-keyring debian-archive-keyring apt-transport-https gpg
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
npm i -g pm2
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy.list
apt-get update -y && apt-get install -y caddy
id -u youpi >/dev/null 2>&1 || useradd -m -s /bin/bash youpi
sudo -u youpi bash -lc '
  cd ~ && [ -d youpi-pg ] || git clone https://github.com/youpi-pg/YouPI-PG.git youpi-pg
  cd youpi-pg && npm install && [ -f .env ] || cp .env.example .env'
ENV=/home/youpi/youpi-pg/.env
rnd() { node -e "console.log(require(\"crypto\").randomBytes($1).toString(\"hex\"))"; }
set_kv() { grep -q "^$1=" "$ENV" && sed -i "s|^$1=.*|$1=$2|" "$ENV" || echo "$1=$2" >> "$ENV"; }
set_kv NODE_ENV production
set_kv ENCRYPTION_MASTER_KEY "$(rnd 32)"
set_kv JWT_SECRET "$(rnd 24)"
set_kv BASE_PAYMENT_API_URL "https://$DOMAIN"
set_kv BASE_CHECKOUT_URL "https://$DOMAIN"
set_kv BASE_ADMIN_URL "http://localhost:6001"
set_kv YOUPI_ALLOWED_ORIGINS "$SHOP"
set_kv YOUPI_ALLOWED_RETURN_ORIGINS "$SHOP"
set_kv CHECKOUT_FRAME_ANCESTORS "$SHOP"
set_kv DEFAULT_APP_NAME "Inkdrift"
chmod 600 "$ENV"; chown youpi:youpi "$ENV"
sudo -u youpi bash -lc 'cd ~/youpi-pg && npm run db:setup'
sudo -u youpi bash -lc 'cd ~/youpi-pg && pm2 start npm --name youpi -- run start && pm2 save'
env PATH=$PATH:/usr/bin pm2 startup systemd -u youpi --hp /home/youpi | tail -1 | bash
cat > /etc/caddy/Caddyfile <<C
$DOMAIN {
  reverse_proxy localhost:7000
}
C
systemctl reload caddy
echo; echo "YOUPI is starting. Check:  curl https://$DOMAIN/health   (or http://localhost:6100/health on the server)"
echo "Admin panel is NOT public. Open it from your laptop with:  ssh -L 6001:localhost:6001 root@<server-ip>   then http://localhost:6001"
echo "Admin login + tokens: see $ENV and /home/youpi/youpi-pg/data/.secrets/"
