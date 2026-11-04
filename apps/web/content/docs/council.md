# Agent council

Ask several agents the same question and have them work it out together. Each one researches on its own, then reads the others' findings and challenges them, then gives a final position. A chair writes one report: where they agree, where they disagree and why, each member's own take, and the sources.

Use it for questions where one model's answer isn't enough: "what's the state of the software job market right now?", "which managed Postgres fits a small team?", or, on a repository, "should this project move to SQLite?".

## Start a council

The quickest way is to name the agents in your question, after a word like "use" or "ask":

```text
Use claude, chatgpt, opencode, gemini and pi for this research work: what changed in AI coding agents in the last three months?
```

The new-session page turns that into a council of those agents as you type: it switches to **Council** and picks them as members. Agents go by the names you'd use: "chatgpt", "codex" and "gpt" are Codex, "claude" is Claude Code, and agents you added are also known by the names you gave them. Names that aren't a request for agents ("use the openai and anthropic SDKs") are left alone.

Before anything starts, Cloudly checks that each named agent can run. One that can't is listed under the question, with the reason (it needs a key, its plan sign-in isn't set, it isn't added under **Settings → Agents**, or it's still being installed), and the council goes ahead with the ones that can, if there are at least two. You can change the members and chair before you press **Enter**.

You can also set it up by hand. On the new-session page, click **+** in the chat box and choose **Council**, then:

1. **Pick the members**: two or more agents, built in or [added](/docs/agents#add-more-agents), each once. There's no limit beyond the agents you've set up; an agent that can't run yet is greyed out, with the reason when you point at it.
2. **Pick each member's model and effort**, or leave them on the agent's default. You might put Claude on its strongest model at high effort and Codex on a fast model at low effort.
3. **Pick the chair** (the crown), who writes the report. Claude Code by default; the chair can also be a member.
4. **Pick the rounds**, from 1 to 10 (three by default). The first round is research and the last is final positions; every round in between is a debate.
5. Choose **Web research** (the default) or **On a repo**, write the question and press **Enter**.

Before it starts, Cloudly shows how many agent turns the council will take, and roughly what they'll cost based on your own recent turns. Each member takes a turn per round, so five members over three rounds is 16 turns with the report. There's no cap for the council itself; its turns count toward your [spend limit](/docs/spend-limit) like any others.

## The rounds

| Round | What each member does |
|---|---|
| **Research** | Works on its own, without seeing the others, so their answers don't steer each other. Gives findings with sources and dates, how sure it is, open questions, and its own take with a confidence. |
| **Debate** (every round between the first and the last) | Reads everyone's latest answers and answers the others by name: checks their claims, says plainly which it thinks are wrong, unsupported or out of date, pushes back where it still disagrees, concedes where they're right, and adds what was missed. |
| **Final positions** (the last round) | Its conclusion after everything it read: confidence, the reason that matters most, and what would change its mind. |
| **Report** | The chair writes the council's report from every member's answers, attributing views by name. |

A member that doesn't finish a round drops out of the later ones; the others carry on. If the chair doesn't finish, the report is each member's last answer, unedited.

The members of a round work at the same time, so a round takes as long as its slowest member, not the sum of them. When they've all finished, the next round starts with everyone's answers.

While it runs, the council page shows each member's progress live. Type a note at any point, like "focus on roles that involve AI tools", and every later turn reads it. **Finish after this round** skips to the report once the current round is done; **Stop** ends the council straight away. When it's done, the report is at the top, with **Download** for a Markdown file. Each member's answer from every round is below it.

## Web research or a repo

**Web research** councils have no repository and none of your secrets or kept files. Since there's nothing in the sandbox to leak, they can reach any public HTTPS site, not just the usual [allowed hosts](/docs/sandbox#network-access), so the agents can read the sources they find. Addresses on your own network, the VM itself and your cloud's metadata service stay out of reach. Each agent also gets its own web search: Claude's and Gemini's are on by default, and Cloudly turns on Codex's for these turns.

**On a repo**, the members read the repository at /workspace, with the usual network rules. Nothing they change is kept, and no branch or pull request is made.

## Cost

A council is several ordinary agent turns: members × rounds, plus the chair's report. A three-member, three-round council is ten turns, and web research turns are the expensive kind. Every turn counts toward your [spend limit](/docs/spend-limit) as usual; turns on a Claude or ChatGPT plan cost nothing extra.

How many turns run at once depends on the worker's memory (`WORKER_CONCURRENCY`, see [Configuration](/docs/configuration)): about one per 1.5 GB, up to four. On a 1 GB VM the members of a round take turns; with 4 GB or more, a round's members work in parallel.

## Good to know

- **"Personal insights" are each model's reading of the evidence**, not opinions of its own. They differ because the models were trained differently and search differently, which is what makes cross-checking them useful.
- **Check the sources** for anything you'll act on. The rounds are designed to catch weak claims, but they can't guarantee there are none.
