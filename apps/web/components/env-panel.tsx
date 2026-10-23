"use client";

import { useEffect, useState } from "react";
import { Check, LockSimple, Trash, Eye } from "@phosphor-icons/react";
import { api, ApiError, type EnvSecretRow, type Repo } from "@/lib/api";

function hostsLabel(hosts: string) {
  const list = hosts.split("\n").filter(Boolean);
  return list.length ? list.join(", ") : "nowhere";
}

export function EnvPanel() {
  const [secrets, setSecrets] = useState<EnvSecretRow[] | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [hosts, setHosts] = useState("");
  const [repo, setRepo] = useState("*");
  const [exposed, setExposed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ secrets: EnvSecretRow[] }>("/settings/env").then((r) => setSecrets(r.secrets)).catch(() => setSecrets([]));
    api<{ repos: Repo[] }>("/repos").then((r) => setRepos(r.repos)).catch(() => {});
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ secrets: EnvSecretRow[] }>("/settings/env", {
        method: "PUT",
        body: JSON.stringify({ name: name.trim(), repo, value: value || undefined, hosts, exposed }),
      });
      setSecrets(r.secrets);
      setName("");
      setValue("");
      setHosts("");
      setExposed(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const r = await api<{ secrets: EnvSecretRow[] }>(`/settings/env/${id}`, { method: "DELETE" }).catch(() => null);
    if (r) setSecrets(r.secrets);
  }

  // Editing: fill the form with the row; the value stays as it is unless a new one is typed.
  function edit(s: EnvSecretRow) {
    setName(s.name);
    setRepo(s.repo);
    setHosts(s.hosts);
    setExposed(s.exposed);
    setValue("");
  }

  const existing = secrets?.find((s) => s.name === name.trim() && s.repo === repo);

  return (
    <section className="set-sec" aria-labelledby="env-h" id="secrets">
      <header>
        <h2 id="env-h">Secrets for runs</h2>
        <p>
          Environment variables for the repo&apos;s own scripts and tests. The agent gets a placeholder; the egress proxy puts the real value in only on HTTPS requests to the hosts you name, so the agent never holds it.
        </p>
      </header>
      <div className="set-body">
        <div className="panel">
          {secrets === null ? (
            <div className="panel-row" aria-busy="true">
              <div className="skeleton" style={{ width: "50%" }} />
            </div>
          ) : secrets.length === 0 ? (
            <div className="panel-row hint">None yet.</div>
          ) : (
            secrets.map((s) => (
              <div key={s.id} className="secret">
                <div>
                  <div className="name mono">{s.name}</div>
                  <div className="state" data-set>
                    {s.exposed ? <Eye size={13} weight="bold" /> : <LockSimple size={13} weight="bold" />}
                    {s.exposed ? "Real value in the sandbox" : `Filled in for ${hostsLabel(s.hosts)}`}
                    {s.preview ? ` (${s.preview})` : ""}
                  </div>
                  <div className="hint">{s.repo === "*" ? "Every repository" : s.repo}</div>
                </div>
                <div className="mcp-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => edit(s)}>
                    Edit
                  </button>
                  <button type="button" className="icon-btn" onClick={() => remove(s.id)} aria-label={`Remove ${s.name}`} title="Remove">
                    <Trash size={16} />
                  </button>
                </div>
              </div>
            ))
          )}
          <form className="panel-row mcp-add" onSubmit={save}>
            <div className="mcp-add-grid">
              <div className="field">
                <label className="label" htmlFor="env-name">
                  Name
                </label>
                <input
                  id="env-name"
                  className="input mono"
                  value={name}
                  onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                  placeholder="STRIPE_API_KEY"
                  maxLength={64}
                  required
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="env-value">
                  Value
                </label>
                <input
                  id="env-value"
                  className="input mono"
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={existing ? "Leave empty to keep the current value" : ""}
                  autoComplete="off"
                  required={!existing}
                />
              </div>
            </div>
            <div className="mcp-add-grid">
              <div className="field">
                <label className="label" htmlFor="env-repo">
                  For
                </label>
                <select id="env-repo" className="select" value={repo} onChange={(e) => setRepo(e.target.value)}>
                  <option value="*">Every repository</option>
                  {repos.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor="env-hosts">
                  May be sent to
                </label>
                <input id="env-hosts" className="input mono" value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="api.stripe.com" disabled={exposed} />
              </div>
            </div>
            <label className="chip" style={{ justifySelf: "start" }}>
              <input type="checkbox" checked={exposed} onChange={(e) => setExposed(e.target.checked)} />
              <span className="box">
                <Check size={11} weight="bold" />
              </span>
              Put the real value in the sandbox instead
            </label>
            <p className="hint">
              {exposed
                ? "For values that aren't sensitive, or that a local tool reads directly (a test database password). The agent can read these."
                : "Hosts are comma or space separated, subdomains included. Requests to them go through Cloudly's proxy with the value filled into headers and the URL; request bodies aren't changed."}
            </p>
            <div className="form-foot">
              <span className="msg" role="status" data-tone={error ? "danger" : undefined}>
                {error ?? "Applies from the next turn."}
              </span>
              <button type="submit" className="btn btn-primary" disabled={busy || !name}>
                {existing ? "Update" : "Add secret"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}
