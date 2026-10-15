"use client";

import { useCallback, useEffect, useState } from "react";
import { CaretRight, Check, CheckCircle, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { api, ApiError } from "@/lib/api";

interface Preset {
  id: string;
  label: string;
  note?: string;
  /** The preset's lines between its marker comments, as they go in the script. */
  block: string;
}

interface SandboxView {
  script: string;
  presets: Preset[];
  build: { status: "pending" | "building" | "ready" | "failed"; log: string; image: string; updatedAt: string };
  network: { defaults: string[]; extra: string };
}

const marker = (id: string) => `# cloudly:${id}`;

function toggle(script: string, preset: Preset, on: boolean): string {
  const start = script.indexOf(marker(preset.id));
  if (on) return start === -1 ? [script.trim(), preset.block].filter(Boolean).join("\n\n") : script;
  if (start === -1) return script;
  const endMarker = `# end cloudly:${preset.id}`;
  const end = script.indexOf(endMarker, start);
  const stop = end === -1 ? script.length : end + endMarker.length;
  return (script.slice(0, start) + script.slice(stop)).replace(/\n{3,}/g, "\n\n").trim();
}

const STATUS: Record<SandboxView["build"]["status"], string> = {
  pending: "Waiting for the worker to start the build.",
  building: "Building the sandbox image. This takes a few minutes; runs keep using the previous image meanwhile.",
  ready: "Ready. New runs use this setup.",
  failed: "The last build failed. Runs keep using the previous image.",
};

export function SandboxPanel() {
  const [view, setView] = useState<SandboxView | null>(null);
  const [script, setScript] = useState("");
  const [hosts, setHosts] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const v = await api<SandboxView>("/settings/sandbox");
    setView(v);
    return v;
  }, []);

  useEffect(() => {
    load()
      .then((v) => {
        setScript(v.script);
        setHosts(v.network.extra);
      })
      .catch(() => setError("Couldn't load the sandbox settings."));
  }, [load]);

  // Poll only while a build is queued or running.
  const busy = view?.build.status === "pending" || view?.build.status === "building";
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => load().catch(() => {}), 4000);
    return () => window.clearInterval(timer);
  }, [busy, load]);

  async function send(path: string, init: RequestInit) {
    setSaving(true);
    setError(null);
    try {
      const v = await api<SandboxView>(path, init);
      setView(v);
      setScript(v.script);
      setHosts(v.network.extra);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  const dirty = view !== null && script.trim() !== view.script.trim();
  const notes = view?.presets.filter((p) => p.note && script.includes(marker(p.id))) ?? [];

  const BuildIcon = view?.build.status === "ready" ? CheckCircle : view?.build.status === "failed" ? WarningCircle : CircleNotch;

  return (
    <>
      <section className="set-sec" aria-labelledby="sandbox-h">
        <header>
          <h2 id="sandbox-h">Sandbox tools</h2>
          <p>Every run has Node 22, Bun, Python 3, git and C build tools. Add more here; the agent is told what&apos;s installed.</p>
        </header>
        <div className="set-body">
          {view === null ? (
            error ? (
              <div className="notice" data-tone="danger">
                {error}
              </div>
            ) : (
              <div className="skeleton" style={{ width: "50%" }} aria-busy="true" />
            )
          ) : (
            <form
              className="panel"
              onSubmit={(e) => {
                e.preventDefault();
                send("/settings/sandbox", { method: "PUT", body: JSON.stringify({ script }) });
              }}
            >
              <div className="panel-row field">
                <span className="label">Presets</span>
                <div className="chips">
                  {view.presets.map((p) => (
                    <label key={p.id} className="chip">
                      <input type="checkbox" checked={script.includes(marker(p.id))} onChange={(e) => setScript(toggle(script, p, e.target.checked))} />
                      <span className="box">
                        <Check size={11} weight="bold" />
                      </span>
                      {p.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="panel-row field">
                <label className="label" htmlFor="setup-script">
                  Setup script
                </label>
                <textarea
                  id="setup-script"
                  className="textarea mono code-area"
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  rows={Math.min(18, Math.max(5, script.split("\n").length + 1))}
                  spellCheck={false}
                  placeholder="# Runs as root when the sandbox image is built, after apt-get update. For example:&#10;apt-get install -y --no-install-recommends jq"
                />
                <p className="hint">
                  Runs as root once, when the image is built, not on every run. Each tool adds roughly 0.3 to 1 GB of disk.
                  {notes.map((p) => ` ${p.note}`).join("")}
                </p>
              </div>
              <div className="panel-row" style={{ display: "grid", gap: 12 }}>
                <div className="form-foot">
                  <span className="msg build-status" role="status" data-s={error ? "failed" : view.build.status}>
                    <BuildIcon size={15} weight="bold" className={busy ? "spin" : undefined} />
                    {error ?? STATUS[view.build.status]}
                  </span>
                  {view.build.status === "failed" && !dirty ? (
                    <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => send("/settings/sandbox/rebuild", { method: "POST" })}>
                      Retry build
                    </button>
                  ) : null}
                  <button type="submit" className="btn btn-primary" disabled={saving || !dirty}>
                    {saving ? "Saving" : "Save and build"}
                  </button>
                </div>
                {view.build.log && view.build.status !== "pending" ? (
                  <details className="disclosure">
                    <summary>
                      <CaretRight size={12} weight="bold" />
                      Build log
                    </summary>
                    <pre className="mono">{view.build.log}</pre>
                  </details>
                ) : null}
              </div>
            </form>
          )}
        </div>
      </section>

      {view ? (
        <section className="set-sec" aria-labelledby="network-h">
          <header>
            <h2 id="network-h">Network</h2>
            <p>Runs reach only the model APIs, the main package registries and GitHub, so a malicious repo can&apos;t send your key elsewhere.</p>
          </header>
          <div className="set-body">
            <form
              className="panel"
              onSubmit={(e) => {
                e.preventDefault();
                send("/settings/sandbox/network", { method: "PUT", body: JSON.stringify({ hosts }) });
              }}
            >
              <div className="panel-row field">
                <label className="label" htmlFor="egress-hosts">
                  Extra hosts the agent may reach
                </label>
                <textarea id="egress-hosts" className="textarea mono code-area" rows={3} value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="docs.example.com" spellCheck={false} />
                <p className="hint">
                  One per line; subdomains are included. <code className="mono">*</code> allows everything. Applies from the next run.
                </p>
                <details className="disclosure">
                  <summary>
                    <CaretRight size={12} weight="bold" />
                    Always allowed ({view.network.defaults.length})
                  </summary>
                  <pre className="mono">{view.network.defaults.join("\n")}</pre>
                </details>
              </div>
              <div className="panel-row form-foot">
                <button type="submit" className="btn btn-primary" disabled={saving || hosts.trim() === view.network.extra.trim()}>
                  Save hosts
                </button>
              </div>
            </form>
          </div>
        </section>
      ) : null}
    </>
  );
}
