# Plans

Some work is too big for one session: "add multi-currency billing" touches the schema, the API, the dashboard and the PDFs. A plan breaks it into tasks, each its own session and pull request, and runs them side by side where it can.

## Making a plan

On the new-session page, click **+** in the chat box and choose **Plan**, pick the repository and an agent, and describe the work. The agent reads the repository (changing nothing) and writes the tasks:

- a title and instructions for each, saying what to change, where, and how to check it;
- which tasks each one **waits for**: the ones whose code it builds on.

The plan page shows them in **steps**. Tasks in the same step don't depend on each other and run at the same time; the next step starts once the tasks it waits for are merged.

## Looking it over

Before anything runs you can change any task's title or instructions, add or remove tasks, and change what each one waits for. Then choose:

- **Agent for the tasks**: it can differ from the one that planned.
- **At the same time**: how many tasks may work at once (3 by default).
- **Merge each task's pull request when it's ready** (on by default): with [merge when ready](/docs/merge-and-schedules) on, each task's pull request merges itself once its checks, review and CI pass, so the tasks after it start on code that includes it. Turn it off and the next step waits for you to merge each pull request.

Not happy with the tasks? **Plan it again**, with the same goal or a changed one.

## While it runs

Each task's session is an ordinary session, with checks, review, Changes tab and all. It knows it's one task of a plan, and does only its part. The plan page shows each task's state:

| State | Means |
|---|---|
| Waiting | Its turn hasn't come: the tasks it waits for aren't merged yet, or the plan is at its limit. |
| Working | Its session is running. |
| Pull request open | Done and waiting to merge (with what merge-when-ready is waiting for). |
| Needs you | Its session asked something, or the agent changed nothing. Open the session and answer. |
| Failed | Its turn failed. Open the session to fix it, or skip it. |
| Done / Skipped | Merged, or skipped by you. |

A task that needs you only holds up the tasks that wait for it; the rest carry on. **Skip** a task to let the ones after it go ahead without it. **Cancel plan** stops new tasks from starting; sessions already working carry on.

When every task is done, you're told the way you get [notifications](/docs/discord-and-notifications). Each session and turn costs what it normally would; planning is one turn.
