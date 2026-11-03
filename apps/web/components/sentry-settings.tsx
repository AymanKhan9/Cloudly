"use client";

import { useEffect, useState } from "react";
import { Trash } from "@phosphor-icons/react";
import { api, ApiError, type Repo } from "@/lib/api";
import { relativeTime, type Harness } from "@/lib/harness";
import { useApp } from "./app-context";
import { CopyText } from "./discord-settings";

interface SentryProject {
  id: string;
  slug: string;
  repo: string;
  harness: string | null;
  enabled: boolean;
  perDay: number;
}
interface SentryStatus {
  webhookUrl: string;
  secretSet: boolean;
  tokenSet: boolean;
  sentryUrl: string;
  projects: SentryProject[];
  deliveries: { id: string; event: string; action: string | null; status: string; note: string | null; receivedAt: string }[];
}

/** Sentry: new production errors start sessions that reproduce and fix them. */
export function SentrySettings() {
  const { harnesses } = useApp();
  const [s, setS] = useState<SentryStatus | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [url, setUrl] = useState("");
  const [slug, setSlug] = useState("");
  const [repo, setRepo] = useState("");
  const [agent, setAgent] = useState("");
  const [perDay, setPerDay] = useState(5);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<SentryStatus>("/settings/sentry")
      .then((v) => {
        setS(v);
        setUrl(v.sentryUrl);
      })
      .catch((e: Error) => setMessage({ ok: false, text: e.message }));
  useEffect(() => {
    load();
    api<{ repos: Repo[] }>("/repos").then((r) => setRepos(r.repos)).catch(() => {});
  }, []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text: ok });
      await load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Something went wrong." });
    } finally {
      setBusy(false);
    }
  };
  const name = (id: string | null) => (id ? harnesses.find((h: Harness) => h.id === id)?.name ?? id : "The repo's trigger agent");

  return (
    <section className="set-sec" aria-labelledby="sentry-h" id="sentry">
      <header>
        <h2 id="sentry-h">Sentry</h2>
        <p>
          A new error in production starts a session: the agent finds the cause, writes a test that fails the same way, and fixes it, with your checks, review and pull request as
          usual. Each error starts one session, and each project at most a few a day.
        </p>
      </header>
      <div className="set-body">
        {s ? (
          <div className="panel">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(
                  () =>
                    api("/settings/sentry", {
                      method: "PUT",
                      body: JSON.stringify({
                        clientSecret: secret.trim() || undefined,
                        authToken: token.trim() || undefined,
                        sentryUrl: url.trim() && url.trim() !== s.sentryUrl ? url.trim() : undefined,
                      }),
                    }).then(() => {
                      setSecret("");
                      setToken("");
                    }),
                  "Saved.",
                );
              }}
            >
              <div className="panel-row field">
                <span className="label">1. Make an internal integration in Sentry</span>
                <p className="hint">
                  In Sentry: Settings &gt; Developer Settings &gt; Custom Integrations &gt; Create New Integration &gt; Internal Integration. Set its Webhook URL to this, turn on
                  Alert Rule Action, tick <b>issue</b> under Webhooks, and give it Read access to Issue &amp; Event.
                </p>
                <CopyText value={s.webhookUrl} label="Webhook URL" />
              </div>
              <div className="panel-row checks-grid">
                <div className="field">
                  <label className="label" htmlFor="se-secret">
                    2. Its client secret {s.secretSet ? <span className="dim">(saved)</span> : null}
                  </label>
                  <input id="se-secret" className="input mono" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={s.secretSet ? "Leave empty to keep it" : ""} />
                  <p className="hint">Checks that each webhook really came from Sentry.</p>
                </div>
                <div className="field">
                  <label className="label" htmlFor="se-token">
                    Its token <span className="dim">(optional){s.tokenSet ? ", saved" : ""}</span>
                  </label>
                  <input id="se-token" className="input mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s.tokenSet ? "Leave empty to keep it" : ""} />
                  <p className="hint">Lets Cloudly read the stack trace, which the issue webhook leaves out.</p>
                </div>
              </div>
              <div className="panel-row field">
                <label className="label" htmlFor="se-url">
                  Sentry address
                </label>
                <input id="se-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} style={{ maxWidth: 360 }} />
                <p className="hint">sentry.io, or your own Sentry&apos;s address.</p>
              </div>
              <div className="panel-row form-foot">
                <span className="msg" role="status" data-tone={message && !message.ok ? "danger" : undefined}>
                  {message?.text ?? (s.secretSet ? "Connected." : "Not connected yet.")}
                </span>
                <button type="submit" className="btn btn-primary" disabled={busy || (!secret.trim() && !token.trim() && url.trim() === s.sentryUrl)}>
                  Save
                </button>
              </div>
            </form>

            <div className="panel-row field">
              <span className="label">3. Which repo each Sentry project&apos;s errors go to</span>
              {s.projects.length ? (
                <ul className="file-list">
                  {s.projects.map((p) => (
                    <li key={p.id}>
                      <span className="mono">{p.slug}</span>
                      <span className="dim">
                        → {p.repo} · {name(p.harness)} · up to {p.perDay} a day
                      </span>
                      <label className="check-row" style={{ marginLeft: "auto" }}>
                        <input
                          type="checkbox"
                          checked={p.enabled}
                          onChange={(e) => run(() => api(`/settings/sentry/projects/${p.id}`, { method: "PATCH", body: JSON.stringify({ enabled: e.target.checked }) }), e.target.checked ? "On." : "Paused.")}
                        />
                        On
                      </label>
                      <button type="button" className="icon-btn" aria-label={`Remove ${p.slug}`} onClick={() => run(() => api(`/settings/sentry/projects/${p.id}`, { method: "DELETE" }), "Removed.")}>
                        <Trash size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">None yet.</p>
              )}
              <form
                className="sentry-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(
                    () =>
                      api("/settings/sentry/projects", { method: "POST", body: JSON.stringify({ slug: slug.trim(), repo, harness: agent || null, perDay }) }).then(() => setSlug("")),
                    "Added. Its next new error starts a session.",
                  );
                }}
              >
                <input className="input mono" aria-label="Sentry project slug" placeholder="sentry-project-slug" value={slug} onChange={(e) => setSlug(e.target.value)} required />
                <select className="select" aria-label="Repository" value={repo} onChange={(e) => setRepo(e.target.value)} required>
                  <option value="" disabled>
                    Repository
                  </option>
                  {repos.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}
                    </option>
                  ))}
                </select>
                <select className="select" aria-label="Agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
                  <option value="">The repo&apos;s trigger agent</option>
                  {harnesses.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
                <select className="select" aria-label="Sessions a day" value={perDay} onChange={(e) => setPerDay(Number(e.target.value))}>
                  {[1, 3, 5, 10, 20].map((n) => (
                    <option key={n} value={n}>
                      Up to {n} a day
                    </option>
                  ))}
                </select>
                <button type="submit" className="btn btn-secondary" disabled={busy || !slug.trim() || !repo}>
                  Add
                </button>
              </form>
            </div>

            {s.deliveries.length ? (
              <div className="panel-row field">
                <span className="label">What Sentry sent lately</span>
                <ul className="file-list">
                  {s.deliveries.map((d) => (
                    <li key={d.id}>
                      <span className="mono">{d.event.replace(/^sentry\./, "")}{d.action ? `.${d.action}` : ""}</span>
                      <span className="dim">
                        {d.status}
                        {d.note ? `: ${d.note}` : ""} · {relativeTime(d.receivedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="skeleton" style={{ height: 120 }} aria-busy="true" />
        )}
      </div>
    </section>
  );
}
