#!/bin/bash
# server-setup.sh
#
# One-time setup for spiro.mchugh.au on Linode Debian.
# Run as root or with sudo:
#   sudo bash scripts/server-setup.sh
#
# Assumes Caddy and the "deploy" user (with the GitHub Actions SSH key) already
# exist from an earlier project's setup (e.g. moon/train). If they don't, run
# that project's server-setup.sh first. Caddy auto-provisions TLS via
# Let's Encrypt.
#
# After running, you still need to (manually):
#   1. Add the printed site block to /etc/caddy/Caddyfile and run:
#      sudo systemctl reload caddy
#   2. Fill in MONITOR_API_KEY in /var/www/spiro/.env
#   3. Push to main (or rerun the deploy workflow) to install the binary

set -e

echo "=== spiro - Server Deployment Setup ==="

# ---------------------------------------------------------------
# 1. Application directory
# ---------------------------------------------------------------
APP_DIR="/var/www/spiro"
if [ -d "$APP_DIR" ]; then
    echo "[ok] Application directory $APP_DIR already exists"
else
    mkdir -p "$APP_DIR"
    chown www-data:www-data "$APP_DIR"
    echo "[ok] Created application directory $APP_DIR"
fi

# ---------------------------------------------------------------
# 2. .env template
# ---------------------------------------------------------------
ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    echo "[ok] .env file already exists at $ENV_FILE (not overwriting)"
else
    cat > "$ENV_FILE" << 'ENV_TEMPLATE'
# Port the server listens on (Caddy proxies spiro.mchugh.au here)
PORT=8993

# Monitor portal log shipping (optional)
MONITOR_URL=https://monitor.mchugh.au
MONITOR_API_KEY=
ENV_TEMPLATE
    chown www-data:www-data "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "[ok] Created .env at $ENV_FILE - fill in MONITOR_API_KEY"
fi

# ---------------------------------------------------------------
# 3. systemd service
# ---------------------------------------------------------------
SERVICE_FILE="/etc/systemd/system/spiro.service"
cat > "$SERVICE_FILE" << 'SERVICE'
[Unit]
Description=Spiro Spirograph drawing app
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/spiro
EnvironmentFile=/var/www/spiro/.env
ExecStart=/var/www/spiro/spiro
Restart=on-failure
RestartSec=5

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
echo "[ok] Created systemd service at $SERVICE_FILE"

# ---------------------------------------------------------------
# 4. Install the deploy script (runs as root via sudo).
#    Subsequent deployments self-update via the script's bundle-diff logic.
# ---------------------------------------------------------------
DEPLOY_SCRIPT_URL="https://raw.githubusercontent.com/exploded/spiro/main/scripts/deploy-spiro"
if ! curl -fsSL "$DEPLOY_SCRIPT_URL" -o /usr/local/bin/deploy-spiro; then
    echo "[error] Failed to download deploy-spiro from $DEPLOY_SCRIPT_URL"
    exit 1
fi
chmod +x /usr/local/bin/deploy-spiro
echo "[ok] Installed /usr/local/bin/deploy-spiro"

# ---------------------------------------------------------------
# 5. sudoers - allow the existing deploy user to run our deploy script
# ---------------------------------------------------------------
SUDOERS_FILE="/etc/sudoers.d/spiro-deploy"
cat > "$SUDOERS_FILE" << 'EOF'
deploy ALL=(ALL) NOPASSWD: /usr/local/bin/deploy-spiro
deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop spiro
EOF
chmod 440 "$SUDOERS_FILE"
visudo -c -f "$SUDOERS_FILE"
echo "[ok] sudoers entry created at $SUDOERS_FILE"

# ---------------------------------------------------------------
# 6. Caddy site block - print snippet for the user to add manually
# ---------------------------------------------------------------
echo ""
echo "[note] Add the following block to /etc/caddy/Caddyfile, then run:"
echo "       sudo systemctl reload caddy"
cat << 'CADDY'

spiro.mchugh.au {
    import access_log
    reverse_proxy 127.0.0.1:8993 {
        header_up X-Real-IP {client_ip}
    }
}

CADDY

echo "=== Setup complete ==="
echo "Next manual steps:"
echo "  1. Add the Caddy block above to /etc/caddy/Caddyfile, then:"
echo "     sudo systemctl reload caddy"
echo "  2. Edit $ENV_FILE and set MONITOR_API_KEY"
echo "  3. Rerun the GitHub Actions deploy to install the binary"
