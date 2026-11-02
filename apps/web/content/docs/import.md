# Importing sessions

Started something in Claude Code on your laptop, or in Codex, Pi, Gemini CLI or OpenCode? Bring the session into Cloudly and carry on there: the conversation, and your work.

## From your computer

The **Import** page gives you a command and a token for it. Run it in the repository you worked in:

```
curl -fsSL https://<your instance>/api/import.mjs -o cloudly-import.mjs
CLOUDLY_TOKEN=cly_... node cloudly-import.mjs
```

It lists that repository's sessions from every agent it knows, newest first, and imports the one you pick. To carry on from exactly where you were, it pushes your work (your commits, and the changes you haven't committed) to a new branch, `cloudly/import-…`, after showing you what's in it. It does that with a separate index, so your files, your index and your branches stay as they are. Files your `.gitignore` leaves out, like `.env`, aren't pushed.

| Option | Does |
|---|---|
| `--agent native-codex` | Carry on with another agent (the one that wrote the session, by default, when Cloudly has it) |
| `--message "..."` | A first message, sent once it's imported |
| `--no-code` | Push nothing: the session starts from the base branch |
| `--repo owner/name` | The repository, when the git remote doesn't say |
| `--latest` | Take the newest session without asking |
| `path/to/file` | Import that file instead of looking |

It needs Node 18 or later and git, and nothing else.

## Uploading a file

Or drop a session file on the Import page and choose the repository. Where each agent keeps its sessions:

| Agent | Sessions |
|---|---|
| Claude Code | `~/.claude/projects/<folder>/<session id>.jsonl` |
| Codex | `~/.codex/sessions/<year>/<month>/<day>/rollout-…jsonl` |
| Pi | `~/.pi/agent/sessions/--<folder>--/…jsonl` |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/session-….json` |
| OpenCode | `opencode export <session id> > session.json` |
| Any other agent | JSON with `{"messages": [{"role": "user", "content": "..."}, ...]}`, or text with `User:` and `Assistant:` lines |

A file has the conversation but not your uncommitted work. Push that to a branch and name it under **Branch with your work**, or use the command.

## What you get

A session whose first turns are the conversation: each of your messages, what the agent wrote, and the tools it used. Up to the 300 most recent turns are kept.

- **The same agent picks up its own session** when it's Claude Code, Codex or Pi: Cloudly puts the session file where that agent keeps its sessions, with the folder it ran in changed to the sandbox's, so it remembers everything, its own compactions included.
- **Any other agent** (or Gemini CLI and OpenCode, which can't load an outside session) gets the conversation written into each message: the agent's own summary if it compacted, then the most recent turns.

Each session carries on in its own branch and pull request like any other. You can rewind or fork to the last imported turn (the code as it was imported), but not to earlier ones: Cloudly never had the code as it was then.

The token reaches session imports and [shared context](/docs/shared-context), nothing else. Remove it under Settings when you're done.
