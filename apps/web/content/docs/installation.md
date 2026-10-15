# Installation

Cloudly runs on one Linux VM. Installing takes about fifteen minutes, most of it waiting on downloads.

## Requirements

- Ubuntu 22.04 or newer, or Debian 12 or newer, on x86-64 or Arm.
- 2 GB of RAM or more is comfortable. On 1 GB the installer adds a 2 GB swap file; keep one run at a time (`WORKER_CONCURRENCY=1`).
- Inbound ports open in your cloud firewall: **22** for SSH, and **80** and **443** for HTTPS. If you choose plain HTTP instead, open **3000**.

## Pick a VM

Free tiers change often, so check each provider's current terms. As of October 2026:

| Provider | What to use | Notes |
|---|---|---|
| Oracle Cloud | Always Free Ampere A1 (Arm) | The roomiest free option: up to 2 OCPUs and 12 GB of memory. Create an Ubuntu instance with the `VM.Standard.A1.Flex` shape. |
| Google Cloud | Always Free `e2-micro` | Free in `us-west1`, `us-central1` and `us-east1` only. 1 GB of RAM: one run at a time, with swap. |
| AWS | `t3.small` or `t4g.small` | New accounts get time-limited credits rather than a permanent free VM. |
| DigitalOcean | Basic droplet, 2 GB | No always-free droplet. |

## Run the installer

SSH into the VM and run:

```sh
curl -fsSL https://raw.githubusercontent.com/AymanKhan9/Cloudly/main/install.sh | sh
```

It asks for:

1. **A domain** (optional). Leave it empty to use HTTPS on the VM's IP address.
2. **The public URL** people will use to reach the instance.
3. **Your own Postgres URL** (optional). Leave it empty to run Postgres on the VM.

It then installs Docker and Bun, downloads the prebuilt release for your CPU (so a small VM never compiles the web app), sets up Postgres, runs migrations and starts three services: `cloudly-web`, `cloudly-api` and `cloudly-worker`.

When it finishes it prints:

- **A setup link** and a one-time **setup token**. Open the link to [finish setup](/docs/setup).
- **A recovery key.** Save it in a password manager. Everything you save in the browser is encrypted with it, and a later install on the same database needs it to read your settings.

> If there is no release for your CPU, the installer builds from source instead. Set `CLOUDLY_FROM_SOURCE=1` to force that.

## HTTPS

Cloudly serves HTTPS with or without a domain. Caddy gets a free Let's Encrypt certificate and renews it on its own.

- **No domain:** the installer uses HTTPS on the VM's IP address by default. These certificates are valid for about six days, and Caddy renews them well before they expire.
- **A domain:** point a DNS A record at the VM and enter the domain when the installer asks.

Behind Caddy the web app only listens on the VM itself, so nothing can bypass HTTPS and port 3000 can stay closed.

To switch an existing plain-HTTP install to HTTPS on its IP:

```sh
curl -fsSL https://raw.githubusercontent.com/AymanKhan9/Cloudly/main/install.sh | CLOUDLY_ENABLE_HTTPS=1 sh
```

Your address becomes `https://<ip>`. The installer prints the new homepage, callback and setup URLs; enter them in your GitHub App's settings, since GitHub doesn't let other apps change them.

## Using your own Postgres

Paste a Postgres URL when the installer asks (Neon, Supabase, RDS, or anything that accepts connections from the VM), or run it non-interactively:

```sh
curl -fsSL https://raw.githubusercontent.com/AymanKhan9/Cloudly/main/install.sh | LOCAL_POSTGRES=0 DATABASE_URL=postgresql://... sh
```

Sessions, settings and encrypted keys then live in your database rather than on the VM, which makes [moving to a new VM](/docs/upgrading#move-to-a-new-vm) easy.
