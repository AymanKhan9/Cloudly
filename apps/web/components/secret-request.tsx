"use client";

import { useState } from "react";
import { CheckCircle, Key, LockKey, WarningCircle } from "@phosphor-icons/react";
import { api, ApiError } from "@/lib/api";
import type { StreamEvent } from "@/lib/events";

// request_secret (packages/runner/src/ask-mcp.ts): the agent asks for a secret
// by name; the user pastes it here. It's stored encrypted like a secret added in
// Settings, and the agent only ever gets a placeholder, which the proxy swaps
// for the value on requests to the named hosts.

export interface SecretAsk {
  name: string;
  description: string;
  hosts: string[];
}

/** The secret this turn's agent asked for, if it asked for one. */
export function secretAsk(events: StreamEvent[]): SecretAsk | null {
  for (const e of events) {
    const d = e.data as { type?: string; name?: unknown; description?: unknown; hosts?: unknown } | null;
    if (e.kind !== "status" || d?.type !== "secret_request" || typeof d.name !== "string") continue;
    return {
      name: d.name,
      description: typeof d.description === "string" ? d.description : "",
      hosts: Array.isArray(d.hosts) ? d.hosts.filter((h): h is string => typeof h === "string") : [],
    };
  }
  return null;
}

export function SecretRequest({ threadId, ask, open }: { threadId: string; ask: SecretAsk; open: boolean }) {
  const [value, setValue] = useState("");
  const [hosts, setHosts] = useState(ask.hosts.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[] | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api<{ hosts: string[] }>(`/threads/${threadId}/secrets`, {
        method: "POST",
        body: JSON.stringify({ name: ask.name, value, hosts }),
      });
      setValue("");
      setSaved(out.hosts);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Couldn't save it.");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    setError(null);
    try {
      await api(`/threads/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ prompt: `I won't give you ${ask.name}. Carry on without it, or tell me what else would work.` }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send that.");
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <div className="secret-card" data-state="saved" role="status">
        <CheckCircle size={18} weight="fill" className="secret-ok" />
        <div>
          <strong>Saved.</strong> <code>{ask.name}</code> is stored encrypted. The agent gets <code>${ask.name}</code>, a placeholder the proxy fills in only on requests to{" "}
          {saved.join(", ")}. It never sees the value. Its next turn has started.
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="secret-card" data-state="closed">
        <Key size={16} />
        <span>
          Asked for a secret: <code>{ask.name}</code>
          {ask.hosts.length ? <span className="hint"> · for {ask.hosts.join(", ")}</span> : null}
        </span>
      </div>
    );
  }

  return (
    <form className="secret-card" data-state="open" onSubmit={save}>
      <div className="secret-head">
        <span className="secret-icon">
          <LockKey size={18} weight="bold" />
        </span>
        <div>
          <div className="secret-title">
            The agent needs a secret: <code>{ask.name}</code>
          </div>
          {ask.description ? <p className="secret-desc">{ask.description}</p> : null}
        </div>
      </div>
      <label className="label" htmlFor={`secret-${ask.name}`}>
        Value
      </label>
      <input
        id={`secret-${ask.name}`}
        className="input mono"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste it here"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <label className="label" htmlFor={`secret-hosts-${ask.name}`}>
        Only sent to
      </label>
      <input
        id={`secret-hosts-${ask.name}`}
        className="input mono"
        spellCheck={false}
        value={hosts}
        onChange={(e) => setHosts(e.target.value)}
      />
      <p className="hint">
        Stored encrypted and never shown to the agent: it gets a placeholder that the network proxy swaps for the real value on HTTPS requests to these hosts. You can
        change or remove it under Settings → Secrets.
      </p>
      {error ? (
        <div className="notice" data-tone="danger" role="alert">
          <WarningCircle size={16} weight="bold" />
          {error}
        </div>
      ) : null}
      <div className="secret-actions">
        <button type="button" className="btn btn-ghost" onClick={decline} disabled={busy}>
          Decline
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !value}>
          <LockKey size={15} weight="bold" />
          {busy ? "Saving" : "Save securely"}
        </button>
      </div>
    </form>
  );
}
