# Cloudly

Coding agents on a server you already own.

Cloudly runs Claude Code, Codex, Gemini CLI, or an agent you add (Cursor, Grok, OpenCode, Antigravity, Pi, or any ACP agent) against your GitHub repos on a VM in your own cloud account. Hand it a task in the browser, close the laptop, and come back to a pull request. It stops spending when you reach your monthly limit.

Free and MIT-licensed. Bring your own cloud, model keys and GitHub.

## What it does

- **Runs agents unattended.** Pick a repo, an agent and a task. The run continues after you close the tab and ends with a branch and a pull request.
- **Plug-and-play agents.** Claude (via the Claude Agent SDK) and Codex run through their official SDKs. Gemini CLI runs over the Agent Client Protocol, and so does every agent you add under Settings: Cursor, Grok, OpenCode, Antigravity and Pi by name, anything in the ACP registry, or a command of your own. All of them feed one event stream, so the run log, cancel button and pull request work the same for each. Added agents get API keys the same way the built-in ones do: as placeholders the proxy fills in.
- **Checks, then fixes.** After every turn that changes code, Cloudly runs the repo's tests (found from its own files, or a command you set) in a sandbox of their own. When they fail, the same agent gets the output and another turn to fix them, a couple of times at most, then the session asks you.
- **A second agent reviews the change.** Pick a reviewer for a repo (Codex reviewing Claude, say). It reviews what the session changed; blocking findings go back to the author automatically, a couple of rounds at most, and the review is posted to the pull request with line comments. The Changes tab shows the diff with the findings on their lines, and lets you comment on any line and send it all back as one message.
- **Audit a repo.** One button: an agent reviews the whole repo and lists what is wrong. Tick the findings you want fixed and they become a normal session with a pull request.
- **Start from GitHub.** Label an issue or mention `@cloudly` in a comment to start a session; review one of Cloudly's pull requests and the review becomes its next turn; when its CI fails, the agent gets the logs and fixes it. Only people on your sign-in list can trigger anything.
- **Merge when ready, and schedules.** A session can merge its own pull request once checks, review and CI pass and GitHub allows it (it updates a branch that's behind, and asks you about conflicts). Schedules run a task or an audit hourly, daily, on weekdays or weekly, in your time zone.
- **Discord, Slack and notifications.** Start sessions with `/cloudly` in Discord or Slack, follow each in its own thread, and reply or cancel from there. Hear when a session needs you, finishes, fails or merges, by Discord or Slack DM, a Discord channel or a Slack webhook, once per session rather than once per automatic turn.
- **Pi and OpenCode, first-class.** Added from the agent catalog, they resume their own sessions across turns, record exact cost (so the spend limit applies), show context fill, and take the session's effort.
- **Agents keep themselves current.** Added agents are checked against the ACP registry (and npm) every six hours and updated through the sandbox image; a version that doesn't install is rolled back and skipped. Turn it off per agent to update by hand.
- **Rewind and fork.** Every turn that changes code is a checkpoint: rewind a session to just after any turn (its branch and the agent's memory go back too), or fork a new session from there, with another agent if you like.
- **Plans for big tasks.** An agent breaks a big task into smaller ones with the order between them; you look them over, then each runs as its own session and pull request, side by side, starting as the ones it builds on are merged.
- **Import sessions from any agent.** Bring a Claude Code, Codex, Pi, Gemini CLI or OpenCode session (or any chat export) into Cloudly, with your uncommitted work, and carry on there. The same agent picks up its own session; any other gets the conversation.
- **Artifacts and screenshots.** Agents write charts, diagrams, reports and pages to `/artifacts`, and they show in the conversation (HTML sandboxed), with versions and share links. Replies render tables, highlighted code, Mermaid and math. UI changes get before-and-after screenshots, in the session and the pull request.
- **Back to your computer.** `cloudly.mjs pull <session>` checks out its branch and hands Claude Code, Codex or Pi their own session to resume locally.
- **Agent scorecard and Auto.** Merge rate, cost per merge, first-try checks, fixes and review findings per agent and repo; Auto starts new sessions with the agent that does best there.
- **Sentry.** A new production error starts a session that reproduces it in a test and fixes it, a few a day at most.
- **Fast starts.** The worker keeps a copy of each repo and fetches only what changed, so a turn on a big repo starts in seconds instead of a minute (8x faster on t3code).
- **Compare agents.** Hand one task to two or three agents at once, compare cost, time, diff size and each agent's summary side by side, and open the best result as the pull request.
- **An agent council.** Pick two or more agents, or just name them in your question ("use claude, chatgpt, opencode, gemini and pi for this"), and ask. Cloudly checks each can run and tells you which can't. They research on their own, cross-examine each other's findings, give final positions, and a chair writes one report with where they agree, where they don't, and each one's take. Research councils can read the open web; on a repo, they read without changing anything.
- **MCP servers without the localhost dance.** Connect Linear, Notion, Sentry or your own server once in Settings. Cloudly does the OAuth sign-in on its own public URL and keeps the tokens; every agent gets the tools, and none of them ever holds a token.
- **Sessions that talk to each other.** Like T3 Code's threads, a session's agent can read your other sessions' conversations and branches, and send one a message that runs there as its next turn, with the reply coming back as a turn of its own. Limited to the same repo unless you open it up, and capped so agents can't keep each other busy.
- **One context for every agent.** Turn on shared context for a repo and every agent working on it, whichever agent runs it here and Cursor or Claude Code on your laptop through Cloudly's MCP endpoint, starts from the same notes and sees what the others did.
- **Secrets the agent never holds.** Tokens your tests need reach the sandbox as placeholders; the egress proxy fills in the real value only on HTTPS requests to the hosts you name. Each repo also gets a `/files` folder outside git that persists between sessions.
- **A desktop you can watch.** Turn on a virtual desktop with a browser and every agent gets computer-use tools; watch it live or take control. Previews run a session's branch so you can try the app before merging.
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
packages/runner  In-sandbox runner with the Claude, Codex and ACP adapters, the desktop and its MCP tools
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
