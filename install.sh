#!/bin/sh
# Cloudly installer. Turns a fresh Ubuntu or Debian VM into a Cloudly station:
#   curl -fsSL https://raw.githubusercontent.com/AymanKhan9/Cloudly/main/install.sh | sh
# Re-running it upgrades in place and keeps your .env.
set -eu

REPO="${CLOUDLY_REPO:-https://github.com/AymanKhan9/Cloudly.git}"
BRANCH="${CLOUDLY_BRANCH:-main}"
DIR="${CLOUDLY_DIR:-/opt/cloudly}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "Cloudly installs on Linux."
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else
  command -v sudo >/dev/null 2>&1 || die "Run as root, or install sudo."
  SUDO="sudo"
fi
. /etc/os-release
case "${ID:-} ${ID_LIKE:-}" in
  *debian*|*ubuntu*) ;;
  *) die "This installer supports Ubuntu and Debian. Found: ${PRETTY_NAME:-unknown}." ;;
esac

TTY=""
if [ -z "${CLOUDLY_NONINTERACTIVE:-}" ] && (exec </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi

# ask VAR "Question" [default] [secret]
ask() {
  _var=$1; _q=$2; _def=${3:-}; _secret=${4:-}
  eval "_cur=\${$_var:-}"
  [ -n "$_cur" ] && return 0
  if [ -z "$TTY" ]; then eval "$_var=\$_def"; return 0; fi
  if [ -n "$_def" ]; then printf '  %s [%s]: ' "$_q" "$_def" >/dev/tty; else printf '  %s: ' "$_q" >/dev/tty; fi
  if [ -n "$_secret" ]; then stty -echo </dev/tty; fi
  IFS= read -r _ans </dev/tty || _ans=""
  if [ -n "$_secret" ]; then stty echo </dev/tty; printf '\n' >/dev/tty; fi
  [ -z "$_ans" ] && _ans=$_def
  eval "$_var=\$_ans"
}

# --- 1. System packages, Docker, Bun -------------------------------------------
say "Installing system packages"
$SUDO apt-get update -qq
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates unzip openssl >/dev/null

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | $SUDO sh >/dev/null
fi
$SUDO systemctl enable --now docker >/dev/null 2>&1 || true

# System-wide, so every service user can run it (a copy in someone's ~/.bun can't).
BUN=/usr/local/bin/bun
if [ ! -x "$BUN" ]; then
  say "Installing Bun"
  curl -fsSL https://bun.sh/install | $SUDO env BUN_INSTALL=/usr/local bash >/dev/null
fi

# --- 2. Swap on small VMs ---------------------------------------------------------
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 2000 ] && [ "$(awk 'NR>1' /proc/swaps | wc -l)" -eq 0 ]; then
  say "Adding a 2 GB swap file (this VM has ${MEM_MB} MB of RAM)"
  $SUDO fallocate -l 2G /swapfile
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
fi

# --- 3. Service user (uid 1000, so run sandboxes can write their workspace) -------
RUN_USER=$(getent passwd 1000 | cut -d: -f1 || true)
if [ -z "$RUN_USER" ]; then
  $SUDO useradd --uid 1000 --create-home --shell /bin/bash cloudly
  RUN_USER=cloudly
fi
$SUDO usermod -aG docker "$RUN_USER"
# The API and web app face the internet, so they run as a user without Docker
# access (the docker group is root in all but name). Only the worker starts containers.
APP_USER=cloudly-app
id "$APP_USER" >/dev/null 2>&1 || $SUDO useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$APP_USER"
say "The worker runs as ${RUN_USER} (uid 1000); the API and web app run as ${APP_USER}"

# --- 4. Code ----------------------------------------------------------------------
# Prefer the prebuilt release (no 2 GB `next build` on a small VM). Falls back to
# building from source if there is no release for this CPU, or CLOUDLY_FROM_SOURCE=1.
PREBUILT=""
case "$(uname -m)" in x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH="" ;; esac
if [ -z "${CLOUDLY_FROM_SOURCE:-}" ] && [ -n "$ARCH" ]; then
  RELEASE_URL="${CLOUDLY_RELEASE_URL:-https://github.com/AymanKhan9/Cloudly/releases/latest/download/cloudly-linux-$ARCH.tar.gz}"
  TARBALL=$(mktemp)
  say "Downloading the Cloudly release"
  if curl -fsSL "$RELEASE_URL" -o "$TARBALL"; then
    $SUDO mkdir -p "$DIR"
    $SUDO chown "$RUN_USER" "$DIR"
    $SUDO chmod 644 "$TARBALL"
    $SUDO -u "$RUN_USER" tar -xzf "$TARBALL" -C "$DIR"
    PREBUILT=1
  else
    warn "No prebuilt release found; building from source instead."
  fi
  rm -f "$TARBALL"
