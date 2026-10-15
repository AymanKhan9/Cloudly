# Introduction

Cloudly runs coding agents against your GitHub repos on a VM in your own cloud account. You hand it a task in the browser, close the laptop, and come back to a pull request.

It is free, MIT-licensed and self-hosted. There is no Cloudly account and no hosted service in the middle: your VM, your database, your model keys or plan, your GitHub App.

## What you get

- **Three agents, one interface.** Claude Agent, Codex and Gemini CLI. Pick one per session; the chat, cancel button, spend limit and pull request work the same for each.
- **Sessions that end in a pull request.** A session is a conversation on one branch. Every turn that changes code adds commits, and the session opens one pull request.
- **A spend limit that stops.** Set a monthly model-spend limit. You get one warning at 80%, and new turns are refused at 100%.
- **Isolation by default.** Each turn runs in its own non-root container. Your API keys, plan tokens and GitHub credentials never enter it, and it can only reach the hosts you allow.

## How it fits together

One VM runs the web app, the API, a worker and Postgres (or you point it at your own Postgres). When you send a message, the worker starts a throwaway container for that turn, streams the agent's work to your browser, then commits the result from outside the container and pushes it with a short-lived GitHub App token.

[Architecture](/docs/architecture) explains the moving parts, and [Security model](/docs/security) explains what the sandbox can and can't do.

## What it costs

Cloudly itself is free. You pay for:

- **The VM.** Free tiers work: an Oracle Cloud Always Free Arm VM is the roomiest. See [Installation](/docs/installation).
- **Model usage.** Either per-token on your own API keys, or nothing extra on a Claude or ChatGPT plan you already have.

## Next steps

1. [Install Cloudly](/docs/installation) on a VM.
2. [Finish setup](/docs/setup) in the browser.
3. [Start a session](/docs/sessions).
