# Architecture

Everything runs on one VM in your cloud account. The pieces talk through Postgres rather than to each other, which keeps a crash in one from taking down the others.

## The pieces

| Piece | What it does | Runs as |
|---|---|---|
| `cloudly-web` | The Next.js UI. It forwards `/api` to the API. | `cloudly-app`, no Docker access |
| `cloudly-api` | Sign-in, sessions, settings, the spend limit, and the live event stream. Listens on localhost only. | `cloudly-app`, no Docker access |
| `cloudly-worker` | Claims turns, starts a container for each, commits, pushes, opens pull requests and enforces the limit. | The only user in the `docker` group |
| Postgres | The queue, the event log, sessions and encrypted settings. In Docker on localhost, or your own. | |
| `cloudly-egress` | The key gateway and the allowlisting proxy every run container goes through. | Docker, started by the worker |
| Run containers | One per turn, removed when it ends. The agent runs here. | Non-root, no credentials |
| Caddy | HTTPS in front of the web app. | Docker |

## A turn, start to finish

1. **You send a message.** The API writes a queued run to Postgres and returns at once.
2. **The worker claims it.** It takes the oldest queued run with `FOR UPDATE SKIP LOCKED` and a lease, so two workers never run the same turn, and a crashed worker's turn is picked up again.
3. **It prepares a clone.** A fresh clone of the repo on the session's branch, copied rather than linked so it shares nothing with any other run.
4. **The agent runs.** The worker starts a container with the clone and the agent's runtime. The runner inside picks the adapter for Claude Agent, Codex or Gemini CLI, and every event the agent emits becomes one line of a shared event format.
5. **You watch it live.** The worker writes each event to Postgres; the API streams them to your browser over Server-Sent Events and replays them if you reconnect.
6. **The result is checked.** The agent's changes are exported as a patch in a separate container with no network and no keys, then validated.
7. **Cloudly commits and pushes.** The patch is applied and committed in a second clone the agent never touched, then pushed with a short-lived GitHub App token, and the pull request is opened or updated.

## Why it's built this way

- **One queue in Postgres.** Postgres already holds the data, and `SKIP LOCKED` makes it a safe job queue without Redis or another broker.
- **Server-Sent Events, not WebSockets.** The browser only ever listens. SSE reconnects on its own, replays from the last event it saw, and works through ordinary proxies.
- **Agents behind one interface.** Each agent has an adapter that turns its own events into the shared format. Nothing outside the container knows which agent is inside, which is why the spend limit, cancel and the pull request work the same for all three.
- **The agent's output is untrusted.** The repo's files, its git config and the patch itself could all have been written by a prompt-injected agent, so the host never runs git in a directory the agent could write to.

## The code

```text
apps/web          Next.js UI: landing, docs, sign-in, sessions, settings
apps/api          Hono API: sign-in, sessions, the event stream, budget, settings
apps/worker       Claims turns, drives containers, commits, pushes, opens PRs
packages/runner   Runs inside the container: the Claude, Codex and ACP adapters
packages/db       Prisma schema, migrations and encrypted settings
packages/shared   Contracts shared across the stack
infra/images/base The sandbox image
deploy/           Postgres and Caddy for the installer
```

The full design notes, including the finalize steps in detail, are in [ARCHITECTURE.md](https://github.com/AymanKhan9/Cloudly/blob/main/ARCHITECTURE.md) on GitHub.
