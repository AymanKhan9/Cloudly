"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

interface SettingRow {
  name: string;
  label: string;
  secret: boolean;
  group: "github" | "models" | "alerts" | "access";
  set: boolean;
  source: "db" | "env" | null;
  preview: string | null;
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
    ? "Not set"
    : row.source === "env"
      ? `Set in the server's .env${row.secret ? ` (${row.preview})` : ""}`
      : `Saved${row.preview ? ` (${row.preview})` : ""}`;

  return (
    <div className="secret-row">
      <div>
        <div className="secret-name">{row.label}</div>
        <div className="secret-state" role="status">
          {state}
        </div>
      </div>
      {row.source === "db" ? (
        <button type="button" className="btn btn-quiet" onClick={remove} disabled={busy}>
          Remove
        </button>
      ) : null}
      <form onSubmit={save}>
        <input
          type={row.secret ? "password" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={row.set ? "Replace" : row.secret ? "Paste a key" : "Value"}
          autoComplete="off"
          aria-label={row.label}
          className={row.secret ? "mono" : undefined}
        />
        <button type="submit" className="btn btn-signal" disabled={busy || !value.trim()}>
          Save
        </button>
      </form>
      {error ? <div className="error-box" style={{ gridColumn: "1 / -1" }}>{error}</div> : null}
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
    <section className="sheet" style={{ marginTop: 28 }} aria-labelledby="keys-heading">
      <div className="sheet-head">
        <span id="keys-heading" className="caps" style={{ color: "var(--slate)" }}>
          Keys and connections
        </span>
      </div>
      {rows === null ? <div className="skeleton" style={{ margin: 20, width: "50%" }} aria-busy="true" /> : null}
      {rows?.filter((r) => SHOWN.includes(r.group)).map((r) => <Row key={r.name} row={r} onChange={load} />)}
      <p className="field-hint" style={{ padding: "12px 20px 16px", margin: 0 }}>
        Keys are stored encrypted on this server and never shown again after saving. The agents use them when a run starts.
        {github?.set ? ` GitHub is connected through the app "${github.preview}".` : ""}
      </p>
    </section>
  );
}
