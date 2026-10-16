# Sessions and chat

A session is a conversation with one agent about one repository. Everything it does lands on one branch and one pull request.

## Start a session

Click **New session** (or press **Ctrl K** anywhere in the app), then:

1. Describe the first task.
2. Pick the **repository**. Type in the picker to search long lists.
3. Check the **base branch**. The pull request targets it.
4. Pick the **agent**. A session keeps the same agent from start to finish.

Press **Enter** to start, or **Shift + Enter** for a new line.

## What happens during a turn

Each message you send is a turn. The worker starts a fresh container for it, checks out the session's branch, and runs the agent. In the chat you see:

- **The agent's replies**, as plain text.
- **Its tool use**, folded into one line such as "Ran 2 commands, read a file". Click it to see every command and file, with a short preview of each result. While the agent is working, the line shows what it is doing right now.
- **Its reasoning**, folded under "Reasoning", when the agent shares it.
- **A footer** with the turn's status, how long it has run, and its cost. Turns on a Claude or ChatGPT plan say "On your plan" instead of a cost.

When the turn ends, Cloudly commits what changed, pushes the branch and opens the pull request on the first turn that changes code. Later turns add commits to the same pull request. A turn that only answers a question changes nothing and commits nothing.

## Follow-ups

Keep talking to the agent in the same session; it remembers the conversation. Turns run one at a time, so a message you send while the agent is working waits until the current turn ends.

## Subagents

Agents can hand part of a task to subagents, and Cloudly runs them in the same sandbox as the main agent. They get the same placeholder keys and network rules, and their changes land in the same commit and pull request. On Claude Agent, the turn's cost includes its subagents.

Each subagent shows as one row in the turn, with its task and type. Click it to see its own tool activity and the report it handed back. While it works, the row shows that it's running.

| Agent | Subagents | Notes |
|---|---|---|
| Claude Agent | Its built-in subagents and any defined in your repo's `.claude/agents/` | |
| Codex | Spawned with its own multi-agent tools | Each subagent gets a nickname, shown as its type. |
| Gemini CLI | Its built-in agents, such as `codebase_investigator` | Gemini's own policy may refuse some agents, such as its general-purpose one. |

To use them, ask for them in your message, for example "use two subagents in parallel: one to map the tests, one to read the API routes".

> Codex and Gemini CLI don't report subagent work through their usual output, so Cloudly reads it from their session logs. If a future version changes those logs, the subagent's row still appears, but its inner steps may not.

## Cancel a turn

Click the stop button in the chat box. The agent stops, and whatever it had already changed is still committed and pushed to the branch, so nothing is lost; that turn just doesn't open a pull request.

## Commands

Type `/` in the chat box to see the commands the agent announced, and use the arrow keys and **Enter** (or **Tab**) to pick one. Commands go to the agent as typed, so `/compact`, `/context` and the skills in your repo work as they do on your own machine.

- **Claude Agent** and **Gemini CLI** announce their commands at the start of each turn.
- **Codex** has no `/` commands when it runs headless; anything starting with `/` goes to it as an ordinary message.
- **`/model`** is handled by Cloudly for every agent. See [Agents and models](/docs/agents#choose-a-model).

## The chat box at a glance

| Item | What it shows |
|---|---|
| Model | The session's model. Click it, or type `/model` and press **Enter**, to switch. |
| Effort | How hard the agent thinks. See [Agents and models](/docs/agents#set-the-effort). |
| Agent | The session's agent. |
| Context ring | How full the agent's context window is. `/compact` frees it up on Claude Agent. |
| Cost | The session's total, with `~` when it is estimated. |
