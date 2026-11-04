"use client";

import { useEffect, useState } from "react";
import { Copy, Check } from "@phosphor-icons/react";
import { api, ApiError, type Repo, type RepoCheckSettings, type WebhookStatus } from "@/lib/api";
import { relativeTime, HARNESSES, type Harness } from "@/lib/harness";

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <code className="mono" aria-label={label}>
        {value}
      </code>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={async () => {
          await navigator.clipboard.writeText(value).catch(() => {});
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Where GitHub sends its webhooks, the secret, and what arrived lately. */
function WebhookSetup() {
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api<WebhookStatus>("/settings/webhooks").then(setStatus).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function newSecret() {
    if (status?.secretSet && !window.confirm("Replace the webhook secret? GitHub's deliveries fail until you paste the new one into the app's settings.")) return;
    try {
      const r = await api<{ secret: string }>("/settings/webhooks/secret", { method: "POST" });
      setSecret(r.secret);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't make a secret.");
    }
  }

  if (!status) return error ? <p className="hint" role="alert">{error}</p> : <div className="skeleton" style={{ width: "40%" }} />;
  const appSettings = status.appSlug ? `https://github.com/settings/apps/${status.appSlug}` : "https://github.com/settings/apps";
  const working = status.deliveries.length > 0;

  return (
    <div className="panel">
      <div className="panel-row field">
        <span className="label">Webhook</span>
        <p className="hint">
          {working
            ? "GitHub is sending events. The latest are below."
            : status.secretSet
              ? "Set up, but nothing has arrived yet. Check the GitHub App's webhook settings, below."
              : "Not set up yet. A GitHub App made before this version of Cloudly needs it added once."}
        </p>
        <CopyField value={status.url} label="Webhook URL" />
      </div>
      {secret ? (
        <div className="panel-row field">
          <span className="label">Secret</span>
          <CopyField value={secret} label="Webhook secret" />
          <p className="hint">Shown once. Paste it into the GitHub App now.</p>
        </div>
      ) : null}
      {!working ? (
        <div className="panel-row field">
          <span className="label">In the GitHub App&apos;s settings</span>
          <ol className="howto">
            <li>
              Open{" "}
              <a href={appSettings} target="_blank" rel="noreferrer">
                the app&apos;s settings
              </a>{" "}
              (an organization&apos;s apps are under the organization&apos;s settings).
            </li>
            <li>
              Under <b>Webhook</b>, tick <b>Active</b>, paste the URL above, and the secret {status.secretSet && !secret ? "you saved (or make a new one)" : "from the button below"}.
            </li>
            <li>
              Under <b>Permissions</b>, give it <b>Issues: read and write</b>, <b>Checks: read</b>, <b>Actions: read</b> and <b>Commit statuses: read</b>.
            </li>
            <li>
              Under <b>Subscribe to events</b>, tick <b>Issues</b>, <b>Issue comment</b>, <b>Pull request review</b> and <b>Check suite</b>. Save.
            </li>
            <li>GitHub then asks whoever installed the app to accept the new permissions. Until they do, nothing arrives.</li>
          </ol>
          <p className="hint">GitHub has to be able to reach this server, so this needs Cloudly on a public address.</p>
        </div>
      ) : null}
      {working ? (
        <div className="panel-row field">
          <span className="label">Recent events</span>
          <ul className="deliveries">
            {status.deliveries.map((d) => (
              <li key={d.id} data-status={d.status}>
                <span className="mono">
                  {d.event}
                  {d.action ? `.${d.action}` : ""}
                </span>
                <span className="dim">{d.note ?? d.status}</span>
                <span className="dim num">{relativeTime(d.receivedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="panel-row form-foot">
        <span className="msg" role="status" data-tone={error ? "danger" : undefined}>
          {error ?? "Only people on this Cloudly's sign-in list can start anything from GitHub. Bots never can."}
        </span>
        <button type="button" className="btn btn-secondary" onClick={newSecret}>
          {status.secretSet ? "New secret" : "Make a secret"}
        </button>
      </div>
    </div>
  );
}

/** Which GitHub events start work on a repo, and with which agent. */
function RepoTriggers() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repo, setRepo] = useState("");
  const [agents, setAgents] = useState<Harness[]>(HARNESSES);
  const [s, setS] = useState<RepoCheckSettings["settings"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ repos: Repo[] }>("/repos")
      .then((r) => {
        setRepos(r.repos);
        setRepo(r.repos[0]?.fullName ?? "");
      })
      .catch(() => setRepos([]));
    api<{ harnesses: Harness[] }>("/harnesses")
      .then((r) => r.harnesses.length && setAgents(r.harnesses))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!repo) return;
    setS(null);
    setMessage(null);
    api<RepoCheckSettings>(`/settings/repos/${repo}`)
      .then((v) => setS(v.settings))
      .catch((e: Error) => setMessage({ ok: false, text: e.message }));
  }, [repo]);

  const set = <K extends keyof RepoCheckSettings["settings"]>(k: K, v: RepoCheckSettings["settings"][K]) => setS((cur) => (cur ? { ...cur, [k]: v } : cur));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/settings/repos/${repo}`, {
        method: "PUT",
        body: JSON.stringify({
          triggerHarness: s.triggerHarness, issueLabel: s.issueLabel.trim() || "cloudly", onIssueLabel: s.onIssueLabel,
          onMention: s.onMention, onPrReview: s.onPrReview, fixCi: s.fixCi, ciFixAttempts: s.ciFixAttempts,
        }),
      });
      setMessage({ ok: true, text: "Saved." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Couldn't save." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={save}>
      <div className="panel-row checks-grid">
        <div className="field">
          <label className="label" htmlFor="triggers-repo">
            Repository
          </label>
          <select id="triggers-repo" className="select" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={!repos?.length}>
            {(repos ?? []).map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {r.fullName}
              </option>
            ))}
          </select>
        </div>
        {s ? (
          <div className="field">
            <label className="label" htmlFor="triggers-agent">
              Agent for new sessions
            </label>
            <select id="triggers-agent" className="select" value={s.triggerHarness ?? "native-claude"} onChange={(e) => set("triggerHarness", e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      {s ? (
        <>
          <div className="panel-row trigger-list">
            <label className="check-row">
              <input type="checkbox" checked={s.onIssueLabel} onChange={(e) => set("onIssueLabel", e.target.checked)} />
              <span>
                <b>Labelled issues.</b> Adding the label{" "}
                <input
                  className="input mono inline-input"
                  value={s.issueLabel}
                  onChange={(e) => set("issueLabel", e.target.value)}
                  maxLength={50}
                  aria-label="Label"
                  disabled={!s.onIssueLabel}
                />{" "}
                to an issue starts a session for it. Its pull request closes the issue.
              </span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={s.onMention} onChange={(e) => set("onMention", e.target.checked)} />
              <span>
                <b>
                  <code className="mono">@cloudly</code> in comments.
                </b>{" "}
                On an issue, starts or continues its session. On a pull request, continues Cloudly&apos;s session, or works on that pull request&apos;s branch.
              </span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={s.onPrReview} onChange={(e) => set("onPrReview", e.target.checked)} />
              <span>
                <b>Reviews on Cloudly&apos;s pull requests.</b> A review, with its line comments, becomes the session&apos;s next turn.
              </span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={s.fixCi} onChange={(e) => set("fixCi", e.target.checked)} />
              <span>
                <b>Failing CI on Cloudly&apos;s pull requests.</b> The agent gets the failing checks and their logs, and{" "}
                <select className="select inline-select" value={s.ciFixAttempts} onChange={(e) => set("ciFixAttempts", Number(e.target.value))} disabled={!s.fixCi} aria-label="CI fix attempts">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>{" "}
                {s.ciFixAttempts === 1 ? "try" : "tries"} to fix them before the session asks you.
              </span>
            </label>
          </div>
          <div className="panel-row form-foot">
            <span className="msg" role="status" data-tone={message && !message.ok ? "danger" : undefined}>
              {message?.text ?? "Turns started from GitHub count against your spend limit like any other."}
            </span>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Save
            </button>
          </div>
        </>
      ) : repo ? (
        <div className="panel-row" aria-busy="true">
          <div className="skeleton" style={{ width: "40%" }} />
        </div>
      ) : null}
    </form>
  );
}

export function GitHubTriggers() {
  return (
    <section className="set-sec" aria-labelledby="triggers-h" id="triggers">
      <header>
        <h2 id="triggers-h">GitHub triggers</h2>
        <p>
          Start work from GitHub: label an issue, mention <code className="mono">@cloudly</code> in a comment, review one of Cloudly&apos;s pull requests, or let it fix its own failing CI.
        </p>
      </header>
      <div className="set-body">
        <WebhookSetup />
        <RepoTriggers />
      </div>
    </section>
  );
}
