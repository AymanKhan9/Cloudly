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

if ! command -v bun >/dev/null 2>&1; then
  say "Installing Bun"
  curl -fsSL https://bun.sh/install | $SUDO env BUN_INSTALL=/usr/local bash >/dev/null
fi
BUN=$(command -v bun)

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
say "Services will run as ${RUN_USER} (uid 1000)"

# --- 4. Code ----------------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "Updating ${DIR}"
  $SUDO -u "$RUN_USER" git -C "$DIR" pull --ff-only
else
  say "Cloning Cloudly into ${DIR}"
  $SUDO mkdir -p "$DIR"
  $SUDO chown "$RUN_USER" "$DIR"
  $SUDO -u "$RUN_USER" git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi

# --- 5. Configuration -----------------------------------------------------------------
ENV_FILE="$DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  say "Configuring this station (press Enter to accept a default)"
  IP=$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  ask DOMAIN "Domain pointing at this VM, for HTTPS (leave empty to use the IP)" ""
  if [ -n "$DOMAIN" ]; then DEFAULT_URL="https://$DOMAIN"; else DEFAULT_URL="http://$IP:3000"; fi
  ask PUBLIC_URL "Public URL" "$DEFAULT_URL"
  ask ALLOWED_GITHUB_LOGINS "GitHub login(s) allowed to sign in, comma-separated" ""
  printf '\n  Create a GitHub App first: https://github.com/settings/apps/new\n' >"${TTY:-/dev/null}"
  printf '  Callback URL: %s/api/auth/github/callback\n' "$PUBLIC_URL" >"${TTY:-/dev/null}"
  printf '  Permissions: Contents (read & write), Pull requests (read & write).\n\n' >"${TTY:-/dev/null}"
  ask GITHUB_APP_ID "GitHub App ID" ""
  ask GITHUB_CLIENT_ID "GitHub App client ID" ""
  ask GITHUB_CLIENT_SECRET "GitHub App client secret" "" secret
  ask GITHUB_APP_INSTALLATION_ID "Installation ID (number at the end of the installation's settings URL)" ""
  ask ANTHROPIC_API_KEY "Anthropic API key, for Claude Code (optional)" "" secret
  ask OPENAI_API_KEY "OpenAI API key, for Codex (optional)" "" secret
  ask GEMINI_API_KEY "Gemini API key, for Gemini CLI (optional)" "" secret
  ask RESEND_API_KEY "Resend API key for budget emails (optional)" "" secret

  PG_PASS=$(openssl rand -hex 24)
  umask 077
  $SUDO -u "$RUN_USER" sh -c "umask 077; cat > '$ENV_FILE'" <<EOF
PUBLIC_URL=$PUBLIC_URL
WEB_ORIGIN=$PUBLIC_URL
API_ORIGIN=$PUBLIC_URL/api
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$PG_PASS
DATABASE_URL=postgresql://cloudly:$PG_PASS@127.0.0.1:5432/cloudly
API_PORT=8787
GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET
GITHUB_APP_ID=$GITHUB_APP_ID
GITHUB_APP_INSTALLATION_ID=$GITHUB_APP_INSTALLATION_ID
GITHUB_APP_PRIVATE_KEY_PATH=$DIR/github-app.pem
ALLOWED_GITHUB_LOGINS=$ALLOWED_GITHUB_LOGINS
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
OPENAI_API_KEY=$OPENAI_API_KEY
GEMINI_API_KEY=$GEMINI_API_KEY
RESEND_API_KEY=$RESEND_API_KEY
ALERT_FROM=Cloudly <onboarding@resend.dev>
WORKER_CONCURRENCY=1
EOF
else
  say "Keeping existing ${ENV_FILE}"
fi

# Bun only auto-loads the .env in its working directory; every package that
# reads env points at the one file.
for d in packages/db apps/api apps/worker apps/web; do
  $SUDO -u "$RUN_USER" ln -sf "$ENV_FILE" "$DIR/$d/.env"
done

# --- 6. Database ----------------------------------------------------------------------
say "Starting Postgres"
cd "$DIR"
COMPOSE="docker compose -f deploy/docker-compose.yml --env-file $ENV_FILE"
$SUDO $COMPOSE up -d --wait postgres >/dev/null
if grep -q '^DOMAIN=.\+' "$ENV_FILE"; then
  say "Starting Caddy for HTTPS"
  $SUDO $COMPOSE --profile https up -d caddy >/dev/null
fi

# --- 7. Build -------------------------------------------------------------------------
say "Installing dependencies"
$SUDO -u "$RUN_USER" "$BUN" install --frozen-lockfile >/dev/null
say "Migrating the database"
$SUDO -u "$RUN_USER" sh -c "cd '$DIR/packages/db' && '$BUN' x prisma migrate deploy >/dev/null && '$BUN' x prisma generate >/dev/null"
say "Building the web app"
$SUDO -u "$RUN_USER" sh -c "cd '$DIR/apps/web' && '$BUN' run build >/dev/null && cp -r .next/static .next/standalone/apps/web/.next/ && if [ -d public ]; then cp -r public .next/standalone/apps/web/; fi"
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
User=$RUN_USER
WorkingDirectory=$2
ExecStart=$3
Environment=$4
Restart=always
RestartSec=3
KillSignal=SIGINT
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF
}
unit api "$DIR" "$BUN apps/api/src/index.ts" "NODE_ENV=production"
unit worker "$DIR" "$BUN apps/worker/src/main.ts" "NODE_ENV=production"
unit web "$DIR/apps/web/.next/standalone/apps/web" "$BUN server.js" "NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0"

$SUDO systemctl daemon-reload
for s in api worker web; do
  $SUDO systemctl enable "cloudly-$s" >/dev/null 2>&1
  $SUDO systemctl restart "cloudly-$s"
done

# --- 9. Next steps --------------------------------------------------------------------
. "$ENV_FILE" 2>/dev/null || true
printf '\n\033[1;32mCloudly is running.\033[0m\n\n'
printf '  Open %s\n\n' "${PUBLIC_URL:-http://<this-ip>:3000}"
[ -f "$DIR/github-app.pem" ] || warn "Copy your GitHub App private key to $DIR/github-app.pem (owned by $RUN_USER, chmod 600), then: sudo systemctl restart cloudly-api cloudly-worker"
printf '  GitHub App callback URL: %s/api/auth/github/callback\n' "${PUBLIC_URL:-}"
printf '  Edit settings in %s, then: sudo systemctl restart cloudly-api cloudly-worker\n' "$ENV_FILE"
printf '  Logs: journalctl -u cloudly-worker -f\n'
case "${PUBLIC_URL:-}" in http://*) warn "Open port 3000 in your cloud firewall, or set a domain for HTTPS on 443." ;; esac
