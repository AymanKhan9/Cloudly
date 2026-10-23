# Secrets and files

Agents in the cloud only see the repository. These two features cover what usually lives next to it on your own machine: the tokens your tests or scripts need, and files that aren't in git.

## Secrets for runs

Add them in **Settings → Secrets for runs**: a name, a value, which repositories get it, and the hosts the value may be sent to.

```text
Name           STRIPE_API_KEY
May be sent to api.stripe.com
```

The agent's sandbox gets `STRIPE_API_KEY` set to a placeholder such as `cloudly-secret-3f9a…`, never the value. When a request leaves the sandbox for `api.stripe.com` (or a subdomain), Cloudly's egress proxy opens it, swaps the placeholder for the real value in the headers and the URL, and sends it on. Requests anywhere else keep the placeholder. So code like this just works:

```sh
curl https://api.stripe.com/v1/charges -u "$STRIPE_API_KEY:"
```

To do that, the proxy terminates TLS for those hosts with a certificate from Cloudly's own CA, which run containers trust. Other hosts are tunnelled untouched, as before.

What to know:

- **Headers and URL only.** A placeholder inside a request body is not replaced.
- **HTTPS only**, like everything leaving the sandbox.
- A repository's own secret wins over an instance-wide one with the same name.
- Names Cloudly or the sandbox use themselves (`PATH`, `HTTPS_PROXY`, `NODE_OPTIONS`, `ANTHROPIC_*` and similar) can't be set.
- The browser inside a [desktop](/docs/desktop-and-previews) doesn't trust Cloudly's CA, so pages it loads from a secret's host show a certificate error.

### Real values in the sandbox

For values that aren't sensitive, or that a tool reads directly (the password of a database the tests start inside the sandbox), tick **Put the real value in the sandbox instead**. The agent can read these, so don't use it for anything you wouldn't hand the agent.

## Repo files

Every run has a folder at `/files` that belongs to the repository, not to git. Use it for data, fixtures, a local config or a large sample file:

- **Add files** in **Settings → Repo files**, or with the **Files** button in a session. Drag them in or click **Upload**.
- **The agent can read them** at `/files/<name>`. Mention them in your message, like "use the orders in /files/fixtures/orders.csv".
- **What the agent leaves there is kept.** After each turn, Cloudly saves new and changed files and drops ones the agent deleted, so notes or results carry over to the next session on that repo.
- **They're never committed.** `/files` is outside the repository.

Up to 25 MB a file and 200 MB a repository. Files are stored in your database. Downloading one always saves it as a file, even if it's HTML, so a file an agent wrote can't run in your browser.
