# Discord and notifications

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

- **Discord DMs** from the bot, once your Discord account is linked (below).
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
4. Press **Register /cloudly**. Discord can take a few minutes to show the command.
5. Press **Add the bot to a server** and pick your server. It asks for permission to send messages, embed links, read message history, and make and post in threads, nothing more.
6. Press **Make a link code**, and run the `/cloudly link` command it shows in Discord.

The bot doesn't read messages, so it doesn't need Discord's Message Content intent. Replies go through the **Reply** button.
