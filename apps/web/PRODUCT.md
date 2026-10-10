# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Individual developers and small teams who want an autonomous coding agent working on their GitHub repos in the cloud (keeps going after the laptop closes, ends in a pull request) but do not want to pay for a managed agent product. They are comfortable running one command on a VM they own, already hold an API key for at least one model provider, and care about knowing exactly what they are spending.

## Product Purpose

Cloudly is a self-hosted control plane for cloud coding agents. The user deploys it once to their own cloud account, signs in with GitHub, picks a repo, picks a harness, types a task, and gets a branch and a pull request back. Success means: a task handed off from the browser produces a real PR without the user babysitting it, and the user never spends more than the limit they set.

## Positioning

A cheap, user-owned alternative to managed cloud agent products. The user brings their own cloud (aiming for free-tier VMs on AWS, GCP, DigitalOcean and similar), their own model keys, and their own GitHub; Cloudly is free and MIT-licensed. Nothing runs on infrastructure the user does not control, and the user's code and keys never pass through a third-party agent service. Harness choice is plug-and-play rather than locked to one vendor's model.

## Operating Context

- Deployed by the user to a single VM in their own cloud account; the control plane (API, worker, Postgres) and every agent sandbox run there.
- Users reach it in a browser, sign in with GitHub, and work from three places: starting a run, watching a run live, and reviewing the resulting PR on GitHub.
- Each run executes in an isolated, non-root Docker container; GitHub credentials never enter the sandbox. The worker commits deterministically and opens the PR from the host.
- Runs can be cancelled mid-flight; cancellation keeps the work (patch stored, branch pushed) and skips the PR.

## Capabilities and Constraints

- Harnesses available today: Claude Agent (`native-claude`), OpenAI Codex (`native-codex`), Gemini CLI over the Agent Client Protocol (`gemini-acp`). The harness layer is designed to accept more.
- GitHub integration is a GitHub App: sign-in via GitHub OAuth, clone/push/PR via short-lived installation tokens. Sign-in is invite-only through an allowlist of GitHub logins.
- Live run output streams to the browser over Server-Sent Events with replay on reconnect.
- Spend limit: the user sets a monthly model-spend limit. At 80% they get an in-app alert and an email; at 100% new runs are blocked; a turn already running finishes (Claude Agent turns stop at 25% over the limit, keeping their finished work). Email is sent via Resend when the user sets a Resend key; without one, alerts are in-app only. SMTP is not supported yet.
- Cost accuracy differs by harness: Claude Agent reports exact USD per run; Codex and Gemini report token usage, so their cost is an estimate from token counts and a configured price table. The product must label estimates as estimates.
- The spend limit covers model spend only. Cloud VM cost is the user's own cloud bill and is not metered by Cloudly.
- Free-tier VMs typically have about 1 GB of RAM; running Postgres, the control plane and an agent container together on that is tight. Concurrency is one run at a time on the smallest machines. Specific free-tier offers per provider must be verified against each provider's current terms before being claimed anywhere.
- Undecided: multi-user/multi-installation support (currently one GitHub App installation per deployment).

## Brand Commitments

- Name: Cloudly.
- License: MIT, open source.
- Voice: plain and specific. States what it costs and where things run; no inflated claims.

## Evidence on Hand

- A real end-to-end run on `AymanKhan9/Cloudly` produced a real pull request through the full pipeline (clone, sandboxed run, export, deterministic commit, push, PR).
- Architecture and security design documented in `ARCHITECTURE.md` at the repo root.
- No users, testimonials, customer logos, benchmarks, or pricing comparisons exist. None may be fabricated. Competitor products must not be named or compared with invented numbers.

## Product Principles

1. The user owns everything: compute, keys, code, and the data trail. Cloudly never needs a server of its own.
2. Money is a first-class number. Spend is always visible, limits actually stop runs, and estimates are labeled as estimates.
3. Plug-and-play harnesses: switching agents is a dropdown, not a migration.
4. Setup is one command on a VM the user already has; anything that needs a second service must be optional.
5. Untrusted agent output is treated as untrusted, end to end.

- Branding: label the Claude harness "Claude Agent", never "Claude Code" (Anthropic's Agent SDK branding rules).
