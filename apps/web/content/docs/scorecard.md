# Agent scorecard

With several agents on the same repos, Cloudly can tell you which one does best where. **Scorecard** (under **Settings**, in its menu's Workspace group) shows, per agent, for one repo or all of them, over the last 30 to 365 days:

| Column | What it is |
|---|---|
| Sessions, Pull requests | Sessions that did work, and those that opened a pull request |
| Merged | Pull requests merged, by anyone, of those decided. One closed without merging, or open for two weeks, counts as not merged |
| Cost per merge | What the agent's own turns cost in sessions whose pull request merged (a reviewer's cost isn't counted) |
| Checks first try | Turns whose [checks](/docs/checks) passed the first time |
| Fixes per PR | Fix turns for failing checks, failing CI and the reviewer's findings |
| Blocking per review | Blocking findings per review |
| Time to merge | Median, from the session's start |

Merges you make on GitHub count as soon as the GitHub App sends the **Pull request** event (tick it under the app's Permissions & events); without it, Cloudly asks GitHub every few hours.

## Auto

Choose **Auto** as the agent for a new session and Cloudly uses the agent with the best record on that repo: the highest share of pull requests merged, smoothed so 2 of 2 doesn't beat 9 of 10, then the cheaper merge on a tie. It needs an agent to have at least 3 merged or closed pull requests on the repo, and to be set up to run; until then Auto uses the first ready agent. The agent picker says which one Auto would pick and why.
