#!/bin/sh
# Starts the stand-in GitHub as the worker's user, who has to own the bare repos.
#   sudo sh scripts/local-test/github.sh [user]
set -e
cd "$(dirname "$0")/../.."
. scripts/local-test/env.sh
user="${1:-ubuntu}"
mkdir -p "$LOCAL_GITHUB_REPOS" && chown -R "$user" "$LOCAL_GITHUB_REPOS"
exec sudo -u "$user" env PATH="$PATH" HOME="/tmp/cloudly-worker-home" bun scripts/local-test/github.ts "$LOCAL_GITHUB_REPOS" "$LOCAL_GITHUB_PORT"
