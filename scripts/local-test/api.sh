#!/bin/sh
# Starts the API for local testing against the stand-in GitHub.
#   sh scripts/local-test/api.sh
set -e
cd "$(dirname "$0")/../../apps/api"
. ../../scripts/local-test/env.sh
export PORT="${PORT:-8787}"
exec bun src/index.ts
