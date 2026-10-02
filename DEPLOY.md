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
- Either 3000 (HTTP by IP) or 80 and 443 (HTTPS with a domain).

## 2. Create a GitHub App

On github.com go to **Settings → Developer settings → GitHub Apps → New GitHub App**.

1. **Name.** Anything unique, e.g. `cloudly-yourname`.
2. **Homepage URL.** Your instance URL.
3. **Callback URL.** `<your public URL>/api/auth/github/callback`. Use `http://<vm-ip>:3000/api/auth/github/callback` without a domain, or `https://<domain>/api/auth/github/callback` with one.
4. **Webhook.** Uncheck **Active**.
5. **Repository permissions.**
   - Contents: Read and write.
   - Pull requests: Read and write.
   - Metadata is read-only, which is the default.
6. **Where can this App be installed.** Only on this account.

After creating it:
- Note the **App ID** and **Client ID**.
- Generate a **client secret**.
- Generate a **private key**, which downloads a `.pem` file.
- **Install** the App on the repos Cloudly should work on. The installation ID is the number at the end of the installation's settings URL, e.g. `github.com/settings/installations/166837251`.

## 3. Run the installer

SSH into the VM and run:

```sh
curl -fsSL https://raw.githubusercontent.com/AymanKhan9/Cloudly/main/install.sh | sh
```

It asks for:
- your domain, which is optional;
- the GitHub logins allowed to sign in;
- the GitHub App details;
- the model keys for the agents you'll use;
- an optional Resend key for budget emails.

It writes everything to `/opt/cloudly/.env` with permissions 600.

Then copy the App's private key to the VM:

```sh
scp cloudly-yourname.private-key.pem you@<vm-ip>:/tmp/github-app.pem
ssh you@<vm-ip> 'sudo install -m 600 -o $(id -un 1000) /tmp/github-app.pem /opt/cloudly/github-app.pem && sudo systemctl restart cloudly-api cloudly-worker'
```

Open your public URL, sign in with GitHub, set a monthly limit under **Settings**, and start a run.

## 4. HTTPS

Point a DNS A record at the VM and enter the domain when the installer asks. Caddy then gets and renews a certificate automatically on ports 80 and 443. To add a domain later:
1. Set `DOMAIN=` and `PUBLIC_URL=https://...` in `/opt/cloudly/.env`, and update `WEB_ORIGIN` and `API_ORIGIN` to match.
2. Re-run the installer.
3. Update the GitHub App's callback URL.

## 5. Day-to-day

| Task | Command |
|---|---|
| Upgrade | Re-run the install command. It pulls, migrates, rebuilds and restarts, and keeps your `.env`. |
| Logs | `journalctl -u cloudly-worker -f` (also `cloudly-api`, `cloudly-web`) |
| Restart after editing `.env` | `sudo systemctl restart cloudly-api cloudly-worker cloudly-web` |
| Change agent prices | Set `PRICE_CODEX_*` / `PRICE_GEMINI_*` in `.env` (USD per million tokens) |
| Add a user | Append their GitHub login to `ALLOWED_GITHUB_LOGINS` |

## What runs where

- `cloudly-web`: the Next.js UI on port 3000. It proxies `/api` to the API.
- `cloudly-api`: the Hono API on `127.0.0.1:8787`. It is not exposed.
- `cloudly-worker`: claims runs, starts one Docker container per run, finalizes, pushes and opens the PR, and enforces the spend limit.
- Postgres runs in Docker, bound to `127.0.0.1:5432`.
- The `cloud-agents-base` image holds the sandbox: the agent CLIs, running as a non-root user.

## Publishing the landing page on its own

To host only the marketing page (for example on Vercel), deploy `apps/web` with `NEXT_PUBLIC_SITE_MODE=marketing`. Sign-in and the app routes are disabled in that mode, since there is no API behind it.
