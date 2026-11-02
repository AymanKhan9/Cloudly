# GitHub triggers

You can start Cloudly's work from GitHub instead of the web app:

| On GitHub | What Cloudly does |
|---|---|
| Add the `cloudly` label to an issue | Starts a session for the issue. Its pull request says `Closes #<issue>`, and Cloudly comments on the issue with a link to the session. |
| Comment `@cloudly <what to do>` on an issue | Continues the issue's session, or starts one, with your comment as the message. |
| Comment `@cloudly <what to do>` on a pull request | On Cloudly's own pull request, continues its session. On someone else's pull request in the same repository, starts a session on that pull request's branch. |
| Review one of Cloudly's pull requests | The review, with its line comments, becomes the session's next message. |
| CI fails on one of Cloudly's pull requests | The agent gets the failing checks, their annotations and the end of their logs, and another turn to fix them, twice at most. Then the session asks you. |

Cloudly adds 👀 to a comment it's acting on. Turns started from GitHub show where they came from in the session.

## Who can start work

Only people on this Cloudly's sign-in list (the GitHub usernames you entered during setup) can start anything. A comment or label from anyone else is ignored. Bots are ignored too, including Cloudly's own reviewer, so its reviews never start a turn. CI fixes don't need a person, but only happen on Cloudly's own branches.

An issue or pull request written by someone else is still something the agent reads. Only label or mention Cloudly on ones you'd hand to it yourself.

## Setting it up

GitHub needs to reach your Cloudly, so it has to be on a public address.

**A GitHub App made during setup with this version or later** already has the webhook, the events and the permissions. Nothing to do.

**A GitHub App made before** needs them added once. Under **Settings → GitHub triggers**:

1. Copy the webhook URL, and press **Make a secret**. The secret is shown once.
2. Open the app's settings on GitHub. Under **Webhook**, tick **Active**, and paste the URL and the secret.
3. Under **Permissions**, give it **Issues: read and write**, **Checks: read**, **Actions: read** and **Commit statuses: read**.
4. Under **Subscribe to events**, tick **Issues**, **Issue comment**, **Pull request review** and **Check suite**, and save.
5. Whoever installed the app accepts the new permissions (GitHub asks them by email and on the installation's page).

When events start arriving, the settings page lists the latest, and what Cloudly did with each one or why it didn't.

## Per repository

Under **Settings → GitHub triggers**, pick a repository to choose:

- **Agent for new sessions**: which agent works on labelled issues and mentions. Claude Agent by default. Sessions that already exist keep their agent.
- **Labelled issues**, and the label (`cloudly` by default).
- **`@cloudly` in comments.**
- **Reviews on Cloudly's pull requests.**
- **Failing CI on Cloudly's pull requests**, and how many fix attempts (2 by default).

All of them are on by default. Turns started from GitHub count against your [spend limit](/docs/spend-limit) like any other, and nothing starts once it's reached.

The mention is `@cloudly`, or `@<your app's name>`. Set `CLOUDLY_MENTION` in `.env` to use another word.
