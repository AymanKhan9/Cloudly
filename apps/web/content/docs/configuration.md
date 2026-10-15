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

## Prices

Used to estimate Codex and Gemini cost, in US dollars per million tokens. Claude Agent reports exact cost and ignores these.

| Variable | Example |
|---|---|
| `PRICE_CODEX_INPUT_PER_MTOK` | `1.25` |
| `PRICE_CODEX_OUTPUT_PER_MTOK` | `10` |
| `PRICE_GEMINI_INPUT_PER_MTOK` | `0.30` |
| `PRICE_GEMINI_OUTPUT_PER_MTOK` | `2.50` |

## Alerts

| Variable | What it is |
|---|---|
| `ALERT_FROM` | The sender for spend-limit emails, for example `Cloudly <alerts@example.com>`. |
