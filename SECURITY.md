# Security

Cloudly runs coding agents on untrusted repositories, so isolation bugs matter. Thank you for looking.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue for anything that could put existing installs at risk.

Include what you found, how to reproduce it, and what an attacker gains. You should get a reply within 7 days. Fixes ship in a new release, with credit if you'd like it.

Only the latest release is supported.

## In scope

- Escaping a run container, or reading anything outside it that it shouldn't see (the install directory, `.env`, other runs' workspaces).
- Reading or changing stored secrets (model keys, the GitHub App's private key) without being an allowed user.
- Bypassing sign-in, the allowed-users list, or the one-time setup token.
- Getting the worker to push, or open a PR, with content the agent didn't produce.
- Getting past the spend limit's hard stop.

## Known limitations

These are documented and planned, not new findings. The details are in [ARCHITECTURE.md §8](ARCHITECTURE.md#8-security-boundaries).

- The model API key is in the run container's environment. Run containers can only reach an allowlist of hosts (model APIs, package registries, GitHub, plus any you add), so a prompt-injected agent can't send the key to an arbitrary server. It could still upload it to an allowed service, such as publishing to npm, if the repository supplies the attacker's own credentials for it. Use a separate key with a low limit for Cloudly.
- Docker is the isolation boundary. It's weaker than a microVM, so only connect repositories you'd be comfortable running on the VM.
- The run container uses the worker's own uid (1000 on installs), so a container escape lands as that user, who can run Docker.
- Without a domain, Cloudly serves plain HTTP, so the session cookie and anything typed into Settings cross the network unencrypted. Set a domain for HTTPS.
