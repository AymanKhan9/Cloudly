# Deploying Cloudly

Cloudly runs on one Linux VM in your own cloud account. Setup takes about fifteen minutes, most of it waiting on builds.

## 1. Get a VM

Any Ubuntu 22.04+ or Debian 12+ VM with Docker access works, x86-64 or Arm. Aim for 2 GB of RAM or more. On 1 GB the installer adds a 2 GB swap file and you should keep `WORKER_CONCURRENCY=1`.

Free tiers change often, so check each provider's current terms. As of October 2026:

- **Oracle Cloud Always Free.** An Ampere A1 Arm VM, which Oracle's docs list as "equivalent to 2 OCPUs and 12 GB of memory" for Always Free tenancies. This is the roomiest free option. Create an Ubuntu instance with the `VM.Standard.A1.Flex` shape.
- **Google Cloud Always Free.** One `e2-micro` (2 shared vCPUs, 1 GB) is free in `us-west1`, `us-central1` or `us-east1` only. It handles one run at a time, with swap.
- **AWS.** Accounts created on or after 15 July 2025 get time-limited credits instead of the old 12-month free tier. A `t3.small` or `t4g.small` is a comfortable size.
- **DigitalOcean.** There's no always-free droplet. Use a Basic droplet with 2 GB.

Open inbound ports in your provider's firewall or security group:
- 22 for SSH.
- 80 and 443 for HTTPS (with or without a domain), or 3000 if you choose plain HTTP.

## 2. Run the installer

SSH into the VM and run:

```sh
curl -fsSL https://raw.githubusercontent.com/AymanKhan9/Cloudly/main/install.sh | sh
```

It asks for a domain (optional), the public URL and, optionally, your own Postgres URL (see [Using your own Postgres](#using-your-own-postgres)), then installs Docker, Bun, Postgres and the three services. It downloads a prebuilt release, so a small VM never has to compile the web app. If no release exists for your CPU it builds from source instead (set `CLOUDLY_FROM_SOURCE=1` to force that). When it finishes it prints a setup link and a one-time **setup token**. The token is also saved as `CLOUDLY_SETUP_TOKEN` in `/opt/cloudly/.env`.

## 3. Finish setup in the browser

Open `<your public URL>/setup` and enter the setup token. There are three steps:

1. **Who can sign in.** Your GitHub username (several, comma-separated, if you share the instance).
2. **Create the GitHub App.** One click opens GitHub with a pre-filled form (contents and pull requests, read and write); confirm it. GitHub sends you back and Cloudly stores the app's credentials encrypted. There is nothing to copy by hand.
3. **Choose repositories.** GitHub shows which repos the app may touch, private ones included. You can change this later on GitHub.

Then sign in with GitHub and add a model key (Anthropic, OpenAI or Gemini) under **Settings**. Keys are stored encrypted on the VM and never shown again after saving. Start a session from the home page.

Setup closes itself once all three steps are done, so nobody can claim the instance afterward. Later changes go through Settings.

The installer also prints a **recovery key** (setup shows it too). Save it in a password manager. Everything you save in the browser is encrypted with it, and it's the only way a later install can read those settings.

### Using your own Postgres

Paste a Postgres URL when the installer asks (Neon, Supabase, RDS, anything that accepts connections from the VM), or run it with `LOCAL_POSTGRES=0 DATABASE_URL=...`. Sessions, settings and keys then live in your database, not on the VM.

To move to a new VM, run the installer there with the same database URL and open `/setup`. It notices the earlier install's settings and asks for its recovery key. Paste it and your keys, plan sign-ins, allowed users and GitHub App carry over. If the new VM has a different address, update the GitHub App's three URLs as setup shows them. Without the recovery key, set up from scratch: the old encrypted settings get replaced.

## 4. HTTPS

Cloudly serves HTTPS whether or not you have a domain. Caddy gets a free Let's Encrypt certificate and renews it on its own. Open ports 80 and 443 in your cloud firewall either way.

- **No domain:** the installer offers HTTPS on the VM's IP address and uses it by default. Let's Encrypt has issued certificates for IP addresses [since January 2026](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html). They're valid about six days, and Caddy renews them well before they expire.
- **A domain:** point a DNS A record at the VM and enter the domain when the installer asks.

Behind Caddy, the web app only listens on the VM itself, so `http://<ip>:3000` stops working and nothing can bypass HTTPS. Port 3000 can be closed.

To switch an existing plain-HTTP install to HTTPS on its IP, re-run the installer with `CLOUDLY_ENABLE_HTTPS=1`:

```sh
curl -fsSL https://raw.githubusercontent.com/AymanKhan9/Cloudly/main/install.sh | CLOUDLY_ENABLE_HTTPS=1 sh
```

Your address then changes to `https://<ip>`, and GitHub needs to know: the installer prints the new homepage, callback and setup URLs to enter in your GitHub App's settings. GitHub doesn't let other apps change those for you.

To add a domain later, set `DOMAIN=` and `SITE_ADDRESS=` to it, `ACME_PROFILE=classic`, and `PUBLIC_URL`, `WEB_ORIGIN` and `API_ORIGIN` to `https://<domain>` in `/opt/cloudly/.env`. Then re-run the installer and update the GitHub App's URLs the same way.

## 5. Day-to-day

| Task | Command |
|---|---|
| Upgrade | Re-run the install command. It pulls, migrates, rebuilds and restarts, and keeps your `.env`. |
| Logs | `journalctl -u cloudly-worker -f` (also `cloudly-api`, `cloudly-web`) |
| Add languages to the sandbox (Rust, Go, Java…) | Settings → Sandbox tools. The worker builds the image in the background; runs use the previous image until it's ready |
| Let runs reach another host (docs site, private registry) | Settings → Sandbox tools → Network. Runs can only reach model APIs, package registries and GitHub by default; `*` allows everything |
| Run-container limits | `SANDBOX_MEMORY` (default: RAM minus 768 MB) and `SANDBOX_PIDS` (default 2048) in `.env` |
| Restart after editing `.env` | `sudo systemctl restart cloudly-api cloudly-worker cloudly-web` |
| Change agent prices | Set `PRICE_CODEX_*` / `PRICE_GEMINI_*` in `.env` (USD per million tokens) |
| Add a user | Append their GitHub login to `ALLOWED_GITHUB_LOGINS` |

## What runs where

- `cloudly-web`: the Next.js UI on port 3000. It proxies `/api` to the API. Runs as `cloudly-app`, with no Docker access.
- `cloudly-api`: the Hono API on `127.0.0.1:8787`. It is not exposed. Runs as `cloudly-app`, with no Docker access.
- `cloudly-worker`: runs as the uid-1000 user, the only one in the `docker` group. Claims runs, starts one Docker container per run, finalizes, pushes and opens the PR, and enforces the spend limit.
- Postgres runs in Docker, bound to `127.0.0.1:5432`, unless you use your own.
- The `cloud-agents-base` image holds the sandbox: the agent CLIs, running as a non-root user.

## Publishing the landing page on its own

To host only the marketing page (for example on Vercel), deploy `apps/web` with `NEXT_PUBLIC_SITE_MODE=marketing`. Sign-in and the app routes are disabled in that mode, since there is no API behind it.

## Publishing a release (maintainers)

Push a tag such as `v0.1.0`. The `release` workflow builds the web app on x86-64 and Arm runners and attaches `cloudly-linux-amd64.tar.gz` and `cloudly-linux-arm64.tar.gz`. The installer fetches the latest release.
