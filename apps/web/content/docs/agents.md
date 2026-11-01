# Agents and models

Cloudly runs three coding agents out of the box, and you can add more under **Settings → Agents**. Each one reports its work in its own format, and Cloudly translates all of them into one log, so cancel and the pull request behave the same whichever you pick.

| Agent | Runs through | Cost reporting |
|---|---|---|
| Claude Agent | The Claude Agent SDK | Exact, reported by the agent |
| Codex | The Codex SDK | Estimated from token counts |
| Gemini CLI | The Agent Client Protocol (ACP) | Estimated from token counts |

Because Gemini CLI runs over ACP, other ACP agents can be added the same way. See [Add more agents](#add-more-agents).

## API keys or your plan

Each agent needs a credential, added under **Settings → Keys and connections**:

- **Claude Agent:** an Anthropic API key, or a Claude plan token. Create the token on your own machine with `claude setup-token` and paste it in. When a plan token is set, it is used instead of the API key.
- **Codex:** an OpenAI API key, or a ChatGPT plan sign-in. Sign in to Codex on your own machine, then paste the contents of `~/.codex/auth.json`. Cloudly refreshes the sign-in itself and saves the new tokens.
- **Gemini CLI:** a Gemini API key.

Turns that run on a Claude or ChatGPT plan cost nothing extra, are marked "On your plan", and don't count toward your [spend limit](/docs/spend-limit). Your plan's own usage limits still apply.

Whichever you use, the credential never enters the sandbox. See [Security model](/docs/security#keys-and-plan-tokens).

## Add more agents

**Settings → Agents → Add agent** works like the provider picker in T3 Code. You choose an agent, name it, and give it its keys, in three steps:

1. **Agent.** Pick one from Cloudly's list, search the public [ACP registry](https://agentclientprotocol.com/get-started/registry), or choose **Enter a command** for an agent of your own.
2. **Name.** What sessions and the agent picker call it. For a command of your own, also give the command, its arguments, and an install script if it needs one.
3. **Keys.** The API keys it reads from its environment, and the hosts each one is sent to.

| Agent | Key | Notes |
|---|---|---|
| Cursor | Cursor API key | Cursor trades the key for a short-lived session token, which the agent holds while it runs. |
| Grok | xAI API key | |
| OpenCode | None needed | Runs OpenCode's free models. Add an Anthropic, OpenAI or OpenRouter key for their models. |
| Antigravity | Gemini API key | Adds about 1.3 GB to the sandbox image. Google account sign-in isn't available. |
| Pi | At least one model key | Anthropic, OpenAI, Gemini or OpenRouter. |

For OpenCode, Pi and Antigravity, a key you leave empty falls back to the same key under **Keys and connections**, so you don't have to enter it twice.

Two agents in the list can't be added yet. **Muse Code** signs in only with a Meta account, so its sign-in would have to live inside the sandbox. **fx** connects directly instead of through the sandbox's proxy, and the proxy is the sandbox's only way out.

Once you add an agent, the worker installs it into the sandbox image in the background. **Settings → Sandbox tools** shows the build. Its first session can start when the build finishes. An agent whose install fails is left out; the rest of the image still builds. **Turn off** hides an agent from the pickers but keeps it installed, so turning it back on needs no download. **Remove** takes it out of the next image build.

### Keys stay out of the sandbox

Added agents follow the same rule as the built-in ones. The sandbox gets a placeholder for each key. The egress proxy swaps in the real key only on HTTPS requests to that key's hosts, so a prompt-injected agent has nothing to leak. The sandbox can reach a key's hosts, plus any **Other hosts it needs** you list for the agent (sign-in pages, model lists, update checks). Everything else is blocked as usual. See [Sandbox](/docs/sandbox).

Some agents only offer a browser sign-in or a subscription login. Cloudly can't use those, because the sign-in would have to be stored inside the sandbox.

### What added agents do differently

- **Model:** the chat's model menu lists the models the agent reported on its last turn. `/model <name>` is passed to the agent through ACP.
- **Effort:** not available. Set it through the model, if the agent offers variants.
- **Sessions:** each turn starts clean with the recent conversation in its prompt, the same way Gemini CLI does.
- **Cost:** turns record no cost, so they don't count toward the spend limit, unless you set prices for the agent. See [Configuration](/docs/configuration#prices).

## Choose a model

Click the model in the chat box, or type `/model` and press **Enter**. Pick a model from the list, or type any model ID your account can use and choose **Use <ID>**.

The choice is saved on the session and applies from the next turn, so you can change it while a turn is running. It sticks for the rest of the session. On Claude Agent it also overrides a model pinned in the repo's `.claude/settings.json`. Pick **Default** to go back to the agent's own default.

You can also type the command directly:

```text
/model claude-opus-5-5
/model default
```

For Gemini CLI, the default is `gemini-3-flash-preview`. Gemini's own `auto` setting tends to route free-tier keys to models with no quota and stall, so Cloudly pins a fast model unless you set `GEMINI_MODEL` in the [configuration](/docs/configuration).

## Set the effort

Click the effort pill (the gauge) in the chat box to set how hard the agent thinks. Lower is faster and cheaper; higher thinks longer before acting. The levels depend on the agent:

| Agent | Levels | Default |
|---|---|---|
| Claude Agent | Low, Medium, High, Extra high, Max | High |
| Codex | Low, Medium, High, Extra high | Medium |
| Gemini CLI | Low, High | High |

Like the model, effort is saved on the session and applies from the next turn, so you can change it while a turn runs. You can also set it on the new-session page before the first turn. **Use default** goes back to the agent's own level.

On Claude Agent, Extra high and Max only exist on some models; on others Claude uses the nearest level the model has. On Gemini CLI the level applies to Gemini 3 models; Gemini 2.5 models keep their default.

## Subagents

The three built-in agents can delegate to subagents, which run in the same sandbox and show nested in the chat. An added agent's subagents show as its ordinary tool calls. See [Sessions and chat](/docs/sessions#subagents).

## Sessions across turns

Each agent keeps its own session between your messages: Claude Agent and Codex resume their native sessions, and Gemini CLI gets the recent conversation replayed. Commands that depend on the session, like `/compact`, work across turns.
