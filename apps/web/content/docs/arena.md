# Comparing agents

Give the same task to two or three agents at once, look at what each one did, and open the best result as the pull request.

## Start an arena

On the new-session page, click **+** in the chat box and choose **Compare**, then pick the agents (at least two) instead of one. Write the task as usual and press **Enter**.

Each agent gets its own session and its own branch. None of them opens a pull request on its own.

## Compare the results

The arena page shows, for each agent:

| | |
|---|---|
| **Cost** | Exact for Claude Code, estimated (`~`) for Codex and Gemini CLI, or "Plan" on a Claude or ChatGPT plan. |
| **Time** | From the agent's first event to its last. |
| **Changes** | Lines added and removed, and how many files. |
| **Summary** | The agent's own last message. |

The cheapest, fastest and smallest finished results are highlighted. **Diff on GitHub** opens the branch against the base branch, and **Open session** shows the full conversation, where you can keep talking to that agent.

## Pick one

Click **Pick and open PR** on the result you want. Cloudly opens its branch as the pull request, and from then on that session is an ordinary one: follow-ups update the same pull request. The other sessions stay, with their branches pushed, if you want to look again later.

## Good to know

- Each agent's turn costs what it would on its own, and counts toward your [spend limit](/docs/spend-limit).
- How many turns run at once depends on the worker's memory (`WORKER_CONCURRENCY`): about one per 1.5 GB, up to four. On a 1 GB VM an arena of three takes about three turns' time; with 4 GB or more they run side by side.
- An arena can have a [desktop](/docs/desktop-and-previews), which each agent gets.
