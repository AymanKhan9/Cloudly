# Sandbox and network

Every turn runs in a fresh container that is removed when the turn ends. It runs as a non-root user, with memory, process and capability limits, and sees only the repository and the agent's runtime: never the install directory, the `.env` file or other runs.

## Tools in the sandbox

Every run has Node 22, Bun, Python 3, git and C build tools. To add more, open **Settings → Sandbox tools**:

- Tick a preset (such as Rust, Go or Java), or
- Edit the setup script directly. It runs as root once, when the image is built, not on every run.

```sh
apt-get install -y --no-install-recommends jq
```

Tick **Desktop and browser** to give sessions a virtual desktop with Chromium; see [Desktop and previews](/docs/desktop-and-previews).

Saving starts a build in the background. Runs keep using the previous image until the new one is ready, and a failed build leaves the last good image in place. The agent is told what's installed. Each tool adds roughly 0.3 to 1 GB of disk.

## Beyond the repository

Every run also has `/files`, the repository's [kept files](/docs/secrets-and-files#repo-files), the user's [secrets](/docs/secrets-and-files) as placeholders, and the tools of any connected [MCP servers](/docs/mcp).

## Network access

Run containers have no direct route to the internet and no outside DNS. They can only reach:

- the model APIs, through Cloudly's key gateway,
- the main package registries,
- GitHub,
- the hosts your [secrets](/docs/secrets-and-files) may be sent to,
- and any hosts you add.

This means a malicious repository can't make the agent send data, or your key, anywhere else.

To allow more, open **Settings → Network** and add hosts, one per line. Subdomains are included, and `*` allows everything. Changes apply from the next run.

```text
docs.example.com
registry.internal.example.com
```

## Resource limits

Set these in the [configuration](/docs/configuration) if the defaults don't fit your VM:

| Setting | Default |
|---|---|
| `SANDBOX_MEMORY` | The VM's RAM minus 768 MB (at least 512 MB) |
| `SANDBOX_PIDS` | 2048 |
| `WORKER_CONCURRENCY` | 1 run at a time |
