# Testing Cloudly end to end on one machine

Everything here runs Cloudly for real (API, worker, Docker sandboxes, the web app) without GitHub, a model key, or the internet:

- `github.ts`: a stand-in for GitHub. It serves the REST calls Cloudly makes (installation tokens, repos, pull requests, comments, reviews, merges, check runs) over bare repos in a folder, signs and delivers webhooks, and also serves a small MCP server and an ACP registry.
- `scripted-agent.js`: an ACP agent that does what its prompt's last `[[ ... ]]` block says (`write`, `run`, `say`, `rich`, `artifacts`, `slow`, `fail`, `ask`, `call`, `recall`), and Cloudly's own jobs (plans, reviews and audits, council answers, lessons, fix turns). See the top of the file.
- `setup.ts`: points Cloudly at the stand-in (a GitHub App, a signed-in user `tester`, the `acme/shop` repo) and adds the scripted agent twice, by command.

## Start

Postgres and Docker running, then from the repo root:

```sh
sudo sh scripts/local-test/github.sh        # the stand-in GitHub, as the worker's user
sh scripts/local-test/api.sh                # the API on :8787
. scripts/local-test/env.sh && bun scripts/local-test/setup.ts http://127.0.0.1:9797 http://127.0.0.1:8787 local-test.json
sudo sh scripts/local-test/worker.sh        # the worker, as a non-root user (default: ubuntu)
(cd apps/web && bun run dev)                # the web app on :3000
```

`local-test.json` has a session cookie for `tester`; set it as the `session` cookie on localhost to use the web app signed in.

Start a session on `acme/shop` with the **Scripted** agent, for example:

```text
Add a greeting [[write hello.txt=Hello; say Added hello.txt.; rich]]
```

It runs in a real sandbox, commits, runs the repo's checks (`npm test`, which fails while a `BROKEN` file exists), and opens a pull request on the stand-in. `GET http://127.0.0.1:9797/_state` shows the pull requests, comments and reviews; `/acme/shop/pull/N` shows one.

Pull request links say `github.com`, the way Cloudly reads them, so open them on the stand-in by path. Downloads the sandbox makes go through Cloudly's egress proxy, which only allows HTTPS: an agent update tried in the sandbox can't fetch the stand-in's plain-HTTP archives.

Run the unit tests against a fresh database, not this one: they expect no settings saved.

## With real agents

The same setup runs real agents; only GitHub stays a stand-in, so nothing reaches your real repositories.

- **Sign-ins:** add a Claude plan token (`claude setup-token`), a ChatGPT sign-in for Codex, or API keys under **Settings → Keys and sign-ins**, as on a real instance.
- **Added agents (OpenCode, Pi and the rest):** `env.sh` points the API and the worker at the stand-in's ACP registry, which lists only the scripted agents. Start both without `ACP_REGISTRY_URL` (`env -u ACP_REGISTRY_URL ...`) to add agents from the real registry. OpenCode's free models need no key.
- **MCP servers:** agents reach them through the egress proxy, which runs in a container. A server on the machine's own `localhost` (like the stand-in's `/mcp`) isn't reachable from there; run a test server in a container on the `cloudly-egress-out` network and connect it by that container's address.
- **Disk:** the sandbox image is about 2 GB and grows with each added agent. Leave several GB free, or image builds fail partway.
