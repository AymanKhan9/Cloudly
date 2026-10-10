"use client";

import { useCallback, useEffect, useState } from "react";
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
  pending: "Waiting for the worker to start the build…",
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

  return (
    <section className="sheet" style={{ marginTop: 28 }} aria-labelledby="sandbox-heading">
      <div className="sheet-head">
        <span id="sandbox-heading" className="caps" style={{ color: "var(--slate)" }}>
          Sandbox tools
        </span>
      </div>
      {view === null ? (
        <div className="skeleton" style={{ margin: 20, width: "50%" }} aria-busy="true" />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send("/settings/sandbox", { method: "PUT", body: JSON.stringify({ script }) });
          }}
        >
          <div className="field field-wide">
            <p className="field-hint" style={{ marginTop: 0 }}>
              Every run has Node 22, Bun, Python 3, git and C build tools. Add more here; the agent is told what&apos;s installed.
            </p>
            <div className="preset-list">
              {view.presets.map((p) => (
                <label key={p.id} className="preset">
                  <input type="checkbox" checked={script.includes(marker(p.id))} onChange={(e) => setScript(toggle(script, p, e.target.checked))} />
                  {p.label}
                </label>
              ))}
            </div>
          </div>
          <div className="field field-wide">
            <label className="field-label" htmlFor="setup-script">
              Setup script
            </label>
            <textarea
              id="setup-script"
              className="mono setup-script"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={Math.min(18, Math.max(5, script.split("\n").length + 1))}
              spellCheck={false}
              placeholder="# Runs as root when the sandbox image is built, after apt-get update. For example:&#10;apt-get install -y --no-install-recommends jq"
            />
            <p className="field-hint">
              Runs as root once, when the image is built, not on every run. Each tool adds roughly 0.3–1 GB of disk.
              {notes.map((p) => ` ${p.note}`).join("")}
            </p>
          </div>
          <div className="sheet-foot">
            <span className="saved" role="status" style={{ color: view.build.status === "failed" ? "var(--storm)" : undefined }}>
              {error ?? STATUS[view.build.status]}
            </span>
            {view.build.status === "failed" && !dirty ? (
              <button type="button" className="btn btn-quiet" disabled={saving} onClick={() => send("/settings/sandbox/rebuild", { method: "POST" })}>
                Retry build
              </button>
            ) : null}
            <button type="submit" className="btn btn-signal" disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save and build"}
            </button>
          </div>
          {view.build.log && view.build.status !== "pending" ? (
            <details className="build-log">
              <summary>Build log</summary>
              <pre className="mono">{view.build.log}</pre>
            </details>
          ) : null}
        </form>
      )}
      {view ? (
        <form
          className="network-form"
          onSubmit={(e) => {
            e.preventDefault();
            send("/settings/sandbox/network", { method: "PUT", body: JSON.stringify({ hosts }) });
          }}
        >
          <div className="field field-wide">
            <label className="field-label" htmlFor="egress-hosts">
              Network: extra hosts the agent may reach
            </label>
            <p className="field-hint" style={{ marginTop: 0 }}>
              Runs can only reach the model APIs, the main package registries and GitHub, so a malicious repo can&apos;t make the
              agent send your key somewhere else. Add hosts here, one per line; subdomains are included. <span className="mono">*</span> allows
              everything. Applies from the next run.
            </p>
            <textarea id="egress-hosts" className="mono setup-script" rows={3} value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="docs.example.com" spellCheck={false} />
            <details className="build-log" style={{ padding: 0, marginTop: 8 }}>
              <summary>Always allowed ({view.network.defaults.length})</summary>
              <pre className="mono">{view.network.defaults.join("\n")}</pre>
            </details>
          </div>
          <div className="sheet-foot">
            <span />
            <button type="submit" className="btn btn-signal" disabled={saving || hosts.trim() === view.network.extra.trim()}>
              Save hosts
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
