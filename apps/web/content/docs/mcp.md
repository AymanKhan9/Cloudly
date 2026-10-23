# MCP servers

Connect MCP servers once, in **Settings → MCP servers**, and every agent can use their tools: Claude Agent, Codex and Gemini CLI alike. Linear, Notion, Sentry, a server on your own network, anything that speaks MCP over HTTP.

## Add a server

1. Open **Settings → MCP servers**.
2. Give it a short name (it becomes the prefix of its tools, like `linear`) and paste its URL, for example `https://mcp.linear.app/mcp`.
3. Pick how it signs in:
   - **OAuth**, for most hosted servers. Cloudly sends you to the server's own sign-in page, and the server sends you back to Cloudly. Nothing has to listen on `localhost`.
   - **Token**, for servers that give you an API key.
   - **None**, for servers that need no sign-in, like one on your own network.
4. Click **Add and sign in** (or **Add server**).

From the next turn, every session has the server's tools. **Turn off** keeps a server without offering it to agents; **Reconnect** signs in again.

## How the sign-in works

Cloudly follows the MCP authorization spec. It asks the server where to sign in, registers itself as a client when the server allows that, and signs you in with a one-time code (PKCE). The callback is your instance's own address:

```text
https://<your instance>/api/settings/mcp/oauth/callback
```

Most servers only accept an HTTPS callback, so OAuth needs an [HTTPS install](/docs/installation). If a server doesn't let apps register themselves, open **Use your own OAuth client**, paste a client ID from the server's developer settings, and register the callback above with it.

Tokens are stored encrypted, like your model keys, and refreshed by the worker before they expire. If the server refuses a refresh, the server shows **Needs sign-in** and the agents stop getting its tools until you reconnect.

## Where the token goes

Nowhere near the agent. A run sees each server as an address on Cloudly's key gateway, `http://cloudly-egress:3129/mcp/<name>`, and the gateway adds the token on the way to the real server. A prompt-injected agent can use the tools during its turn, but it can't take the token with it. See [Security model](/docs/security).

## Limits

- Servers that use the newer "streamable HTTP" transport work everywhere. The older SSE transport may not, since its message URLs point back at the server's own host.
- A repo's own `.mcp.json` still works as before for Claude Agent: the servers you add here come on top.
