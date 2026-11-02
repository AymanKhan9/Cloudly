# Configuration

The installer writes every setting to `/opt/cloudly/.env`, and all three services read that one file. Most things you'd want to change (keys, plan sign-ins, allowed users, the spend limit, sandbox tools) are set in the browser instead, under **Settings**, and stored encrypted in the database.

After editing `.env`, restart the services:

```sh
sudo systemctl restart cloudly-api cloudly-worker cloudly-web
```

> Keep `.env` readable only by its owner and the API's group (the installer sets `0640`). It holds your database password and the key that encrypts your settings.

## Addresses

| Variable | What it is |
|---|---|
| `PUBLIC_URL` | Where people reach the instance, for example `https://203.0.113.10`. |
| `WEB_ORIGIN` | The web app's origin; normally the same as `PUBLIC_URL`. |
| `API_ORIGIN` | The API as the browser sees it: `PUBLIC_URL` plus `/api`. |
| `DOMAIN` | Optional. A domain pointing at the VM, for HTTPS on that domain. |

## Database

| Variable | What it is |
|---|---|
| `DATABASE_URL` | The Postgres connection string. |
| `LOCAL_POSTGRES` | `1` runs Postgres in Docker on the VM, bound to localhost. `0` uses `DATABASE_URL` as is. |
| `POSTGRES_PASSWORD` | The bundled database's password. |
| `API_PORT` | The API's local port. Default `8787`; it is never exposed. |

## Setup and encryption

| Variable | What it is |
|---|---|
| `CLOUDLY_SETUP_TOKEN` | The one-time token that protects `/setup`. |
| `CLOUDLY_SECRET_KEY` | Encrypts everything saved in the browser. Don't change it: settings saved with the old key become unreadable without the recovery key. |

## Fallback credentials

These are normally entered in the browser. A value in `.env` is only used when nothing is saved in Settings.

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | Model API keys. |
| `ALLOWED_GITHUB_LOGINS` | GitHub logins allowed to sign in, comma-separated. |
| `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` | The GitHub App, if you created it by hand. |
| `RESEND_API_KEY` | For spend-limit emails. |

## Agents

| Variable | What it is |
|---|---|
| `GEMINI_MODEL` | Gemini CLI's default model. Default `gemini-3-flash-preview`; `auto` lets Gemini choose. |

## Runs

| Variable | What it is |
|---|---|
| `WORKER_CONCURRENCY` | Turns that run at the same time. Keep `1` on a 1 GB VM. |
| `SANDBOX_MEMORY` | Memory per run container. Default: the VM's RAM minus 768 MB, at least 512 MB. |
| `SANDBOX_PIDS` | Process limit per run container. Default `2048`. |
| `CLOUDLY_REPO_CACHE` | Where the worker keeps a copy of each repo so turns start fast. Default `~/.cloudly/repo-cache`; `off` clones the whole repo every turn. |
| `CLOUDLY_REPO_CACHE_DAYS` | A repo's copy is removed after this many days without a turn. Default `14`. |
| `CLOUDLY_AGENT_UPDATE_HOURS` | How often added agents are checked for newer versions. Default `6`; `0` turns the checks off. |

### Fast starts

Each turn needs its own copy of the repo. Cloning a big repo from GitHub every time is slow (about a minute for [t3code](https://github.com/pingdotgg/t3code)), so the worker keeps one copy of each repo on the VM. A turn fetches only what changed since the last one, makes its copy from that, and borrows the history instead of copying it. The agent still gets a normal git repo with the full history and every branch.

On t3code, a turn's workspace takes about 7 seconds instead of 58 once the repo has been used once. The first turn on a repo is as slow as before.

The copy only holds what's on GitHub, never your token. If it's ever damaged, the turn clones in full and the copy is rebuilt.

## Desktops and previews

See [Desktop and previews](/docs/desktop-and-previews). The installer sets the first two.

| Variable | What it is |
|---|---|
| `PREVIEW_ORIGIN` | Where previews open: your address on port 8443 (HTTPS) or 3141 (plain HTTP). Without it, previews only show on the sandbox's desktop. |
| `PREVIEW_BIND` | Which address the relay's preview port listens on. `127.0.0.1` behind Caddy, `0.0.0.0` on plain HTTP. |
| `PREVIEW_PORT` | The relay's preview port on the VM. Default `3141`. |
| `PREVIEW_MAX` | Previews that may run at once. Default `1`. |
| `PREVIEW_TTL_MINUTES` | How long a preview runs before it's stopped. Default `60`. |
| `RELAY_PORT` | The relay's desktop port, on the VM only. Default `3140`. |

## Prices

Used to estimate Codex and Gemini cost, in US dollars per million tokens. Claude Code reports exact cost and ignores these.

| Variable | Example |
|---|---|
| `PRICE_CODEX_INPUT_PER_MTOK` | `1.25` |
| `PRICE_CODEX_OUTPUT_PER_MTOK` | `10` |
| `PRICE_GEMINI_INPUT_PER_MTOK` | `0.30` |
| `PRICE_GEMINI_OUTPUT_PER_MTOK` | `2.50` |

Agents added under **Settings → Agents** record no cost until you set their prices. Their variables are named after the agent's id, in capitals with underscores: for `acp-cursor`, `PRICE_ACP_CURSOR_INPUT_PER_MTOK` and `PRICE_ACP_CURSOR_OUTPUT_PER_MTOK`. They use the token counts the agent reports, so they're an estimate, and only agents that report tokens can be priced.

| Variable | Example |
|---|---|
| `ACP_REGISTRY_URL` | Where the API reads the ACP registry. Default `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`. |

## Alerts

| Variable | What it is |
|---|---|
| `ALERT_FROM` | The sender for spend-limit emails, for example `Cloudly <alerts@example.com>`. |
