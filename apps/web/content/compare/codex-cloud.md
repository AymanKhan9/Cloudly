---
title: Cloudly vs OpenAI Codex cloud
description: Codex cloud runs OpenAI's agent on OpenAI's servers. Cloudly runs Codex, Claude Code, Gemini CLI and more on a VM you own, and checks every change before the pull request.
---
# Cloudly vs OpenAI Codex cloud

**Short answer:** if Codex is the only agent you use and you're fine with OpenAI running the environment, Codex cloud is less to set up. Choose Cloudly to run Codex on your own server, next to Claude Code and other agents, with your tests and a spend limit in the loop.

| | Cloudly | Codex cloud |
|---|---|---|
| Where the agent runs | A throwaway container on your own VM | OpenAI-managed cloud environments |
| Agents | Codex, Claude Code, Gemini CLI, plus OpenCode, Pi, Cursor, Grok and any ACP agent | Codex only |
| Keeps working with your laptop closed | Yes | Yes |
| Open source | Yes, MIT | The Codex CLI is open source; the cloud service is not |
| Your keys inside the agent's environment | No: placeholders, filled in by a proxy outside it | Managed by OpenAI |
| Tests run on every change before the pull request | Yes, in a separate container; failures go back to the agent | Up to the agent |
| Run one task on several agents | Yes: compare cost, time and diff, keep the best | No |
| Cost | Free software. You pay for the VM and model usage, or sign Codex in with ChatGPT | Included with ChatGPT plans |

*Checked 7 November 2026. Check OpenAI's docs for the current details.*

## Choose Codex cloud if

- Codex is your only agent and you want zero setup.
- Your team already works inside ChatGPT.

## Choose Cloudly if

- You want Codex to run on your server, with network access limited to the hosts you allow.
- You want to race Codex against Claude Code on the same task and open the better result.
- You want tests, a reviewer agent and a hard spend limit around every run.

[Install Cloudly](/docs/installation) · [Compare agents on one task](/docs/arena)
