# Desktop and previews

Agents can use a virtual desktop with a browser, and you can watch it live or take control. Previews run a session's app from its branch so you can try it before merging.

## Turn the desktop on

The desktop needs a few packages in the sandbox image. In **Settings → Sandbox tools**, tick **Desktop and browser** and save. The image builds in the background (about 600 MB).

Then, in a session, click **Desktop** in the chat box (or on the new-session page) before sending a message. From the next turn the agent gets:

- a virtual display (1280 × 800) with Chromium, and
- desktop tools: `screenshot`, `click`, `type`, `key`, `scroll`, `open_url` and `wait`.

The tools are an MCP server inside the sandbox, so Claude Agent, Codex and Gemini CLI all get the same ones. Ask for them directly: "start the dev server, open it in the desktop's browser and check the checkout page at mobile width".

## Watch it

While a turn with a desktop runs, a **Desktop** button appears at the top of the session. It shows the screen live. **Take control** lets you use the mouse and keyboard yourself, for example to sign in somewhere, and **Hand back** returns to watching.

## Previews

Click **Preview** at the top of a session, enter the command that starts the app and the port it listens on, and click **Start preview**:

```text
Command  npm install && npm run dev
Port     3000
```

Cloudly starts the session's branch in a sandbox of its own, with the same network rules, secrets and `/files` as the agent's runs, and no model keys. When it's running:

- **Open in a new tab** opens the app in your browser, on a separate address (your instance's on port 8443, or 3141 on plain HTTP).
- **Watch on the desktop** shows it in the sandbox's own browser instead, if you ticked **Also open it on the sandbox's desktop**. The app's code then never runs in your browser at all.

The app can listen on `localhost` only, the default for most dev servers: Cloudly forwards to it. A preview stops after an hour (`PREVIEW_TTL_MINUTES`), when you click **Stop**, or when its command exits. Its output is shown under **Output**. One preview runs at a time unless you raise `PREVIEW_MAX`.

## Setting up previews

The installer sets this up. On an install from before previews, re-run it, or set these in `.env` and restart the services:

| Variable | HTTPS install | Plain HTTP install |
|---|---|---|
| `PREVIEW_ORIGIN` | `https://<address>:8443` | `http://<address>:3141` |
| `PREVIEW_BIND` | `127.0.0.1` (Caddy fronts it) | `0.0.0.0` |

Open that port (8443 or 3141) in your cloud firewall. Without `PREVIEW_ORIGIN`, previews still work on the desktop.

## How it's kept safe

Nothing reaches a sandbox directly. Both features go through Cloudly's relay, a small container that only accepts a short-lived token the API signs for one container, and only connects to that container's VNC port or its preview port. See [Security model](/docs/security#desktops-and-previews).
