# Security model

Cloudly runs coding agents on repositories that may contain prompt injections, so it assumes the agent can be turned against you and limits what it could do.

## Keys and plan tokens

Your API keys and plan tokens never enter a run container. The agent gets a placeholder and an API address that points at Cloudly's key gateway. The gateway adds the real key or token on the way to the vendor, so a malicious repository has nothing to steal.

The agent can still make model calls on your account while its turn runs, through the gateway. It just can't take the credential with it.

## MCP tokens and secrets

[MCP servers](/docs/mcp) work like model keys: a run sees each server as an address on the key gateway, and the gateway adds the token. [Secrets for runs](/docs/secrets-and-files) reach the sandbox as placeholders. For the hosts a secret may go to, the egress proxy terminates TLS with a certificate from Cloudly's own CA, puts the real value into the request's headers and URL, and sends it on. It sends the request only to the host the tunnel was opened for, whatever the request's `Host` header says, so a placeholder can't be turned into the value for any other host. The CA's private key stays in the worker's data directory and is never mounted into a container.

## Shared context

[Editor tokens](/docs/shared-context) reach the shared-context MCP endpoint and nothing else; only their SHA-256 is stored, and they can be revoked in Settings. Notes an agent adds come back from the sandbox the way the patch does (a regular file, never a symlink, with size and count caps), and are stored as plain text. They are text later agents read, so a misled agent could leave a misleading note: each entry names who added it, and you can remove it.

## Desktops and previews

These are the one deliberate way in to a sandbox. The browser never connects to a container: it gets a short-lived token from the API, signed for one container and one purpose, and Cloudly's relay checks it before connecting to that container's VNC port (desktop) or preview port (app). The relay has no other routes. A desktop's VNC server also has its own password per turn, so other containers on the sandbox network can't watch it.

A preview runs code from the agent's branch, so it opens on its own origin (the same host, port 8443 or 3141), never on Cloudly's. The relay strips Cloudly's cookies from requests to it and refuses to let the app set them, and the API refuses writes from any origin but its own, so the app's code can't act as you in Cloudly. A preview container gets no model keys. To keep a preview's code out of your browser altogether, view it on the sandbox's desktop instead.

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

- **A preview shares your instance's host name.** Browsers keep cookies per host, not per port, and the relay strips Cloudly's own ones, but a preview's app can still set and read cookies of its own on that host.
- **Docker is the isolation boundary.** It's weaker than a virtual machine, so only connect repositories you'd be comfortable running on the VM. A microVM backend is planned.
- **A container escape lands as the worker's user,** who can run Docker.
- **Plain HTTP is possible.** If you decline HTTPS at install time, the session cookie and anything typed into Settings cross the network unencrypted.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue for anything that could put existing installs at risk. You should get a reply within 7 days. See [SECURITY.md](https://github.com/AymanKhan9/Cloudly/blob/main/SECURITY.md).
