# Upgrades and troubleshooting

## Upgrade

Re-run the install command on the VM:

```sh
curl -fsSL https://raw.githubusercontent.com/AymanKhan9/Cloudly/main/install.sh | sh
```

It downloads the latest release, runs database migrations and restarts the services. Your `.env`, database and settings are kept.

## Everyday tasks

| Task | How |
|---|---|
| Follow the logs | `journalctl -u cloudly-worker -f` (also `cloudly-api` and `cloudly-web`) |
| Restart after editing `.env` | `sudo systemctl restart cloudly-api cloudly-worker cloudly-web` |
| Add a user | Add their login to **GitHub logins allowed to sign in** under **Settings → Keys and connections** |
| Add tools to the sandbox | **Settings → Sandbox tools** |
| Let runs reach another host | **Settings → Network** |

## Move to a new VM

Your sessions and settings live in the database, so moving is easiest when you [use your own Postgres](/docs/installation#using-your-own-postgres).

1. Run the installer on the new VM with the same `DATABASE_URL`.
2. Open `/setup`. It notices the earlier install's settings and asks for its **recovery key**.
3. Paste it. Your keys, plan sign-ins, allowed users and GitHub App carry over.
4. If the new VM has a different address, update the GitHub App's homepage, callback and setup URLs as setup shows them.

Without the recovery key, set up from scratch. Settings you haven't re-entered stay locked, and **Settings → Keys and connections** offers to restore them if you find the key later. The GitHub App is the exception: setup creates a new one, so delete the old app on GitHub.

## Add a domain later

In `/opt/cloudly/.env`, set `DOMAIN` and `SITE_ADDRESS` to the domain, `ACME_PROFILE=classic`, and `PUBLIC_URL`, `WEB_ORIGIN` and `API_ORIGIN` to `https://<domain>`. Re-run the installer, then update the GitHub App's URLs to the new address.

## Troubleshooting

### The page doesn't load

Check that ports **80** and **443** (or **3000** for plain HTTP) are open in your cloud provider's firewall or security group, not just on the VM. If the installer says it has no certificate yet, Caddy keeps retrying. See its logs with:

```sh
cd /opt/cloudly && sudo docker compose -f deploy/docker-compose.yml --env-file .env logs caddy
```

### Sign-in says the account isn't allowed

Only the GitHub logins listed during setup can sign in. Add the account to **GitHub logins allowed to sign in** under Settings.

### Sign-in fails after changing the address

GitHub sends you back to the URLs saved in the GitHub App. Open your app on GitHub (**Settings → Developer settings → GitHub Apps**) and update its homepage, callback and setup URLs to the new address.

### New sessions are blocked

You've reached the monthly [spend limit](/docs/spend-limit). Raise it under **Settings → Spend limit**. Turns on a Claude or ChatGPT plan aren't blocked.

### Gemini turns take minutes

Gemini's `auto` model router sends free-tier keys to models with no quota and retries. Use the default `gemini-3-flash-preview`, or pick another model with `/model`.

### A sandbox build failed

Open **Settings → Sandbox tools** and expand **Build log**. Runs keep using the last good image; fix the script and save, or click **Retry build**.

### A turn failed

The turn shows the agent's own error message. The worker log has the full story:

```sh
journalctl -u cloudly-worker -n 200
```
