# Agent council

Ask several agents the same question and have them work it out together. Each one researches on its own, then reads the others' findings and challenges them, then gives a final position. A chair writes one report: where they agree, where they disagree and why, each member's own take, and the sources.

Use it for questions where one model's answer isn't enough: "what's the state of the software job market right now?", "which managed Postgres fits a small team?", or, on a repository, "should this project move to SQLite?".

## Start a council

On the new-session page, click **Council**, then:

1. **Pick the members**: two or three of Claude Agent, Codex and Gemini CLI.
2. **Pick the chair**, who writes the report. Claude Agent by default; the chair can also be a member.
3. **Pick the rounds** (three by default):
   - **1 round**: research only, then the report.
   - **2 rounds**: research, then cross-review.
   - **3 rounds**: research, cross-review, then final positions.
4. **Set a spending cap** for the whole council ($5 by default).
5. Choose **Web research** (the default) or **On a repo**, write the question and press **Enter**.

Before it starts, Cloudly shows how many agent turns the council will take, and roughly what they'll cost based on your own recent turns.

## The rounds

| Round | What each member does |
|---|---|
| **Research** | Works on its own, without seeing the others, so their answers don't steer each other. Gives findings with sources and dates, how sure it is, open questions, and its own take with a confidence. |
| **Cross-review** | Reads everyone's research. Checks their claims, says plainly which it thinks are wrong or unsupported, adds what was missed, and says what changed its mind. |
| **Final positions** | Its conclusion after everything it read: confidence, the reason that matters most, and what would change its mind. |
| **Report** | The chair writes the council's report from every member's answers, attributing views by name. |

A member that doesn't finish a round drops out of the later ones; the others carry on. If the chair doesn't finish, the report is each member's last answer, unedited.

While it runs, the council page shows each member's progress live. Type a note between rounds, like "focus on roles that involve AI tools", and every later turn reads it. **Stop** ends the council early. When it's done, the report is at the top, with **Download** for a Markdown file. Each member's answer from every round is below it.

## Web research or a repo

**Web research** councils have no repository and none of your secrets or kept files. Since there's nothing in the sandbox to leak, they can reach any public HTTPS site, not just the usual [allowed hosts](/docs/sandbox#network-access), so the agents can read the sources they find. Addresses on your own network, the VM itself and your cloud's metadata service stay out of reach. Each agent also gets its own web search: Claude's and Gemini's are on by default, and Cloudly turns on Codex's for these turns.

**On a repo**, the members read the repository at /workspace, with the usual network rules. Nothing they change is kept, and no branch or pull request is made.

## Cost

A council is several ordinary agent turns: members × rounds, plus the chair's report. A three-member, three-round council is ten turns, and web research turns are the expensive kind. Every turn counts toward your [spend limit](/docs/spend-limit) as usual; turns on a Claude or ChatGPT plan cost nothing extra. The council stops at its cap after the round in which it's reached, with a report made from what it has. Claude Agent also stops itself mid-turn at the cap; Codex and Gemini can go over by that one turn.

Turns run one at a time unless `WORKER_CONCURRENCY` is higher, so on a small VM a council takes a while. With more concurrency, the members of a round work in parallel.

## Good to know

- **"Personal insights" are each model's reading of the evidence**, not opinions of its own. They differ because the models were trained differently and search differently, which is what makes cross-checking them useful.
- **Check the sources** for anything you'll act on. The rounds are designed to catch weak claims, but they can't guarantee there are none.
