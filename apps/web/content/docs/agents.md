# Agents and models

Cloudly runs three coding agents out of the box, and you can add more under **Settings → Agents**. Each one reports its work in its own format, and Cloudly translates all of them into one log, so cancel and the pull request behave the same whichever you pick.

| Agent | Runs through | Cost reporting |
|---|---|---|
| Claude Code | The Claude Agent SDK | Exact, reported by the agent |
| Codex | The Codex SDK | Estimated from token counts |
| Gemini CLI | The Agent Client Protocol (ACP) | Estimated from token counts |
| Pi, OpenCode (added) | ACP | Exact, reported by the agent |

Because Gemini CLI runs over ACP, other ACP agents can be added the same way. See [Add more agents](#add-more-agents).

## API keys or your plan

Each agent needs a credential, added under **Settings → Keys and connections**:

- **Claude Code:** an Anthropic API key, or a Claude plan token. Create the token on your own machine with `claude setup-token` and paste it in. When a plan token is set, it is used instead of the API key.
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
| OpenCode | None needed | Runs OpenCode's free models, up to OpenCode's usage limit. Add an OpenCode key (Zen credit or the Go plan) to lift it, or an Anthropic, OpenAI or OpenRouter key for their models. |
| Antigravity | Gemini API key | Adds about 1.3 GB to the sandbox image. Google account sign-in isn't available. |
| Pi | At least one model key | Anthropic, OpenAI, Gemini or OpenRouter. |

### OpenCode's free models and its key

OpenCode needs no sign-in: its free models (the ones with "Free" in their name) run as soon as you add it. OpenCode caps how much they can be used, per account and per IP address, and the cap resets after some hours. When a turn hits it, it fails with "Free usage limit reached". A server's IP is often shared or already used up, so the free models can fail on your VM while they work on your laptop. An OpenCode key doesn't lift the free models' cap. To keep going, either:

- create a key at [opencode.ai/auth](https://opencode.ai/auth), with Zen credit or a Go subscription, paste it as **OpenCode Zen or Go key** under **Settings → Agents → OpenCode**, and pick one of OpenCode's models **without** "Free" in its name. Cloudly gives OpenCode the key the same way it gives agents every other key: the sandbox gets a placeholder that's swapped for the real key only on requests to opencode.ai. There's no `opencode auth login` to run, because sessions run in a fresh sandbox each time;
- add an Anthropic, OpenAI or OpenRouter key, and pick one of that vendor's models;
- or pick another agent.

For OpenCode, Pi and Antigravity, a key you leave empty falls back to the same key under **Keys and connections**, so you don't have to enter it twice.

Two agents in the list can't be added yet. **Muse Code** signs in only with a Meta account, so its sign-in would have to live inside the sandbox. **fx** connects directly instead of through the sandbox's proxy, and the proxy is the sandbox's only way out.

Once you add an agent, the worker installs it into the sandbox image in the background. **Settings → Sandbox tools** shows the build. Its first session can start when the build finishes. An agent whose install fails is left out; the rest of the image still builds. **Turn off** hides an agent from the pickers but keeps it installed, so turning it back on needs no download. **Remove** takes it out of the next image build.

### Updates

Agents added from Cloudly's list or the ACP registry keep themselves up to date. Every six hours (and when you press **Check for updates** under **Settings → Agents**), Cloudly compares each one with the newest release in the ACP registry. Packages the registry doesn't pin, like Pi's own `pi-coding-agent`, are compared with their latest release on npm.

When there's a newer one:

- **Auto-update on** (the default): Cloudly switches the agent to it and rebuilds the sandbox image. Turns that are running keep the version they started with; new turns use the new one once the image is built. The agent's row says what it updated from and to.
- **Auto-update off:** the row says the new version is available, with an **Update** button.
- **Test updates first** (with auto-update on): before switching, Cloudly tries the new version on up to 3 of the agent's sessions whose pull requests were merged. Each one's first message runs again from the commit it started on, once with the version installed now and once with the new one (installed in that sandbox only). The new version is installed only if it finishes as many tasks, passes the repo's checks as often, changes about the same files as what was merged, and doesn't cost much more. Otherwise the agent stays on its version, the row says why, with the comparison, and **Use it anyway** installs it. Each try is a turn per version, so it costs about six turns. Agents installed by npm or a downloaded binary can be tested; others update as usual.

If a new version doesn't install, Cloudly puts the old one back, says so on the agent's row, and doesn't try that version again; the next release is tried as usual. If the image fails to build for another reason (the setup script, say), the agent goes back to its old version for now and the new one is tried again at the next check.

Agents you added with your own command never update on their own: Cloudly doesn't know where their releases come from. Set `CLOUDLY_AGENT_UPDATE_HOURS` to change how often agents are checked, or to `0` to stop the checks. The built-in agents (Claude Code, Codex, Gemini CLI) update with Cloudly itself.

### Keys stay out of the sandbox

Added agents follow the same rule as the built-in ones. The sandbox gets a placeholder for each key. The egress proxy swaps in the real key only on HTTPS requests to that key's hosts, so a prompt-injected agent has nothing to leak. The sandbox can reach a key's hosts, plus any **Other hosts it needs** you list for the agent (sign-in pages, model lists, update checks). Everything else is blocked as usual. See [Sandbox](/docs/sandbox).

Some agents only offer a browser sign-in or a subscription login. Cloudly can't use those, because the sign-in would have to be stored inside the sandbox.

### What added agents do differently

Pi and OpenCode work like the built-in agents:

| | Pi | OpenCode |
|---|---|---|
| **Sessions** | Resumes its own session every turn, so it keeps its context and its own compaction. | The same. |
| **Cost** | Exact, from what Pi records for each reply. | Exact, from the session total OpenCode reports. |
| **Spend limit** | Counts, like any agent with a cost. | Counts. OpenCode's free models cost nothing. |
| **Effort** | Pi's thinking levels, in the chat's effort menu. | The model's variants (like high or max), in the effort menu. |
| **Context** | The ring in the chat box shows how full its context window is. | The same. |

If an agent's own session can't be resumed (its files were cleaned up, say), the turn starts a new session with the recent conversation in the prompt, so nothing is lost.

The effort menu lists the levels the agent reported on its last turn, since they depend on the model. Pick one the current model doesn't have and the turn says so and goes on at the model's level.

Other added agents:

- **Model:** the model menus, on the new-session page and in the chat, list the models the agent reported on its last turn. Before its first turn you can type a model ID. `/model <name>` is passed to the agent through ACP.
- **Effort:** the menu appears when the agent offers a thinking or effort option.
- **Sessions:** each turn starts clean with the recent conversation in its prompt, the same way Gemini CLI does.
- **Cost:** recorded when the agent reports it the way OpenCode does. Otherwise turns record no cost, and don't count toward the spend limit, unless you set prices for the agent. See [Configuration](/docs/configuration#prices).

## Choose a model

Pick one on the new-session page, next to the agent, before the session starts. Later, click the model in the chat box, or type `/model` and press **Enter**. Pick a model from the list, or type any model ID your account can use and choose **Use <ID>**.

The choice is saved on the session and applies from the next turn, so you can change it while a turn is running. It sticks for the rest of the session. On Claude Code it also overrides a model pinned in the repo's `.claude/settings.json`. Pick **Default** to go back to the agent's own default.

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
| Claude Code | Low, Medium, High, Extra high, Max | High |
| Codex | Low, Medium, High, Extra high | Medium |
| Gemini CLI | Low, High | High |

Like the model, effort is saved on the session and applies from the next turn, so you can change it while a turn runs. You can also set it on the new-session page before the first turn. **Use default** goes back to the agent's own level.

On Claude Code, Extra high and Max only exist on some models; on others Claude uses the nearest level the model has. On Gemini CLI the level applies to Gemini 3 models; Gemini 2.5 models keep their default.

## Subagents

The three built-in agents can delegate to subagents, which run in the same sandbox and show nested in the chat. An added agent's subagents show as its ordinary tool calls. See [Sessions and chat](/docs/sessions#subagents).

## Sessions across turns

Each agent keeps its own session between your messages: Claude Code and Codex resume their native sessions, and Gemini CLI gets the recent conversation replayed. Commands that depend on the session, like `/compact`, work across turns.
