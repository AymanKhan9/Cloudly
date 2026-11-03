# Sentry

Connect Sentry and a new error in production starts a session: the agent finds the cause, writes a test that fails the same way, fixes it, and the session goes through your checks, review and pull request like any other.

## Setting it up

Under **Settings > Sentry**:

1. In Sentry, make an internal integration (Settings > Developer Settings > Custom Integrations > Create New Integration > Internal Integration). Set its webhook URL to the one Cloudly shows, tick **issue** under Webhooks, turn on **Alert Rule Action**, and give it Read access to Issue & Event.
2. Paste its **client secret** into Cloudly: it checks that each webhook really came from Sentry. Its **token** is optional: with it, Cloudly reads the error's stack trace, which Sentry's issue webhook leaves out.
3. Map each Sentry project to a repo, and choose the agent (the repo's GitHub-trigger agent by default) and how many sessions a day it may start (5 by default).

For self-hosted Sentry, set its address too.

## What starts a session

- A **new issue** (level error or fatal; warnings and info are ignored), or an **alert rule** with Cloudly's integration as its action, which lets you choose with Sentry's own conditions (only after 100 events, only in production, and so on).
- Each issue starts one session, ever, and each project at most its daily number, so an outage doesn't start fifty.
- The session belongs to whoever added the project, and counts toward their spend limit.

The agent gets the error, the culprit, the app's own stack frames with their code lines, how often it happened, and the link to Sentry. All of that comes from your running app and may include text your users typed, so the agent is told to read it as data about the error, not as instructions, and it's fenced off in the prompt. If the agent can't reproduce the error, or the cause isn't in the repo, it says so and stops rather than guessing.
