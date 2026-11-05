# Cloudly

Hand off a coding task from anywhere, and get back a pull request that was actually checked.

**[usecloudly.dev](https://usecloudly.dev)** · [Docs](https://usecloudly.dev/docs)

Cloudly runs coding agents (Claude Code, Codex, Gemini CLI, or one you add: OpenCode, Pi, Cursor, Grok, Antigravity, any ACP agent) against your GitHub repos on a server you own. Give it a task from the browser, Discord, Slack or a GitHub issue, close the laptop, and come back to a branch and a pull request. It runs on your API keys or on the Claude or ChatGPT plan you already pay for.

Free, MIT-licensed and self-hosted: your VM, your database, your keys. There's no Cloudly account and no hosted service in the middle.

## Why Cloudly

- **The work keeps going without you.** Each turn runs in its own container on your server, so nothing depends on your laptop staying open.
- **Checked, not just claimed.** After every turn that changes code, the repo's tests run in a container of their own, and failures go back to the agent. A second agent can review the change. A turn that says it's done but changed nothing shows as "no changes" and can't become a pull request.
- **Your keys never enter the sandbox.** Agents get placeholders; an egress proxy fills in the real key only on the way to the hosts you allow. GitHub credentials stay outside too: the worker pushes and opens the pull request itself.
- **It works with the tools you already use.** Continue any session in Claude Code, Codex or Pi on your computer, and let Cursor or Claude Code on your laptop read and add to the same repo notes as the cloud agents, through Cloudly's MCP endpoint.

## What it does

**Start work from anywhere**
- The browser, `/cloudly` in Discord or Slack, a labelled GitHub issue or an `@cloudly` mention, a new Sentry error, or a schedule (hourly to weekly).
- Steer an agent while it works, rewind a session to any earlier turn, or fork it with another agent.
- Big tasks become plans: an agent splits them into sessions that run side by side, each with its own pull request.
- Fast starts: the worker keeps a copy of each repo and fetches only what changed (8x faster on the t3code repo).

**Get it checked**
- Checks run after every changing turn, with the agent fixing what fails a couple of times before it asks you.
- A reviewer agent (Codex reviewing Claude, say) sends blocking findings back and posts its review on the pull request.
- Audit a whole repo, tick the findings to fix, and they become a normal session.
- Merge when ready: the pull request merges itself once checks, review and CI pass.
- Before-and-after screenshots for UI changes, and a scorecard of each agent's merge rate and cost per merge, which **Auto** uses to pick the agent.

**Use several agents together**
- Compare: give one task to two or three agents and open the best result as the pull request.
- Council: agents research a question on their own, challenge each other's findings, and a chair writes one report.
- Sessions can read each other and send each other messages; shared context gives every agent on a repo the same notes and log of recent work.

**Stay in control**
- A monthly spend limit that stops new runs at 100%, with a warning at 80%.
- Import a session from Claude Code, Codex, Pi, Gemini CLI or OpenCode, or pull one back to your computer with `cloudly.mjs pull`.
- MCP servers (Linear, Notion, your own) connected once in Settings; Cloudly keeps the tokens and agents never see them.
- Artifacts (charts, reports, pages) in the conversation, a virtual desktop you can watch, and previews of a session's branch.

## Install

On a fresh Ubuntu or Debian VM:

```sh
curl -fsSL https://usecloudly.dev/install.sh | sh
```

The installer sets up Docker, Bun, Postgres and a swap file on small machines, builds everything, and starts three systemd services. It prints a link to a setup page where you create the GitHub App in one click and choose repositories; add model keys or plan sign-ins under Settings afterwards. Re-run it any time to upgrade; it keeps your `.env`.

[DEPLOY.md](DEPLOY.md) covers picking a VM on each provider, HTTPS and upgrades. The full guide is at [usecloudly.dev/docs](https://usecloudly.dev/docs), and on your instance at `/docs`.

## Where to run it

| Provider | What to use | Notes |
|---|---|---|
| Oracle Cloud | Always Free Ampere A1 (Arm) | The best free fit: 2 OCPUs and 12 GB of memory. |
| Google Cloud | Always Free e2-micro | Free in us-west1, us-central1 and us-east1 only. 1 GB of RAM: one run at a time, with swap. |
| AWS | t3.small / t4g.small | New accounts get time-limited credits rather than a permanent free VM. |
| DigitalOcean | Basic droplet, 2 GB | No always-free VM. |

Free tiers change, so check each provider's current terms. Leave room on the disk: the sandbox image is about 2 GB and grows with each agent you add.

## How it works

One VM runs the web app, the API, a worker and Postgres. The worker claims each turn from a Postgres queue, runs the agent in a throwaway non-root container behind the egress proxy, then commits the result in a separate clone the agent never touched and pushes it with a short-lived GitHub App token. [ARCHITECTURE.md](ARCHITECTURE.md) has the design and a status table of what's been tested, and how.

```
apps/web           Next.js UI and docs
apps/api           Hono API: sign-in, sessions, the event stream, settings, budget
apps/worker        Claims turns, drives containers, checks, commits, pushes, opens PRs
packages/runner    Runs inside the container: the Claude, Codex and ACP adapters
packages/db        Prisma schema, migrations and encrypted settings
packages/shared    Contracts shared across the stack
infra/images/base  The sandbox image
deploy/            Postgres and Caddy (HTTPS) for the installer
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

To try it end to end on one machine, with a stand-in GitHub and either scripted or real agents, see [scripts/local-test](scripts/local-test/README.md). [CONTRIBUTING.md](CONTRIBUTING.md) has the checks to run before a pull request.

## License

MIT. See [LICENSE](LICENSE).
