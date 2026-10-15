# Agents and models

Cloudly runs three coding agents. Each one reports its work in its own format, and Cloudly translates all of them into one log, so cancel, the spend limit and the pull request behave the same whichever you pick.

| Agent | Runs through | Cost reporting |
|---|---|---|
| Claude Agent | The Claude Agent SDK | Exact, reported by the agent |
| Codex | The Codex SDK | Estimated from token counts |
| Gemini CLI | The Agent Client Protocol (ACP) | Estimated from token counts |

Because Gemini CLI runs over ACP, other ACP agents can be added the same way.

## API keys or your plan

Each agent needs a credential, added under **Settings → Keys and connections**:

- **Claude Agent:** an Anthropic API key, or a Claude plan token. Create the token on your own machine with `claude setup-token` and paste it in. When a plan token is set, it is used instead of the API key.
- **Codex:** an OpenAI API key, or a ChatGPT plan sign-in. Sign in to Codex on your own machine, then paste the contents of `~/.codex/auth.json`. Cloudly refreshes the sign-in itself and saves the new tokens.
- **Gemini CLI:** a Gemini API key.

Turns that run on a Claude or ChatGPT plan cost nothing extra, are marked "On your plan", and don't count toward your [spend limit](/docs/spend-limit). Your plan's own usage limits still apply.

Whichever you use, the credential never enters the sandbox. See [Security model](/docs/security#keys-and-plan-tokens).

## Choose a model

Click the model in the chat box, or type `/model` and press **Enter**. Pick a model from the list, or type any model ID your account can use and choose **Use <ID>**.

The choice is saved on the session and applies from the next turn, so you can change it while a turn is running. It sticks for the rest of the session. On Claude Agent it also overrides a model pinned in the repo's `.claude/settings.json`. Pick **Default** to go back to the agent's own default.

You can also type the command directly:

```text
/model claude-opus-5-5
/model default
```

For Gemini CLI, the default is `gemini-3-flash-preview`. Gemini's own `auto` setting tends to route free-tier keys to models with no quota and stall, so Cloudly pins a fast model unless you set `GEMINI_MODEL` in the [configuration](/docs/configuration).

## Subagents

All three agents can delegate to subagents, which run in the same sandbox and show nested in the chat. See [Sessions and chat](/docs/sessions#subagents).

## Sessions across turns

Each agent keeps its own session between your messages: Claude Agent and Codex resume their native sessions, and Gemini CLI gets the recent conversation replayed. Commands that depend on the session, like `/compact`, work across turns.
