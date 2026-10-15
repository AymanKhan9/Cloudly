# Spend limit

Set a monthly limit on model spend in **Settings → Spend limit**. It covers model usage on your API keys only; your VM is billed by your cloud provider, and turns on a Claude or ChatGPT plan don't count.

## What happens as you spend

| Spent | What happens |
|---|---|
| Under 80% | Nothing interrupts you. Each turn's cost is recorded when the agent reports it. |
| 80% | A banner in the app and one email for the month. Turns keep running. |
| 100% | New turns are refused until you raise the limit or the month ends. |

A turn that is already running when you reach 100% finishes, so a task isn't left half done. Claude Agent turns stop themselves at 25% over the limit and keep the work they finished on the branch. Codex and Gemini can go over by that one turn.

Months follow UTC, and both alerts re-arm when you save a new limit.

## Exact and estimated costs

- **Claude Agent** reports the exact cost of every turn.
- **Codex** and **Gemini CLI** report tokens. Cloudly prices them from a table you control and marks the result as an estimate, shown with a `~`.

Set your own prices, in US dollars per million tokens, in the [configuration](/docs/configuration#prices):

```sh
PRICE_CODEX_INPUT_PER_MTOK=1.25
PRICE_CODEX_OUTPUT_PER_MTOK=10
PRICE_GEMINI_INPUT_PER_MTOK=0.30
PRICE_GEMINI_OUTPUT_PER_MTOK=2.50
```

## Email alerts

Alerts are in-app by default. To also get email, add a Resend API key under **Settings → Keys and connections** and an alert address under **Settings → Spend limit**. Set the sender with `ALERT_FROM` in the configuration. SMTP isn't supported yet.
