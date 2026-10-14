# Contributing to Cloudly

Thanks for helping. Cloudly runs coding agents on a VM you own, so changes are judged on two things: does it still work on a small VM, and does it keep the agent's sandbox closed.

## Set up

You need [Bun](https://bun.sh), Docker and Git.

```sh
bun install
docker run -d --name cloudly-dev-db -e POSTGRES_USER=cloudly -e POSTGRES_PASSWORD=cloudly -e POSTGRES_DB=cloudly -p 127.0.0.1:5432:5432 postgres:17-alpine
echo 'DATABASE_URL=postgresql://cloudly:cloudly@127.0.0.1:5432/cloudly' > packages/db/.env
cd packages/db && bunx prisma migrate dev && cd -
docker build -t cloud-agents-base infra/images/base    # the sandbox image runs use
```

Then run the three services, each in its own terminal:

```sh
bun run --filter @repo/api dev     # API on :8787
bun run --filter web dev           # web on :3000, proxies /api to the API
bun apps/worker/src/main.ts        # worker, from the repo root
```

Open http://localhost:3000/setup and follow the steps. For a model, add a key under Settings, or put it in `packages/runner/.env` while developing.

## Check your change

```sh
for d in packages/db packages/runner apps/api apps/worker; do (cd $d && bunx tsc --noEmit); done
(cd apps/web && bun run check-types)
(cd packages/db && bun test)       # needs DATABASE_URL
(cd packages/runner && bun test)
(cd apps/worker && bun test)       # needs Postgres and the sandbox image
```

CI runs the same on every pull request. If you change how runs work, also try one real run: unit tests use stand-in containers, and most bugs found so far only showed up with a real agent.

## Where things live

[ARCHITECTURE.md](ARCHITECTURE.md) explains the design and keeps a status table that says what's tested and what isn't. Please update that table when your change affects it.

- `packages/runner`: runs inside the sandbox and drives one agent through an adapter.
- `apps/worker`: claims runs, starts containers, commits the agent's changes, pushes and opens the PR.
- `apps/api` and `apps/web`: the API and UI.
- `deploy/` and `install.sh`: the installer.

## Adding an agent

An agent is an adapter that turns its CLI or SDK into Cloudly's event stream (`status`, `text`, `tool_call`, `tool_result`, `error`, `done`; see `packages/shared/src/run-event.ts`).

1. **Adapter:** implement `RunAdapter` (`packages/runner/src/adapter.ts`) in `packages/runner/src/adapters/`, with a test for the event mapping. If the agent speaks the [Agent Client Protocol](https://agentclientprotocol.com), extend the ACP adapter instead of writing a new one.
2. **Register it** in `packages/runner/src/index.ts` and give it a harness id.
3. **Credentials** in `apps/worker/src/docker.ts`: the setting it needs, a placeholder value, and the environment variable that points its API at Cloudly's gateway. The real key must never enter the container; add the vendor's API to the gateway in `apps/worker/src/egress-proxy.ts`.
4. **Network:** add the hosts it needs to `EGRESS_DEFAULT_HOSTS` in `packages/db/src/sandbox.ts`.
5. **Cost and sessions:** how to read its cost from the `done` event (`apps/worker/src/cost.ts`) and its session id for resuming (`apps/worker/src/agent-session.ts`).
6. **UI:** add it to `apps/web/lib/harness.ts`.

## Pull requests

Keep them focused. Explain what changed, why, and how you tested it, including any real run. Anything touching the sandbox, credentials or the installer gets a closer review.

## Security

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
