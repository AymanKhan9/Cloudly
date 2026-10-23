# Shared context

When several agents work on one repository, each starts from nothing: Claude doesn't know what Codex decided yesterday, and Cursor on your laptop doesn't know what either of them did. Shared context gives every agent working on a repo the same notes and the same log of recent work, whichever agent it is and wherever it runs.

It's off until you turn it on, per repository.

## Turn it on

Open a session on the repository, click **Context** at the top, then **Turn on shared context**.

From then on, every turn on that repository, in any session and with any agent:

- **Starts from the shared context.** The notes and the latest work from other sessions and editors go in with the agent's instructions (Claude Agent gets them in its system prompt, Codex and Gemini CLI in front of the task).
- **Can add to it.** Agents get two tools: `repo_context` reads it again, and `add_note` records a convention, a decision and its reason, or a gotcha. Agents can only add; they can't edit or delete what's there.
- **Is logged.** After each turn Cloudly records what was asked, which agent did it, what changed (files and lines), the agent's own summary, and the pull request.

## Notes

The notes at the top of the panel are yours to write: the things every agent should follow on this repository.

```text
- Money is integer cents everywhere; never floats.
- Use the fetch wrapper in src/lib/http.ts, not fetch directly.
- Don't touch the generated files in src/gen.
```

Below them is the log. Remove an entry with its trash icon. **Export** downloads notes and log as one Markdown file, for example to commit next to `AGENTS.md`.

## Connect Cursor, Claude Code or Codex on your machine

Your local editor can read and add to the same context through Cloudly's MCP endpoint, `https://<your instance>/api/mcp`.

1. In **Settings → Shared context**, create a token for the editor (for example "Cursor on my laptop"). Copy it: it's shown once.
2. Add Cloudly as an MCP server in the editor. Settings shows the exact snippet for each:

   **Cursor**, in `~/.cursor/mcp.json`:

   ```json
   {
     "mcpServers": {
       "cloudly": {
         "url": "https://<your instance>/api/mcp",
         "headers": { "Authorization": "Bearer <your token>" }
       }
     }
   }
   ```

   **Claude Code**:

   ```sh
   claude mcp add --transport http --scope user cloudly https://<your instance>/api/mcp \
     --header "Authorization: Bearer <your token>"
   ```

   **Codex CLI**, in `~/.codex/config.toml`, with the token in `CLOUDLY_TOKEN`:

   ```toml
   [mcp_servers.cloudly]
   url = "https://<your instance>/api/mcp"
   bearer_token_env_var = "CLOUDLY_TOKEN"
   ```

3. Tell local agents to use it. Add a line like this to the repository's `AGENTS.md`, `CLAUDE.md` or Cursor rules:

   ```text
   Before starting on this repo, read its shared context with the cloudly MCP server (repo_context). When you finish, record what you did (record_work) and add notes for decisions or conventions (add_note).
   ```

The editor gets four tools: `list_repos`, `repo_context`, `add_note` and `record_work`. What it adds shows up in the log under the token's name, and Cloudly's agents see it from their next turn.

A token reaches shared context and nothing else in Cloudly: not your sessions, keys or settings. Revoke it in Settings at any time. Editors outside your network need an [HTTPS install](/docs/installation).

## Good to know

- **It's text the agents read.** A note an agent adds reaches every later agent on that repository, so an agent misled by a malicious repository could leave misleading notes. Each entry says who added it; remove anything you don't trust.
- **Sizes are capped.** The notes can be up to 20,000 characters. What goes in front of a turn is cut to about 8,000 characters, oldest work first; the notes always stay. An agent can add up to 20 notes a turn.
- **A session doesn't see its own turns in the log.** It already has its own conversation.
