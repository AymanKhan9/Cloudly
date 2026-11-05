# Discord, Slack and notifications

## Notifications

Under **Settings → Notifications**, choose when and where Cloudly tells you about a session:

| When | |
|---|---|
| **Needs you** | The agent asked a question, the pull request has conflicts, or the fixes for failing checks, CI or review ran out. |
| **Done** | The session finished: what the agent said, and how much changed. |
| **Failed** | A turn failed. |
| **Merged** | [Merge when ready](/docs/merge-and-schedules) merged the pull request. |

You hear once a session **settles**, when its last automatic turn is done. A turn whose checks fail, its fix, the review and the review's fix are one message at the end, not four.

Where:

- **Discord DMs** from the bot, once your Discord account is linked (below). A session started in Discord posts in its own thread instead.
- **Slack DMs** from the Slack app, once your Slack account is linked (below).
- **A Discord channel**, through a webhook: in the channel's settings, Integrations, Webhooks, New Webhook, Copy Webhook URL. No bot needed.
- **Slack**, through an incoming webhook from a Slack app.

Webhook URLs contain a token, so they're stored encrypted, and only Discord and Slack webhook addresses are accepted. **Send a test** sends one to everywhere you've set up.

## The Discord bot

With the bot you can start sessions from Discord and follow them there:

| Command | |
|---|---|
| `/cloudly task prompt:… [repo:…] [agent:…] [branch:…]` | Starts a session. Its updates go to a Discord thread made on the reply, with **Reply**, **Cancel turn** and **Open in Cloudly** buttons. |
| `/cloudly repo repo:owner/repo` | Sets the channel's default repository, so `task` doesn't need it. |
| `/cloudly status` | Your recent sessions, only shown to you. |
| `/cloudly link code:…` | Links your Discord account to Cloudly. |

**Reply** opens a box for your message, which becomes the session's next turn, the same as typing it in Cloudly. Only linked accounts can use the commands and buttons, and only on their own sessions. Nothing the agent writes can ping anyone.

### Setting it up

The bot runs over HTTP: Discord sends each command to Cloudly, signed, and Cloudly answers. There's no extra process to run, but Cloudly has to be on a public address, as for [GitHub triggers](/docs/github-triggers).

1. At [discord.com/developers/applications](https://discord.com/developers/applications), create an application.
2. Under **Settings → Discord** in Cloudly, paste its **application ID** and **public key** (from General Information) and its **bot token** (from Bot, Reset Token), and save.
3. Copy the **interactions endpoint URL** Cloudly shows into the application's General Information, and save there. Discord checks it straight away.
4. Press **Add the bot to a server** and pick your server. It asks for permission to send messages, embed links, read message history, and make and post in threads, nothing more.
5. Press **Register /cloudly**. It adds the command to each server the bot is in, where it shows at once (reload Discord with Ctrl+R if it doesn't). After adding the bot to another server, press it again.
6. Press **Make a link code**, and run the `/cloudly link` command it shows in Discord.

The bot doesn't read messages, so it doesn't need Discord's Message Content intent. Replies go through the **Reply** button.

## The Slack app

The same in Slack, with one command:

| Command | |
|---|---|
| `/cloudly <what to do> [repo:owner/repo] [agent:claude\|codex\|gemini] [branch:name]` | Starts a session. Cloudly posts a **Started** message in the channel and threads the session's updates under it, with **Reply**, **Cancel turn** and **Open in Cloudly** buttons. |
| `/cloudly repo owner/repo` | Sets the channel's default repository. |
| `/cloudly status` | Your recent sessions, only shown to you. |
| `/cloudly link CODE` | Links your Slack account to Cloudly. |
| `/cloudly help` | The list above. |

`repo:`, `agent:` and `branch:` can go anywhere in the message. In a channel the app can't post in, the updates come to you as DMs instead.

### Setting it up

Like the Discord bot, it runs over HTTP: Slack sends each command and button press to Cloudly, signed with the app's signing secret, and requests more than five minutes old are refused.

1. Under **Settings → Slack** in Cloudly, copy the **manifest**. It has Cloudly's addresses filled in.
2. At [api.slack.com/apps](https://api.slack.com/apps?new_app=1), choose **From a manifest**, pick your workspace, paste it, and create the app. Then **Install to Workspace**.
3. Paste the app's **signing secret** (Basic Information, App Credentials) and its **bot token** (`xoxb-…`, from OAuth & Permissions) into Cloudly, and save.
4. Press **Make a link code**, and run the `/cloudly link` command it shows in Slack.

The app asks only for `commands`, `chat:write`, `chat:write.public` (to post in public channels it hasn't been added to) and `im:write` (for DMs).
