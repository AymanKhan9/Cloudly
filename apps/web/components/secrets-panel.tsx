"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle, Circle, LockSimple, Trash } from "@phosphor-icons/react";
import { api, ApiError } from "@/lib/api";

interface SettingRow {
  name: string;
  label: string;
  secret: boolean;
  group: "github" | "models" | "alerts" | "access";
  set: boolean;
  source: "db" | "env" | null;
  preview: string | null;
  locked: boolean;
}

const SHOWN: SettingRow["group"][] = ["models", "alerts", "access"];

function Row({ row, onChange }: { row: SettingRow; onChange: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/settings/secrets/${row.name}`, { method: "PUT", body: JSON.stringify({ value }) });
      setValue("");
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    await api(`/settings/secrets/${row.name}`, { method: "DELETE" }).catch(() => {});
    setBusy(false);
    onChange();
  }

  const state = !row.set
    ? row.locked
      ? "Locked: saved by an earlier install"
      : "Not set"
    : row.source === "env"
      ? `Set in the server's .env${row.secret ? ` (${row.preview})` : ""}`
      : `Saved${row.preview ? ` (${row.preview})` : ""}`;

  return (
    <div className="secret">
      <div>
        <div className="name">{row.label}</div>
        <div className="state" role="status" data-set={row.set || undefined} data-locked={(!row.set && row.locked) || undefined}>
          {row.set ? <CheckCircle size={13} weight="bold" /> : row.locked ? <LockSimple size={13} weight="bold" /> : <Circle size={13} />}
          {state}
        </div>
      </div>
      <form onSubmit={save}>
        <input
          type={row.secret ? "password" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={row.set ? "Replace" : row.secret ? "Paste a key" : "Value"}
          autoComplete="off"
          aria-label={row.label}
          className={`input${row.secret ? " mono" : ""}`}
        />
        <button type="submit" className="btn btn-secondary" disabled={busy || !value.trim()}>
          Save
        </button>
        {row.source === "db" ? (
          <button type="button" className="icon-btn" onClick={remove} disabled={busy} aria-label={`Remove ${row.label}`} title="Remove">
            <Trash size={16} />
          </button>
        ) : (
          <span style={{ width: 36, flex: "none" }} aria-hidden="true" />
        )}
      </form>
      {error ? (
        <div className="notice err" data-tone="danger">
          {error}
        </div>
      ) : null}
    </div>
  );
}

// Shown while settings from an earlier install on this database are still locked.
function RestorePanel({ locked, onChange }: { locked: SettingRow[]; onChange: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/settings/recover", { method: "POST", body: JSON.stringify({ key }) });
      setKey("");
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't restore.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="secret" style={{ background: "var(--warn-soft)" }}>
      <div>
        <div className="name">Restore from an earlier install</div>
        <div className="state" data-locked>
          <LockSimple size={13} weight="bold" />
          Locked: {locked.map((r) => r.label).join(", ")}
        </div>
        <p className="hint" style={{ marginTop: 6 }}>
          Paste the recovery key the earlier install printed to unlock them. Anything you&apos;ve saved here since stays as it is.
        </p>
      </div>
      <form onSubmit={restore}>
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Recovery key" autoComplete="off" aria-label="Recovery key" className="input mono" />
        <button type="submit" className="btn btn-primary" disabled={busy || !key.trim()}>
          {busy ? "Restoring" : "Restore"}
        </button>
      </form>
      {error ? (
        <div className="notice err" data-tone="danger">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function SecretsPanel() {
  const [rows, setRows] = useState<SettingRow[] | null>(null);
  const load = useCallback(() => api<{ settings: SettingRow[] }>("/settings/secrets").then((r) => setRows(r.settings)).catch(() => setRows([])), []);
  useEffect(() => {
    load();
  }, [load]);

  const github = rows?.find((r) => r.name === "GITHUB_APP_SLUG");

  return (
    <section className="set-sec" aria-labelledby="keys-h">
      <header>
        <h2 id="keys-h">Keys and connections</h2>
        <p>
          Stored encrypted on this server and never shown again after saving. Agents get them through the key gateway, never inside the sandbox.
          {github?.set ? ` GitHub is connected through the app "${github.preview}".` : ""}
        </p>
      </header>
      <div className="set-body">
        <div className="panel">
          {rows === null ? (
            <div className="panel-row" aria-busy="true">
              <div className="skeleton" style={{ width: "50%" }} />
            </div>
          ) : null}
          {rows?.some((r) => r.locked) ? <RestorePanel locked={rows.filter((r) => r.locked)} onChange={load} /> : null}
          {rows?.filter((r) => SHOWN.includes(r.group)).map((r) => <Row key={r.name} row={r} onChange={load} />)}
        </div>
      </div>
    </section>
  );
}
