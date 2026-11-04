# Sessions and chat

A session is a conversation with an agent, usually about one repository. Everything it does there lands on one branch and one pull request. A session can also have [no project](#sessions-without-a-project) at all.

## Start a session

Click **New session** (or press **Ctrl K** anywhere in the app), then:

1. Describe the first task.
2. Pick the **repository**, or **No project**. Type in the picker to search long lists.
3. Check the **base branch**. The pull request targets it.
4. Pick the **agent**, its model and how hard it thinks.

Press **Enter** to start, or **Shift + Enter** for a new line.

### Switch agent or model

The picker under the chat box lists every agent you've set up on the left, and the chosen agent's models and effort levels on the right. Pick a different model or effort at any point; it applies from the next turn. Pick a different agent and the session carries on with it: the new agent gets the conversation so far written into its first turn, and works on the same branch.

### Sessions without a project

Pick **No project** for work that isn't about a repository: research, a report, a script you'll copy out. The agent gets a folder of its own at /workspace, kept from turn to turn on your server. Nothing is pushed anywhere, so there's no branch, pull request, checks or merge; what the agent writes stays in that folder and in its [artifacts](/docs/artifacts). Secrets for these sessions are set under **Sessions without a project** in **Settings → Secrets**.

### Several at once

Sessions don't wait for each other. How many turns run at the same time depends on the worker's memory: about one per 1.5 GB, up to four (`WORKER_CONCURRENCY`, see [Configuration](/docs/configuration)). Beyond that, a turn shows "Waiting for the worker to pick this up" until one finishes.

## What happens during a turn

Each message you send is a turn. The worker starts a fresh container for it, checks out the session's branch, and runs the agent. In the chat you see:

- **The agent's replies**, as plain text.
- **Its tool use**, folded into one line such as "Ran 2 commands, read a file". Click it to see every command and file, with a short preview of each result. While the agent is working, the line shows what it is doing right now.
- **Its reasoning**, folded under "Reasoning", when the agent shares it.
- **A footer** with the turn's status, how long it has run, and its cost. Turns on a Claude or ChatGPT plan say "On your plan" instead of a cost.

When the turn ends, Cloudly commits what changed, pushes the branch and opens the pull request on the first turn that changes code. Later turns add commits to the same pull request. A turn that only answers a question changes nothing and commits nothing.

## Follow-ups

Keep talking to the agent in the same session; it remembers the conversation.

### While the agent works

Send a message while a turn runs and it goes to the agent then, not after: "stop, that's the wrong file", "also handle the empty case". It shows in the turn where the agent took it in.

- **Claude Code** reads it at its next step and carries on, without stopping.
- **Codex, Gemini CLI and added agents** are stopped where they are and carry on in the same session with your message; what they'd done stays.

If the turn ends before the agent gets to it, the message becomes the next turn, so nothing you say is lost. **After this turn** sends it as the next turn instead, and a `/command` always waits its turn.

## Keep the sidebar tidy

Right-click a session in the sidebar (or focus it and press **Shift+F10**) for the same actions T3 Code has for threads:

| Action | What it does |
|---|---|
| New session on *repo* | Starts a new session with the same repository and base branch picked. |
| Pin | Keeps it at the top, under **Pinned**. |
| Settle | Folds it into **Settled** at the bottom, for sessions that are done for now. New activity brings it back. |
| Snooze | Hides it for an hour, until tomorrow at 9:00 or until Monday at 9:00. It comes back unread. **Wake it now** brings it back early. |
| Rename | Edits its title in place. |
| Mark unread / Mark as read | Sets the dot by hand. |
| Show only *repo* | Filters the sidebar to one repository. Clear it with the × above the list. |
| Open in a new tab, Open pull request | |
| Copy | Its link, branch, a reference or its id. See [Sessions that talk to each other](#sessions-that-talk-to-each-other). |
| Archive | Hides it under **Archived**, and other sessions can no longer read or message it. |
| Delete | Deletes it and its turns for good, after asking. Its branch and pull request stay on GitHub. Not while a turn is running. |

Sending a message to a session brings it back from Settled, Snoozed or Archived.

### What the marks mean

- **A dot:** a turn ended since you last looked. Opening the session clears it.
- **Needs you:** the agent asked you something (below). Hover over it to read the question.
- **A spinning ring:** a turn is running.

Sessions with a turn queued or running are listed first, under **Working**. Sessions you've settled are folded under **Settled** at the bottom.

## Several sessions side by side

Sessions open as tabs. Click a session in the sidebar and it opens as a new tab in the pane you're working in, or goes to its tab if it's already open.

- **New tab:** the **+** after a pane's tabs opens a new-session form in a tab. The session you start there takes the tab's place; a plan, council or comparison opens on its own page.

- **Split:** the buttons at the right of a pane's tabs split it to the right or downward. The new pane lists your recent sessions to pick from. You can also right-click a session in the sidebar and choose **Open to the side** or **Open below**.
- **Move and arrange:** drag a tab, or a session from the sidebar, onto a pane. Drop it in the middle to move it there, or near an edge to split that pane on that side. Drag a tab along a tab bar to reorder it.
- **Resize:** drag the line between two panes. With the line focused, the arrow keys move it, and double-clicking evens out the panes on either side.
- **Close:** the × on a tab, or a middle-click. The × at the right of a pane's tabs closes the pane.

Each pane scrolls on its own, and the layout is kept in your browser for next time. On a phone you see one pane at a time, with its tabs.

## Show or hide the sidebar

The button at the top of the sidebar hides it, leaving a slim bar with buttons to show it again, start a session, or open Settings. **Ctrl+B** (**⌘B** on a Mac) does the same from anywhere. Cloudly remembers your choice in this browser; **Settings > General** has it too.

## When an agent needs you

Agents in Cloudly work with nobody watching, so they never stop to ask permission: they can already run commands, edit files and install packages in their sandbox, and nothing they do there leaves it except through Cloudly's own checks. When an agent can't go on without you, because a decision is yours to make or it can't find something, it asks with its `ask_user` tool and ends its turn. The session then shows **Needs you** in the sidebar, and its question sits above the chat box. Reply as usual; your answer is the next turn, and the flag clears.

### When it needs a secret

An agent that needs an API key, a token or a password asks for it with its `request_secret` tool rather than in chat. The turn shows a card with the variable's name, what it's for and the hosts it may be sent to. Paste the value and choose **Save securely**:

- The value is stored encrypted, like a [secret you add in Settings](/docs/secrets-and-files), for this session's repository (or for sessions without a project).
- The agent never sees it. From its next turn, the variable holds a placeholder that the network proxy swaps for the real value only on HTTPS requests to those hosts.
- The agent's next turn starts straight away, told that the secret is saved and where it may be used.

Edit the hosts before saving to narrow or widen where it goes. **Decline** tells the agent to carry on without it. Change or remove the secret later under **Settings → Secrets**.

## Sessions that talk to each other

Like threads in T3 Code, a session's agent can see your other sessions and talk to them. Ask for it in plain words: "check what the parser session did and use its date handling here", or "ask the API session whether the invoice endpoint is finished".

The agent has three tools for it:

- **list_sessions:** your other sessions, with each one's title, agent, repo, branch, latest status and pull request.
- **read_session:** a session's conversation (what it was asked and what its agent answered, the last 12 turns) and the branch its work is on. In the same repo, the agent can fetch that branch and look at the code too.
- **send_to_session:** a message to another session. It runs there as that session's next turn, by that session's own agent, on its own branch. If the agent asks for a reply, the answer comes back as a new turn in the session that asked.

To point an agent at a particular session, right-click it in the sidebar and choose **Copy** (see [Keep the sidebar tidy](#keep-the-sidebar-tidy) for the rest of that menu):

| Copy | What you get |
|---|---|
| Link | The session's address. |
| Branch | The branch its work is on, `agent/thread-…`. |
| Session | A line naming the session, its id, repo and branch, ready to paste into another session. |
| Session ID | Just its id. |

Paste any of them into a message in another session, for example "read this session and reuse its date handling", followed by the copied line. The agent's tools also accept the first characters of an id (at least 6, if only one session starts with them) or a session's exact title. Archived sessions are out of reach until you unarchive them.

Messages are delivered when the sending turn ends, so a session can't wait on another one in the middle of a turn. Ask for a reply, and the conversation carries on when it arrives. A turn that came from another session says so above the message, with a link back, and a turn that sent messages lists them under its reply.

**Other sessions** in the chat box sets what a session's agent can reach:

| Setting | What the agent can see and message |
|---|---|
| This repo's sessions (default) | Your sessions on the same repository. |
| All your sessions | Every session you have, on any repository. |
| No other sessions | None. The tools aren't there. |

Agents only ever see your own sessions, never another user's. Before choosing **All your sessions**, keep in mind that it lets work from one repository end up in another: an agent could copy a private repo's conversation into a public repo's pull request.

Limits keep two agents from keeping each other busy on your money:

- A turn can send at most 3 messages, and at most one to each session.
- A chain of messages (A asks B, B's reply reaches A, A asks C, and so on) stops after 4 hops. A turn that deep can still read other sessions but can't send.
- A message is a turn like any other: it costs the same, and it counts toward the [spend limit](/docs/spend-limit).

## Subagents

Agents can hand part of a task to subagents, and Cloudly runs them in the same sandbox as the main agent. They get the same placeholder keys and network rules, and their changes land in the same commit and pull request. On Claude Code, the turn's cost includes its subagents.

Each subagent shows as one row in the turn, with its task and type. Click it to see its own tool activity and the report it handed back. While it works, the row shows that it's running.

| Agent | Subagents | Notes |
|---|---|---|
| Claude Code | Its built-in subagents and any defined in your repo's `.claude/agents/` | |
| Codex | Spawned with its own multi-agent tools | Each subagent gets a nickname, shown as its type. |
| Gemini CLI | Its built-in agents, such as `codebase_investigator` | Gemini's own policy may refuse some agents, such as its general-purpose one. |

To use them, ask for them in your message, for example "use two subagents in parallel: one to map the tests, one to read the API routes".

> Codex and Gemini CLI don't report subagent work through their usual output, so Cloudly reads it from their session logs. If a future version changes those logs, the subagent's row still appears, but its inner steps may not.

## Cancel a turn

Click the stop button in the chat box. The agent stops, and whatever it had already changed is still committed and pushed to the branch, so nothing is lost; that turn just doesn't open a pull request.

## Commands

Type `/` in the chat box to see the commands the agent announced, and use the arrow keys and **Enter** (or **Tab**) to pick one. Commands go to the agent as typed, so `/compact`, `/context` and the skills in your repo work as they do on your own machine.

- **Claude Code** and **Gemini CLI** announce their commands at the start of each turn.
- **Codex** has no `/` commands when it runs headless; anything starting with `/` goes to it as an ordinary message.
- **`/model`** is handled by Cloudly for every agent. See [Agents and models](/docs/agents#choose-a-model).

## The chat box at a glance

| Item | What it shows |
|---|---|
| Model | The session's model. Click it, or type `/model` and press **Enter**, to switch. |
| Effort | How hard the agent thinks. See [Agents and models](/docs/agents#set-the-effort). |
| Agent | The session's agent. |
| Other sessions | Which of your other sessions the agent can read and message. See [Sessions that talk to each other](#sessions-that-talk-to-each-other). |
| Context ring | How full the agent's context window is. `/compact` frees it up on Claude Code. |
| Cost | The session's total, with `~` when it is estimated. |

## Rewind and fork

Every turn that changes code is a checkpoint: its commit on the session's branch. Each finished turn has a **⋯** menu with two ways back to it.

**Rewind to here** undoes the turns after it. The session's branch goes back to that turn's commit (so the pull request shows the session as it was then), and the later turns are greyed out and left out of what the agent remembers. The agent's own saved session is set aside too, so its next turn starts from the conversation as it now stands. You can't rewind while a turn is running, or once the pull request is merged.

The branch is reset with a safe force-push: if anyone pushed to it since the session last did, the rewind stops instead of overwriting their work.

**Fork from here** starts a new session from that point: its own branch, starting at that turn's commit, and the conversation up to that turn. Pick another agent for it if you like ("try this with Codex instead"), and give it its first message. The original session isn't touched, so you can compare the two and keep the better pull request. A fork links back to where it came from.
