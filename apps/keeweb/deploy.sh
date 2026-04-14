#!/usr/bin/env bash
#
# Deploy KeeWeb v1.18.7 to kw.igg.ms via SSH
# Host: box.heatvision.co (Mail-In-A-Box)
#
set -euo pipefail

HOST="${HOST:-box.heatvision.co}"
REMOTE_USER="${REMOTE_USER:-deploy-kw}"
SITE_DIR="${SITE_DIR:-/home/user-data/www/kw.igg.ms}"
STAGING_DIR="${STAGING_DIR:-/home/deploy-kw/staging}"
ACTIVATE_CMD="${ACTIVATE_CMD:-/usr/local/bin/kw-deploy-activate}"
DEPLOY_DIR="$(cd "$(dirname "$0")/dist" && pwd)"
WITH_NGINX=false

log() { printf "\033[1;34m==>\033[0m %s\n" "$1"; }

usage() {
    cat <<'EOF'
Usage: bash deploy.sh [--nginx]

Defaults to content-only deploy. Use --nginx to also stage nginx config
and run activation with nginx update.
EOF
}

if [ "${1:-}" = "--nginx" ]; then
    WITH_NGINX=true
elif [ "$#" -gt 0 ]; then
    usage
    exit 1
fi

# Validate
if [ ! -f "$DEPLOY_DIR/index.html" ]; then
    echo "ERROR: dist directory missing index.html" >&2
    exit 1
fi
if [ ! -f "$DEPLOY_DIR/config.json" ]; then
    echo "ERROR: dist directory missing config.json" >&2
    exit 1
fi
if [ "$WITH_NGINX" = true ] && [ ! -f "$DEPLOY_DIR/kw.igg.ms.conf" ]; then
    echo "ERROR: dist directory missing kw.igg.ms.conf for --nginx deploy" >&2
    exit 1
fi
if [ "$WITH_NGINX" = true ] && [ ! -f "$DEPLOY_DIR/kw-security-headers.conf" ]; then
    echo "ERROR: dist directory missing kw-security-headers.conf for --nginx deploy" >&2
    exit 1
fi

log "Deploying KeeWeb v1.18.7 to $HOST"

# Backup existing site to deploy user's home
BACKUP_DIR="/home/${REMOTE_USER}/backups"
log "Backing up current site on remote"
ssh "${REMOTE_USER}@${HOST}" "
    mkdir -p '$BACKUP_DIR'
    if [ -d '$SITE_DIR' ]; then
        rsync -a '$SITE_DIR/' '$BACKUP_DIR/kw.igg.ms.$(date +%Y%m%d%H%M)/'
    fi
"

# Upload site files (exclude nginx conf)
log "Uploading site files"
rsync -rlvz --delete --no-times --no-perms \
    --exclude='kw.igg.ms.conf' \
    --exclude='kw-security-headers.conf' \
    --exclude='.DS_Store' \
    "$DEPLOY_DIR/" "${REMOTE_USER}@${HOST}:${SITE_DIR}/"

if [ "$WITH_NGINX" = true ]; then
    log "Staging nginx config and security headers snippet for activation"
    scp "$DEPLOY_DIR/kw.igg.ms.conf" "${REMOTE_USER}@${HOST}:${STAGING_DIR}/kw.igg.ms.conf"
    scp "$DEPLOY_DIR/kw-security-headers.conf" "${REMOTE_USER}@${HOST}:${STAGING_DIR}/kw-security-headers.conf"

    log "Activating site content and nginx config"
    ssh "${REMOTE_USER}@${HOST}" "sudo '$ACTIVATE_CMD' --nginx"
else
    log "Activating site content"
    ssh "${REMOTE_USER}@${HOST}" "sudo '$ACTIVATE_CMD'"
fi

log "Done! Site live at https://kw.igg.ms/"
