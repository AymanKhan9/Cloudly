---
title: Cloudly vs OpenHands
description: Both are MIT-licensed and can run several coding agents. OpenHands is a broad platform with its own agent and SDK; Cloudly is a single-VM install focused on keeping credentials out of the sandbox and checking work before it becomes a pull request.
---
# Cloudly vs OpenHands

**Short answer:** OpenHands is the bigger, more established open-source platform, with its own agent, an SDK, Kubernetes deployments and a hosted cloud. Cloudly is narrower: one command on one small VM, built around keeping keys out of the sandbox, testing every change, and a spend limit that stops runs.

| | Cloudly | OpenHands |
|---|---|---|
| License | MIT | MIT (core) |
| Agents | Claude Code, Codex, Gemini CLI built in, plus any ACP agent | Its own agent, plus other agents over ACP |
| Install | One command on a 1 GB Ubuntu or Debian VM | Docker, VMs or Kubernetes; also a hosted cloud |
| Keys inside the agent's environment | No: placeholders, filled in by a proxy outside it | Depends on how you deploy it |
| Changes checked before the pull request | Tests in a separate container, patch validated and committed in a clean clone | Up to the agent and your CI |
| Spend limit | Monthly limit, new runs refused at 100% | Not built in |
| Best for | Individuals and small teams on their own server | Teams that want a platform and an SDK to build on |

*Checked 7 November 2026. See the OpenHands docs for current details.*

## Choose OpenHands if

- You want a mature project with a large community and an SDK to build your own agents.
- You need Kubernetes-scale deployments or a hosted option.

## Choose Cloudly if

- You want the smallest possible self-hosted setup that still isolates credentials.
- You want Claude Code and Codex as first-class agents, on API keys or your own Claude or ChatGPT plan.
- You want a hard monthly spend limit.

[Install Cloudly](/docs/installation) · [Security model](/docs/security)
