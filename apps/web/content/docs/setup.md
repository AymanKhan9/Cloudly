# First-run setup

After the installer finishes, open `<your public URL>/setup` and paste the setup token it printed. The token is also saved as `CLOUDLY_SETUP_TOKEN` in `/opt/cloudly/.env`.

Setup has three steps. Nothing on the page leaves your server except the calls to GitHub.

## 1. Choose who can sign in

Enter your GitHub username. To share the instance, list several, separated by commas. Only these accounts can ever sign in.

## 2. Create the GitHub App

One click opens GitHub with a pre-filled form asking for **contents** and **pull requests**, read and write. Confirm it, and GitHub sends you back. Cloudly stores the app's credentials encrypted; there is nothing to copy by hand.

The app belongs to your GitHub account (or an organization, if you enter one), and only this instance uses it.

## 3. Choose repositories

GitHub shows which repositories the app may work on, private ones included. You can change this any time on GitHub.

Once all three steps are done, setup closes itself so nobody else can claim the instance. Later changes go through **Settings**.

## Save your recovery key

The installer prints a recovery key, and setup can show it again. Store it in a password manager. If you ever reinstall Cloudly on the same database, setup asks for it so your keys and settings carry over. See [Upgrades and troubleshooting](/docs/upgrading#move-to-a-new-vm).

## Add a model key or plan

Sign in with GitHub, open **Settings**, and under **Keys and connections** add at least one of:

| Setting | Used by |
|---|---|
| Anthropic API key | Claude Agent |
| Claude plan token (from `claude setup-token`) | Claude Agent, on your Claude plan instead of the API key |
| OpenAI API key | Codex |
| ChatGPT plan sign-in (the contents of `~/.codex/auth.json`) | Codex, on your ChatGPT plan instead of the API key |
| Gemini API key | Gemini CLI |

Keys are stored encrypted on the server and are never shown again after saving. See [Agents and models](/docs/agents) for how each one is used.

Then go to the home page and [start a session](/docs/sessions).
