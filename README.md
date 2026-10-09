# Cloudly

Coding agents on a server you already own.

Cloudly runs Claude Code, Codex or Gemini CLI against your GitHub repos on a VM in your own cloud account. Hand it a task in the browser, close the laptop, and come back to a pull request. It stops spending when you reach your monthly limit.

Free and MIT-licensed. Bring your own cloud, model keys and GitHub.

## What it does

- **Runs agents unattended.** Pick a repo, an agent and a task. The run continues after you close the tab and ends with a branch and a pull request.
- **Plug-and-play agents.** Claude Code and Codex run through their official SDKs. Gemini CLI runs over the Agent Client Protocol, so other ACP agents can plug in the same way. All three feed one event stream, so the run log, cancel button and spend limit work the same for each.
- **A spend limit that actually stops.** At 80% of your monthly limit you get a banner and one email. At 100% new runs are refused. A turn that's already running finishes, so a task isn't left half done, but Claude Code turns stop at 25% over the limit and keep the work they finished on the branch. Claude Code reports exact cost. Codex and Gemini report tokens, which Cloudly prices from a table you control and marks as an estimate.
- **Everything stays on your VM.** One VM runs the web app, API, worker and Postgres. Each run gets its own non-root container, removed when it ends. Your keys are stored encrypted on that VM. GitHub credentials never enter the sandbox: the worker pushes and opens the PR from outside it with a short-lived GitHub App token.

## Install

On a fresh Ubuntu or Debian VM:

```sh
curl -fsSL https://raw.githubusercontent.com/AymanKhan9/Cloudly/main/install.sh | sh
```

The installer sets up Docker, Bun, a swap file on small machines, and Postgres, builds everything, and starts three systemd services. It then prints a link to a setup page where you create the GitHub App with one click, choose repositories, and later add model keys under Settings (stored encrypted, never shown again). Re-run it any time to upgrade; it keeps your `.env`.

[DEPLOY.md](DEPLOY.md) covers picking a VM on each provider, HTTPS, and upgrades.

## Where to run it

| Provider | What to use | Notes |
|---|---|---|
| Oracle Cloud | Always Free Ampere A1 (Arm) | The best free fit. Always Free gives 2 OCPUs and 12 GB of memory. |
| Google Cloud | Always Free e2-micro | Free in us-west1, us-central1 and us-east1 only. 1 GB of RAM: one run at a time, with swap. |
| AWS | t3.small / t4g.small | New accounts get time-limited credits rather than a permanent free VM. |
| DigitalOcean | Basic droplet, 2 GB | No always-free VM. |

Free tiers change. Check each provider's current terms before you rely on them.

## How it works

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the design: the Postgres job queue with leases and fencing, the run lifecycle, why GitHub side effects are idempotent, and how finalize treats agent output as untrusted.

```
apps/web       Next.js UI (landing, sign-in, runs, live run view, settings)
apps/api       Hono API: GitHub OAuth sessions, runs, SSE stream, budget
apps/worker    Claims runs, drives sandboxes, finalizes, pushes, opens PRs, enforces the limit
packages/runner  In-sandbox runner with the Claude, Codex and ACP adapters
packages/db    Prisma schema and migrations
packages/shared  Zod contracts shared across the stack
infra/images/base  The sandbox image
deploy/        Postgres and optional Caddy (HTTPS) for the installer
```

## Develop

```sh
bun install
cd packages/db && bunx prisma migrate dev && cd -
bun run --filter @repo/api dev           # API on :8787
bun run --filter web dev                 # web on :3000, proxies /api to the API
bun --env-file=apps/worker/.env --env-file=packages/runner/.env apps/worker/src/main.ts   # worker, from the repo root
bun run --filter @repo/worker test       # worker tests (needs Postgres and Docker)
```

## License

MIT. See [LICENSE](LICENSE).
