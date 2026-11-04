# Checks, review and audits

After every turn that changes code, Cloudly runs the repository's checks (usually its tests) before it commits. If they fail, the same agent gets another turn to fix them. You see the result in the chat, and it's noted in the pull request.

## What runs

Under **Settings → Checks and review**, pick a repository and choose what to run:

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

## Review

Once the checks pass (or a repository has none), a second agent can review the change. Pick it under **Settings → Checks and review → Reviewer**. It's off until you pick one. A different agent from the one doing the work tends to catch more: Codex reviewing Claude's work, for example.

The reviewer looks at what the session changed, from the base branch to the session's branch, not the whole repository. It reads the code around the change and can run the tests, but nothing it changes is kept. It sorts what it finds into three kinds:

| Kind | Means | What happens |
|---|---|---|
| **Blocking** | A real defect: a bug, a security hole, a broken test, or not doing what you asked | Goes back to the agent that made the change, as a turn of its own |
| **Suggestion** | Worth changing, but not wrong | Waits for you |
| **Nit** | Style and naming | Waits for you |

After the fix, the checks run again and the reviewer looks again. That happens up to **Fix rounds** times (2 by default). If blocking findings are still there after that, the session stops and asks you.

When the session has a pull request, the review is posted there too, with comments on the lines (turn off **Post the findings as a review** if you'd rather not). It's posted as a comment, never an approval.

## The Changes tab

Every session has a **Changes** button. It shows everything the session has changed so far, file by file, with the reviewer's findings on the lines they're about. From there you can:

- **Tick findings** to send to the agent, and **dismiss** the ones that aren't worth fixing.
- **Comment on any changed line**: hover it and press **+**.
- **Send** them, with a note if you like. The ticked findings and your comments go to the agent together, as one message.
- **Review now**: start a review yourself, with the repository's reviewer or, without one, the session's agent.

## Audit a repository

On the new-session page, **Audit** (under the **+** in the chat box) starts a session that reviews the whole repository instead of changing it. You can say what to focus on (security, error handling, one part of the code) or leave it blank. The agent lists what it finds, most important first, with the same three kinds. Nothing is fixed automatically: open **Changes**, tick the findings you want fixed, and send them. From then on it's an ordinary session, with a branch and a pull request.

Each review and each audit is a turn, and costs like one.
