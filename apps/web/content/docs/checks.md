# Checks and fixes

After every turn that changes code, Cloudly runs the repository's checks (usually its tests) before it commits. If they fail, the same agent gets another turn to fix them. You see the result in the chat, and it's noted in the pull request.

## What runs

Under **Settings → Checks**, pick a repository and choose what to run:

- **Detect** (the default) finds the command from the repository's own files:

  | The repository has | Cloudly runs |
  |---|---|
  | `package.json` with a `test` script | `bun install && bun run test` with a `bun.lock`, `corepack pnpm …` with a `pnpm-lock.yaml`, `corepack yarn …` with a `yarn.lock`, otherwise `npm install && npm test` |
  | pytest (in `pyproject.toml`, a `pytest.ini` or a `conftest.py`) | `python3 -m pytest -q`, after `pip install -r requirements.txt` when there is one |
  | `go.mod` | `go test ./...` |
  | `Cargo.toml` | `cargo test` |
  | a `Makefile` with a `test` target | `make test` |

  The page shows what the last run used.
- **Command**: your own, run with bash in the repository's root. For example `bun install && bun run typecheck && bun test`.
- **Off**: nothing runs after a turn.

## How it runs

The checks run in a container of their own, after the turn's changes have been captured, so nothing they do can change what's committed. They get the same network rules, secrets and `/files` as the agent, but no model keys. They run with `CI=true`, so test runners skip watch mode. If they run longer than the time limit (10 minutes by default), they're stopped and count as failing.

A turn that only answers a question, a turn you cancelled, and a `/command` aren't checked.

## When checks fail

The change is still committed and pushed, with the failing result shown in the chat and noted in the pull request. Then Cloudly gives the same agent a new turn: the command, the end of its output, and the instruction to fix the code without skipping or weakening tests. That turn shows in the chat as Cloudly's request, not yours.

Cloudly does this up to **2 times in a row** by default (set it from 0 to 5 under Settings → Checks). If the checks still fail, the session is marked **Needs you** and waits for your reply. A message you send starts the count again.

No fix turn is started when:

- the checks couldn't run at all, for example because a tool isn't installed (`Couldn't run checks`; add it under [Sandbox tools](/docs/sandbox) or change the command);
- you've already sent the session another message;
- your [spend limit](/docs/spend-limit) is reached. The session is marked Needs you instead.

Each fix attempt is an ordinary turn, and costs like one.
