# Security model

Cloudly runs coding agents on repositories that may contain prompt injections, so it assumes the agent can be turned against you and limits what it could do.

## Keys and plan tokens

Your API keys and plan tokens never enter a run container. The agent gets a placeholder and an API address that points at Cloudly's key gateway. The gateway adds the real key or token on the way to the vendor, so a malicious repository has nothing to steal.

The agent can still make model calls on your account while its turn runs, through the gateway. It just can't take the credential with it.

## GitHub credentials

The sandbox never sees GitHub credentials. The worker does every git operation (commit, push, pull request) itself, from outside the container, with a short-lived GitHub App token. The agent's own clone has no real remote, so a push from inside the sandbox has nowhere to go.

## Network

Run containers sit on an internal network with no route out and no outside DNS. Traffic leaves only through Cloudly's proxy, to the model APIs, the main package registries, GitHub and any hosts you [add yourself](/docs/sandbox#network-access).

## The container

- Runs as a non-root user, with all Linux capabilities dropped and `no-new-privileges`.
- Has memory and process limits, so a runaway build can't take the VM down.
- Sees only the repository and the agent's runtime, mounted read-only where it can be. Never the install directory, `.env` or other runs.
- Is removed when the turn ends.

## The agent's output

Everything the agent wrote is treated as untrusted. Its changes are exported in a separate container with no network and no keys, validated, and committed in a fresh clone the agent never touched. The host never runs git inside a directory the agent could write to.

## Your instance

- **Invite-only.** Only the GitHub logins you list can sign in.
- **One-time setup.** `/setup` needs the token the installer printed, and closes itself once setup is done.
- **Encrypted settings.** Keys and tokens saved in the browser are encrypted with AES-256-GCM and never shown again.
- **Separated services.** The internet-facing web app and API run as a user with no Docker access. Only the worker can start containers.
- **HTTPS by default,** with or without a domain.

## Known limitations

- **Docker is the isolation boundary.** It's weaker than a virtual machine, so only connect repositories you'd be comfortable running on the VM. A microVM backend is planned.
- **A container escape lands as the worker's user,** who can run Docker.
- **Plain HTTP is possible.** If you decline HTTPS at install time, the session cookie and anything typed into Settings cross the network unencrypted.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue for anything that could put existing installs at risk. You should get a reply within 7 days. See [SECURITY.md](https://github.com/AymanKhan9/Cloudly/blob/main/SECURITY.md).
