#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu 22.04/24.04 DigitalOcean Droplet.
#   curl -fsSL <raw url of this file> | sudo DOMAIN=terminal.example.com EMAIL=you@example.com bash
# or, from a clone:  sudo DOMAIN=... EMAIL=... bash deploy/setup-droplet.sh
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN=your.domain}"
EMAIL="${EMAIL:?set EMAIL=you@example.com (Let's Encrypt notices)}"
REPO="${REPO:-https://github.com/britto8598/dhan_skills.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/orderflow-terminal}"

echo "==> packages"
apt-get update -y
apt-get install -y ca-certificates curl git nginx certbot python3-certbot-nginx ufw
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> firewall (SSH + HTTP/HTTPS only; the app port stays on localhost)"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "==> code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH" && git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

echo "==> build & start container"
cd "$APP_DIR/terminal"
docker compose up -d --build

echo "==> nginx"
sed "s/terminal.example.com/$DOMAIN/g" deploy/nginx.conf > /etc/nginx/sites-available/orderflow-terminal
ln -sf /etc/nginx/sites-available/orderflow-terminal /etc/nginx/sites-enabled/orderflow-terminal
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> TLS (Let's Encrypt)"
certbot --nginx --non-interactive --agree-tos --redirect -m "$EMAIL" -d "$DOMAIN"

echo "==> done: https://$DOMAIN  (feed: wss://$DOMAIN/feed)"
echo "Update later with:  cd $APP_DIR && git pull && cd terminal && docker compose up -d --build"
