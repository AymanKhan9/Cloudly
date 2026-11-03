# Artifacts and screenshots

Some answers are better seen than read: a chart of the numbers, a diagram of the flow, a report, a screenshot of the page that changed. Cloudly shows them in the conversation, from any agent.

## In the agent's replies

Replies render as GitHub-style Markdown: tables, task lists, highlighted code with a copy button, [Mermaid](https://mermaid.js.org) diagrams in a ` ```mermaid ` block, and math between `$$` signs. Raw HTML isn't rendered, and images in a reply only load from Cloudly itself, so a reply can't make your browser fetch an address of the agent's choosing.

## Artifacts

Every agent is told about `/artifacts`: a folder whose files show up in the turn that wrote them. Ask for "a chart of…", "a diagram of…" or "a report on…", and the agent puts it there.

| File | Shown as |
|---|---|
| `.html` | The page, running in a sandboxed frame |
| `.svg`, `.png`, `.jpg`, `.gif`, `.webp` | The image |
| `.md` | The document; its images can be other artifacts (`![](chart.png)`) |
| `.mmd` | A Mermaid diagram |
| `.csv`, `.tsv` | A chart (dates or numbers along the bottom make lines; names make columns) and a sortable table |
| `.pdf` | The PDF |
| `.txt`, `.json` | The text |

Each file is kept by name for the session. Writing the same name again in a later turn makes a new version: every card has a version picker, so you can go back to what a chart looked like two turns ago. The agent finds the latest version of each in `/artifacts` at the start of every turn, to change rather than start over. Artifacts aren't committed to the repo.

Every card can go full screen, download, or **share**: a link that shows that one version to anyone who has it, without signing in, until you turn it off. At most 20 new versions a turn, 10 MB each and 25 MB in all.

**HTML is sandboxed.** It runs in a frame with an origin of its own, so it can't see Cloudly, your session or your cookies. A policy at the top of the page lets it load scripts and styles only from cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com and Google Fonts, and makes no other requests: no fetch, no forms, no images from the web. Charts with Chart.js, D3 or Plotly from a CDN work; a page that calls an API doesn't.

## Before-and-after screenshots

Turn them on per repo under **Settings > Checks > Screenshots**, with the command that starts the app, its port, and up to six pages. After a turn that changes UI files (components, styles, templates, static assets), Cloudly:

1. starts the app at the turn's commit and screenshots each page in headless Chromium, 1280 × 800;
2. does the same at the commit before the turn;
3. shows each page's pair side by side in the session, with Before and After to flick between;
4. adds a **Screenshots** section to the pull request's description, which it keeps up to date as later turns change the UI.

It runs as a turn of its own after the change, like the checks: in a container on the session's branch, with the repo's secrets as placeholders, reaching the network through Cloudly's egress proxy. It uses no model, so it costs nothing. It needs Chromium, which comes with the sandbox's desktop tools (Settings > Sandbox tools). The images in the pull request are share links, so they show on GitHub only if your Cloudly is reachable from the internet (`WEB_ORIGIN`).
