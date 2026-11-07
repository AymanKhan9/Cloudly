---
title: Cloudly vs Claude Code on the web
description: Claude Code's cloud sessions run Claude on Anthropic's servers. Cloudly runs Claude Code, Codex, Gemini CLI and other agents on a VM you own, with keys kept out of the sandbox.
---
# Cloudly vs Claude Code on the web

**Short answer:** if you only use Claude and want nothing to set up, Claude Code on the web is the simpler choice. Choose Cloudly if you want the agent running on your own server, the choice of other agents for the same task, your tests run on every change, and a hard monthly spend limit.

Both let you hand off a task, close the laptop and come back to a pull request. The difference is whose machine does the work and which agents you can use.

| | Cloudly | Claude Code on the web |
|---|---|---|
| Where the agent runs | A throwaway container on your own VM | Anthropic-managed cloud environments |
| Agents | Claude Code, Codex, Gemini CLI, plus OpenCode, Pi, Cursor, Grok and any ACP agent | Claude only |
| Keeps working with your laptop closed | Yes | Yes |
| Open source | Yes, MIT | No |
| Your keys inside the agent's environment | No: placeholders, filled in by a proxy outside it | Managed by Anthropic |
| Tests run on every change before the pull request | Yes, in a separate container; failures go back to the agent | Up to the agent |
| Spend limit that stops new runs | Yes | Plan limits |
| Start tasks from | Browser, Discord, Slack, GitHub issues and mentions, Sentry, schedules | Browser and Claude apps |
| Cost | Free software. You pay for the VM (or use a free tier) and model usage | Included with paid Claude plans |

*Checked 7 November 2026. Products change quickly; check Anthropic's docs for the current details.*

## Choose Claude Code on the web if

- You only use Claude and are happy with Anthropic running the environment.
- You don't want to run or update a server.
- You want it included in the Claude plan you already pay for.

## Choose Cloudly if

- Your code and the agent's environment should stay on infrastructure you control.
- You want to give the same task to Claude Code and Codex and keep the better pull request.
- You want every change tested before it becomes a pull request, and a second agent to review it.
- You want work to start from Discord, Slack, a labelled GitHub issue or a new Sentry error.

Cloudly runs the official Claude Code through Anthropic's Claude Agent SDK, on your Anthropic API key or your own Claude plan.

[Install Cloudly](/docs/installation) · [How the sandbox keeps keys out](/docs/security)