fi
if [ -z "$PREBUILT" ]; then
  if [ -d "$DIR/.git" ]; then
    say "Updating ${DIR}"
    $SUDO -u "$RUN_USER" git -C "$DIR" pull --ff-only
  else
    say "Cloning Cloudly into ${DIR}"
    $SUDO mkdir -p "$DIR"
    $SUDO chown "$RUN_USER" "$DIR"
    $SUDO -u "$RUN_USER" git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
  fi
fi

# --- 5. Configuration ---------------------------------------------------------------
# Only the address is asked here. The GitHub App, model keys and sign-in list are
# set up in the browser (first-run setup), where they're stored encrypted.
ENV_FILE="$DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  say "Configuring this station (press Enter to accept a default)"
  IP=$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  ask DOMAIN "Domain pointing at this VM, for HTTPS (leave empty to use the IP)" ""
  if [ -n "$DOMAIN" ]; then DEFAULT_URL="https://$DOMAIN"; else DEFAULT_URL="http://$IP:3000"; fi
  ask PUBLIC_URL "Public URL" "$DEFAULT_URL"
  ask DB_URL "Your own Postgres URL (leave empty to run Postgres on this VM)" ""
  case "$DB_URL" in
    ""|postgres://*|postgresql://*) ;;
    *) die "The database URL must start with postgres:// or postgresql://" ;;
  esac
  # Bun expands $NAME inside .env values, which would silently mangle a password.
  DB_URL=$(printf '%s' "$DB_URL" | sed 's/\$/%24/g')

  PG_PASS=$(openssl rand -hex 24)
  if [ -n "$DB_URL" ]; then LOCAL_PG=0; else LOCAL_PG=1; DB_URL="postgresql://cloudly:$PG_PASS@127.0.0.1:5432/cloudly"; fi
  SETUP_TOKEN=$(openssl rand -hex 16)
  SECRET_KEY=$(openssl rand -base64 32)
  $SUDO -u "$RUN_USER" sh -c "umask 077; cat > '$ENV_FILE'" <<EOF
PUBLIC_URL=$PUBLIC_URL
WEB_ORIGIN=$PUBLIC_URL
API_ORIGIN=$PUBLIC_URL/api
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$PG_PASS
LOCAL_POSTGRES=$LOCAL_PG
DATABASE_URL=$DB_URL
API_PORT=8787
CLOUDLY_SETUP_TOKEN=$SETUP_TOKEN
CLOUDLY_SECRET_KEY=$SECRET_KEY
WORKER_CONCURRENCY=1
EOF
else
  say "Keeping existing ${ENV_FILE}"
fi

# Installs from before browser setup have no master key in .env. Reuse the one the
# worker generated, if any, so stored keys stay readable now that the API runs as
# another user and can't see that file.
if ! grep -q '^CLOUDLY_SECRET_KEY=.' "$ENV_FILE"; then
  OLD_KEY="$(getent passwd "$RUN_USER" | cut -d: -f6)/.cloudly/secret.key"
  if $SUDO test -f "$OLD_KEY"; then KEY=$($SUDO cat "$OLD_KEY"); else KEY=$(openssl rand -base64 32); fi
  echo "CLOUDLY_SECRET_KEY=$KEY" | $SUDO tee -a "$ENV_FILE" >/dev/null
fi
# Owner (worker) reads and writes, the API reads through the group, nobody else.
$SUDO chgrp "$APP_USER" "$ENV_FILE"
$SUDO chmod 640 "$ENV_FILE"

# Bun only auto-loads the .env in its working directory; every package that
# reads env points at the one file. Not apps/web: it needs nothing at runtime, and
# `next build` copies whatever .env it loads into the standalone output.
for d in packages/db apps/api apps/worker; do
  $SUDO -u "$RUN_USER" ln -sf "$ENV_FILE" "$DIR/$d/.env"
done
$SUDO rm -f "$DIR/apps/web/.env" "$DIR/apps/web/.next/standalone/apps/web/.env"

