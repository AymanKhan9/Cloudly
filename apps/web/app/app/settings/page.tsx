"use client";

import { Suspense, useEffect, useState } from "react";
import { api, ApiError, type Repo } from "@/lib/api";
import { useApp } from "@/components/app-context";
import { SpendBar } from "@/components/status";
import { HARNESSES, usd } from "@/lib/harness";
import { SecretsPanel } from "@/components/secrets-panel";
import { SandboxPanel } from "@/components/sandbox-panel";
import { McpPanel } from "@/components/mcp-panel";
import { EnvPanel } from "@/components/env-panel";
import { FilesPanel } from "@/components/files-panel";

// A repo's kept files (/files in its runs), picked from the installation's repos.
function RepoFilesSection() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repo, setRepo] = useState("");
  useEffect(() => {
    api<{ repos: Repo[] }>("/repos")
      .then((r) => {
        setRepos(r.repos);
        setRepo(r.repos[0]?.fullName ?? "");
      })
      .catch(() => setRepos([]));
  }, []);
  return (
    <section className="set-sec" aria-labelledby="files-h" id="files">
      <header>
        <h2 id="files-h">Repo files</h2>
        <p>Files a repo&apos;s sessions find at /files: data, fixtures, a local config. They aren&apos;t committed, and what the agent saves there is kept for the next session.</p>
      </header>
      <div className="set-body">
        <div className="panel">
          <div className="panel-row field">
            <label className="label" htmlFor="files-repo">
              Repository
            </label>
            <select id="files-repo" className="select" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={!repos?.length} style={{ maxWidth: 360 }}>
              {(repos ?? []).map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </div>
          <div className="panel-row">{repo ? <FilesPanel repo={repo} /> : <p className="hint">{repos ? "No repositories yet." : "Loading"}</p>}</div>
        </div>
      </div>
    </section>
  );
}

const STATE_TEXT = { fair: "Runs start normally", change: "Warning sent", storm: "New runs blocked" };

export default function SettingsPage() {
  const { budget, refreshBudget } = useApp();
  const [limit, setLimit] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (budget && !seeded) {
      setLimit(budget.limitUsd !== null ? String(budget.limitUsd) : "10");
      setEmail(budget.alertEmail ?? "");
      setSeeded(true);
    }
  }, [budget, seeded]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await api("/budget", {
        method: "PUT",
        body: JSON.stringify({ monthlyLimitUsd: Number(limit), alertEmail: email.trim() || null }),
      });
      await refreshBudget();
      setMessage({ ok: true, text: "Saved. Both alerts are re-armed for this month." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Couldn't save." });
    } finally {
      setSaving(false);
    }
  }

  const state = budget?.limitUsd ? budget.state : "fair";

  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1>
        <p>Spend limit, keys, MCP servers, secrets, files and sandbox tools for this instance.</p>
      </div>

      <section className="set-sec" aria-labelledby="spend-h">
        <header>
          <h2 id="spend-h">Spend limit</h2>
          <p>Model spend only. Your VM is billed by your cloud provider. Months reset on the 1st (UTC).</p>
        </header>
        <div className="set-body">
          <div className="panel">
            <div className="panel-row">
              {budget ? (
                <>
                  <div className="usage-read">
                    <span className="big num">{usd(budget.spentUsd)}</span>
                    <span className="of">{budget.limitUsd ? `of ${usd(budget.limitUsd)} this month` : "this month, no limit set"}</span>
                    {budget.limitUsd ? (
                      <span className="usage-state" data-state={state}>
                        {Math.round(budget.ratio * 100)}%, {STATE_TEXT[state].toLowerCase()}
                      </span>
                    ) : null}
                  </div>
                  {budget.limitUsd ? (
                    <div style={{ marginTop: 16 }}>
                      <SpendBar ratio={budget.ratio} state={state} large />
                      <div className="usage-scale">
                        <span>$0</span>
                        <span>Warning at 80%, stop at 100%</span>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="skeleton" style={{ width: "40%", height: 30 }} />
              )}
            </div>
            <form className="panel-row" onSubmit={save} style={{ display: "grid", gap: 18 }}>
              <div className="field">
                <label className="label" htmlFor="limit">
                  Monthly limit
                </label>
                <div className="input-prefix">
                  <span>$</span>
                  <input id="limit" type="number" min={0} step="0.5" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} required className="num" />
                </div>
                <p className="hint">
                  At 80% you get a banner and one email. At 100% new runs are refused. A turn that&apos;s already running
                  finishes first; Claude Agent stops itself at 25% over, and Codex and Gemini can go over by that one turn.
                </p>
              </div>
              <div className="field">
                <label className="label" htmlFor="email">
                  Alert email
                </label>
                <input id="email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" style={{ maxWidth: 360 }} />
                <p className="hint">Sent through Resend when its key is set below. Leave empty for in-app alerts only.</p>
              </div>
              <div className="form-foot">
                <span className="msg" role="status" data-tone={message ? (message.ok ? "ok" : "danger") : undefined}>
                  {message?.text ?? ""}
                </span>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? "Saving" : "Save limit"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </section>

      <SecretsPanel />

      <Suspense fallback={null}>
        <McpPanel />
      </Suspense>

      <EnvPanel />

      <RepoFilesSection />

      <SandboxPanel />

      <section className="set-sec" aria-labelledby="agents-h">
        <header>
          <h2 id="agents-h">Agents</h2>
          <p>An agent runs only if its key or plan sign-in is set above. Turns on a plan don&apos;t count toward the limit.</p>
        </header>
        <div className="set-body">
          <div className="panel">
            <table className="agents-table">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col" className="hide-sm">
                    ID
                  </th>
                  <th scope="col">Cost reporting</th>
                </tr>
              </thead>
              <tbody>
                {HARNESSES.map((h) => (
                  <tr key={h.id}>
                    <td>{h.name}</td>
                    <td className="mono hide-sm">{h.id}</td>
                    <td>{h.cost === "exact" ? "Exact, from the agent" : "Estimated from tokens"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
