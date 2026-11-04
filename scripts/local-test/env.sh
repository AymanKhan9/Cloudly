# Environment for running Cloudly locally against the stand-in GitHub.
# Source it before starting the API and the worker: . scripts/local-test/env.sh
export DATABASE_URL="${DATABASE_URL:-postgresql://cloudly:cloudly@127.0.0.1:5432/cloudly}"
export WEB_ORIGIN="${WEB_ORIGIN:-http://localhost:3000}"
export LOCAL_GITHUB_PORT="${LOCAL_GITHUB_PORT:-9797}"
export LOCAL_GITHUB_REPOS="${LOCAL_GITHUB_REPOS:-/var/tmp/cloudly-local-github}"
export CLOUDLY_GITHUB_API_URL="http://127.0.0.1:${LOCAL_GITHUB_PORT}"
export CLOUDLY_GITHUB_GIT_URL="${LOCAL_GITHUB_REPOS}"
export PREVIEW_ORIGIN="${PREVIEW_ORIGIN:-http://127.0.0.1:3141}"
export ACP_REGISTRY_URL="${ACP_REGISTRY_URL:-http://127.0.0.1:${LOCAL_GITHUB_PORT}/_registry.json}"
