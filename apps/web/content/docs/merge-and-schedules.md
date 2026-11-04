# Merging and schedules

## Merge when ready

Turn on **Merge when ready** in a session's chat box, and Cloudly merges its pull request as soon as nothing stands in the way:

- no turn is running, and the session isn't waiting for your answer;
- Cloudly's [checks](/docs/checks) passed on the latest change;
- if the repository has a reviewer, its review of the latest change found nothing blocking (blocking findings you dismissed don't count);
- every check and status on GitHub for the pull request's latest commit passed;
- GitHub says it can merge: no conflicts, and the branch's rules (required reviews, required checks) are met.

The session's header shows what it's waiting for, like *Waiting for CI: test* or *Blocked by the branch's rules*, and **Merged** once it's done. Cloudly checks every minute, and right away when CI finishes (with [GitHub triggers](/docs/github-triggers) set up).

Two cases it handles on its own:

- **The branch is behind** the base branch, and the repository requires branches to be up to date: Cloudly updates it from the base branch, CI runs again, and it merges after that.
- **The branch conflicts** with the base branch: it can't merge, so the session asks you. Reply something like "merge main and resolve the conflicts" and the agent does it.

The merge names the exact commit that was checked, so if anything is pushed in between, GitHub refuses it and Cloudly looks again. It never approves its own pull request: if the branch needs an approval, that's still yours to give.

Under **Settings → Checks and review**, a repository can have it **on for new sessions**, and pick how to merge: squash (the default), a merge commit, or rebase. The repository has to allow that method on GitHub.

## Schedules

**Schedules** (under **Settings**, in its menu's Automation group) runs tasks on their own, for example:

- every night: update outdated dependencies, run the tests, and fix what breaks;
- every Monday: an [audit](/docs/checks#audit-a-repository) of the repository;
- weekdays at 8:30: look at the issues opened since yesterday and label them.

Each schedule has:

| Setting | |
|---|---|
| **What to do** | A task (runs like a message you sent, and opens a pull request when it changes something), or an audit (lists findings for you to pick from). |
| **Repository, branch and agent** | Where it runs, and which agent does it. |
| **Sessions** | **New each time**: a fresh session per run, named after the schedule and the date. **One session**: every run is the next message in the same session, so the agent remembers the earlier runs. |
| **When** | Hourly, daily, weekdays or weekly, at a time in your time zone. Daylight saving doesn't move it. |

**Run now** runs it within half a minute. **Pause** stops it until you resume it. A run that would start while the last one in the same session is still going is skipped, and so is one when your monthly [spend limit](/docs/spend-limit) is reached; the schedule says so. If the worker was off when a run was due, it runs once when the worker is back, not once for every run it missed.

With **Merge when ready** on for the repository, a scheduled task's pull request can go from start to merged without you.
