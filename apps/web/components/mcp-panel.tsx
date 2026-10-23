"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CaretRight, CheckCircle, Circle, Plugs, Trash, WarningCircle } from "@phosphor-icons/react";
import { api, ApiError, type McpServerRow } from "@/lib/api";

const STATE: Record<McpServerRow["status"], string> = {
  connected: "Connected",
  needs_auth: "Needs sign-in",
  error: "Sign-in failed",
};

function Row({ server, onChange }: { server: McpServerRow; onChange: () => void }) {
  const [busy, setBusy] = useState(false);

  async function act(init: RequestInit) {
    setBusy(true);
    await api(`/settings/mcp/${server.id}`, init).catch(() => {});
    setBusy(false);
    onChange();
  }

  const Icon = server.status === "connected" ? CheckCircle : server.status === "error" ? WarningCircle : Circle;
  const signIn = server.auth === "oauth";

  return (
    <div className="secret mcp-row">
      <div>
        <div className="name">
          <span className="mono">{server.name}</span>
          {!server.enabled ? <span className="dim"> (off)</span> : null}
        </div>
        <div className="hint mono mcp-url" title={server.url}>
          {server.url}
        </div>
        <div className="state" role="status" data-set={server.status === "connected" || undefined} data-locked={server.status === "error" || undefined}>
          <Icon size={13} weight="bold" />
          {STATE[server.status]}
          {server.auth === "bearer" ? ", with a token" : server.auth === "none" ? ", no sign-in needed" : ""}
        </div>
        {server.error ? <p className="hint mcp-error">{server.error}</p> : null}
      </div>
      <div className="mcp-actions">
        {signIn ? (
          // A navigation, not a fetch: the server's sign-in page takes over the tab and comes back here.
          <a className={`btn ${server.status === "connected" ? "btn-secondary" : "btn-primary"}`} href={`/api/settings/mcp/${server.id}/connect`}>
            {server.status === "connected" ? "Reconnect" : "Connect"}
          </a>
        ) : null}
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act({ method: "PATCH", body: JSON.stringify({ enabled: !server.enabled }) })}>
          {server.enabled ? "Turn off" : "Turn on"}
        </button>
        <button type="button" className="icon-btn" disabled={busy} onClick={() => act({ method: "DELETE" })} aria-label={`Remove ${server.name}`} title="Remove">
          <Trash size={16} />
        </button>
      </div>
    </div>
  );
}

function AddServer({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<McpServerRow["auth"]>("oauth");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>("/settings/mcp", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), url: url.trim(), auth, token: token || undefined, clientId: clientId || undefined, clientSecret: clientSecret || undefined }),
      });
      if (auth === "oauth") {
        window.location.assign(`/api/settings/mcp/${id}/connect`);
        return;
      }
      setName("");
      setUrl("");
      setToken("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel-row mcp-add" onSubmit={add}>
      <div className="mcp-add-grid">
        <div className="field">
          <label className="label" htmlFor="mcp-name">
            Name
          </label>
          <input
            id="mcp-name"
            className="input mono"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            placeholder="linear"
            maxLength={32}
            required
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="mcp-url">
            Server URL
          </label>
          <input id="mcp-url" className="input mono" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.linear.app/mcp" required />
        </div>
      </div>
      <div className="field">
        <span className="label">Sign-in</span>
        <div className="segmented" role="group" aria-label="How the server signs in">
          {(
            [
              ["oauth", "OAuth"],
              ["bearer", "Token"],
              ["none", "None"],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={auth === value} onClick={() => setAuth(value)}>
              {label}
            </button>
          ))}
        </div>
        <p className="hint">
          {auth === "oauth"
            ? "You'll sign in on the server's own page; it sends you back here, not to localhost."
            : auth === "bearer"
              ? "An API key or token the server gave you. It's sent as a bearer token by the gateway."
              : "For servers that need no sign-in, like one on your own network."}
        </p>
      </div>
      {auth === "bearer" ? (
        <div className="field">
          <label className="label" htmlFor="mcp-token">
            Token
          </label>
          <input id="mcp-token" className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required />
        </div>
      ) : null}
      {auth === "oauth" ? (
        <details className="disclosure">
          <summary>
            <CaretRight size={12} weight="bold" />
            Use your own OAuth client
          </summary>
          <div className="mcp-add-grid" style={{ marginTop: 10 }}>
            <input className="input mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" aria-label="Client ID" autoComplete="off" />
            <input className="input mono" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Client secret (optional)" aria-label="Client secret" autoComplete="off" />
          </div>
          <p className="hint" style={{ marginTop: 6 }}>Only for servers that don&apos;t let apps register themselves. Register the callback URL below with them.</p>
        </details>
      ) : null}
      <div className="form-foot">
        <span className="msg" role="status" data-tone={error ? "danger" : undefined}>
          {error ?? ""}
        </span>
        <button type="submit" className="btn btn-primary" disabled={busy || !name || !url}>
          <Plugs size={15} />
          {auth === "oauth" ? "Add and sign in" : "Add server"}
        </button>
      </div>
    </form>
  );
}

export function McpPanel() {
  const params = useSearchParams();
  const [servers, setServers] = useState<McpServerRow[] | null>(null);
  const [redirectUri, setRedirectUri] = useState("");
  const load = useCallback(
    () =>
      api<{ servers: McpServerRow[]; redirectUri: string }>("/settings/mcp")
        .then((r) => {
          setServers(r.servers);
          setRedirectUri(r.redirectUri);
        })
        .catch(() => setServers([])),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  const connected = params.get("mcp");
  const failed = params.get("mcp_error");

  return (
    <section className="set-sec" aria-labelledby="mcp-h" id="mcp">
      <header>
        <h2 id="mcp-h">MCP servers</h2>
        <p>Tools for every agent: Linear, Notion, Sentry, your own. Cloudly signs in and keeps the tokens; agents reach the servers through the key gateway and never see one.</p>
      </header>
      <div className="set-body">
        {connected ? (
          <div className="notice" data-tone="ok" role="status">
            <CheckCircle size={16} weight="bold" />
            {connected} is connected. New turns can use it.
          </div>
        ) : null}
        {failed ? (
          <div className="notice" data-tone="danger" role="alert">
            <WarningCircle size={16} weight="bold" />
            {failed}
          </div>
        ) : null}
        <div className="panel">
          {servers === null ? (
            <div className="panel-row" aria-busy="true">
              <div className="skeleton" style={{ width: "50%" }} />
            </div>
          ) : servers.length === 0 ? (
            <div className="panel-row hint">No servers yet. Add one below; every session from the next turn on can use it.</div>
          ) : (
            servers.map((s) => <Row key={s.id} server={s} onChange={load} />)
          )}
          <AddServer onAdded={load} />
          {redirectUri ? (
            <div className="panel-row hint">
              Callback URL: <code className="mono">{redirectUri}</code>. Most servers need it on HTTPS.
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