# --- 6. Database ----------------------------------------------------------------------
cd "$DIR"
COMPOSE="docker compose -f deploy/docker-compose.yml --env-file $ENV_FILE"
# Older installs have no LOCAL_POSTGRES line; they always ran Postgres here.
if grep -q '^LOCAL_POSTGRES=0' "$ENV_FILE"; then
  say "Using your own Postgres (DATABASE_URL in ${ENV_FILE})"
else
  say "Starting Postgres"
  $SUDO $COMPOSE up -d --wait postgres >/dev/null
fi
if grep -q '^DOMAIN=.\+' "$ENV_FILE"; then
  say "Starting Caddy for HTTPS"
  $SUDO $COMPOSE --profile https up -d caddy >/dev/null
fi

# --- 7. Build -------------------------------------------------------------------------
say "Installing dependencies"
$SUDO -u "$RUN_USER" "$BUN" install --frozen-lockfile >/dev/null
say "Migrating the database"
# Without Prisma's advisory lock: through a connection pooler (Neon's pooled URL,
# Supabase's pooler) the unlock can land on another connection and leave the lock
# held, and every later upgrade times out on it. The installer is the only migrator.
$SUDO -u "$RUN_USER" sh -c "cd '$DIR/packages/db' && PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK=1 '$BUN' x prisma migrate deploy >/dev/null" \
  || die "Couldn't migrate the database. Check DATABASE_URL in ${ENV_FILE}, and that the database accepts connections from this VM."
$SUDO -u "$RUN_USER" sh -c "cd '$DIR/packages/db' && '$BUN' x prisma generate >/dev/null"
if [ -z "$PREBUILT" ]; then
say "Building the web app"
$SUDO -u "$RUN_USER" sh -c "cd '$DIR/apps/web' && '$BUN' run build >/dev/null && cp -r .next/static .next/standalone/apps/web/.next/ && if [ -d public ]; then cp -r public .next/standalone/apps/web/; fi"
fi
say "Building the run sandbox image (a few minutes the first time)"
$SUDO docker build -q -t cloud-agents-base infra/images/base >/dev/null

# --- 8. Services ----------------------------------------------------------------------
unit() {
  $SUDO tee "/etc/systemd/system/cloudly-$1.service" >/dev/null <<EOF
[Unit]
Description=Cloudly $1
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=$2
WorkingDirectory=$3
ExecStart=$4
Environment=$5
NoNewPrivileges=yes
Restart=always
RestartSec=3
KillSignal=SIGINT
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF
}
WEB_DIR="$DIR/apps/web/.next/standalone/apps/web"
# The only place the web app writes.
$SUDO install -d -o "$APP_USER" "$WEB_DIR/.next/cache"
unit api "$APP_USER" "$DIR" "$BUN apps/api/src/index.ts" "NODE_ENV=production"
unit worker "$RUN_USER" "$DIR" "$BUN apps/worker/src/main.ts" "NODE_ENV=production"
unit web "$APP_USER" "$WEB_DIR" "$BUN server.js" "NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0"

$SUDO systemctl daemon-reload
for s in api worker web; do
  $SUDO systemctl enable "cloudly-$s" >/dev/null 2>&1
  $SUDO systemctl restart "cloudly-$s"
done

# --- 9. Next steps --------------------------------------------------------------------
# Read values instead of sourcing the file: a database URL can contain & or $.
PUBLIC_URL=$(grep '^PUBLIC_URL=' "$ENV_FILE" | cut -d= -f2- || true)
CLOUDLY_SETUP_TOKEN=$(grep '^CLOUDLY_SETUP_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)
printf '\n\033[1;32mCloudly is running.\033[0m\n\n'
printf '  1. Open  %s/setup\n' "${PUBLIC_URL:-http://<this-ip>:3000}"
printf '  2. Enter this setup token:  %s\n' "${CLOUDLY_SETUP_TOKEN:-(see CLOUDLY_SETUP_TOKEN in the .env)}"
printf '  3. Follow the three steps: who can sign in, create the GitHub App, choose repositories.\n'
printf '  4. Sign in, then add a model key under Settings.\n\n'
printf '  Config: %s   Logs: journalctl -u cloudly-worker -f\n' "$ENV_FILE"
case "${PUBLIC_URL:-}" in http://*) warn "Open port 3000 in your cloud firewall, or set a domain for HTTPS on 443." ;; esac
