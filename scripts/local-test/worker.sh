#!/bin/sh
# Starts the worker for local testing: from the repo root (the sandbox mounts
# the runner from there), as a non-root user (the sandbox runs as the same uid),
# with the API's secret key so both read the same settings.
#   sudo sh scripts/local-test/worker.sh [user] [secret key file]
set -e
cd "$(dirname "$0")/../.."
. scripts/local-test/env.sh
user="${1:-ubuntu}"
key="$(cat "${2:-/root/.cloudly/secret.key}")"
home="/tmp/cloudly-worker-home"
mkdir -p "$home" && chown "$user" "$home"
exec sudo -u "$user" env HOME="$home" PATH="$PATH" DATABASE_URL="$DATABASE_URL" WEB_ORIGIN="$WEB_ORIGIN" \
  PREVIEW_ORIGIN="$PREVIEW_ORIGIN" ACP_REGISTRY_URL="$ACP_REGISTRY_URL" CLOUDLY_SECRET_KEY="$key" CLOUDLY_GITHUB_API_URL="$CLOUDLY_GITHUB_API_URL" CLOUDLY_GITHUB_GIT_URL="$CLOUDLY_GITHUB_GIT_URL" \
  bun apps/worker/src/main.ts
