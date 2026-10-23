"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowSquareOut, CaretRight, Check, Monitor, Play, Stop, WarningCircle } from "@phosphor-icons/react";
import { api, ApiError, type Preview } from "@/lib/api";
import { DesktopViewer } from "./desktop-viewer";
import { StatusIcon } from "./status";

interface PreviewState {
  preview: Preview | null;
  defaults: { command: string; port: number };
  /** PREVIEW_ORIGIN is set: previews open in the browser. */
  available: boolean;
  /** The sandbox image has the desktop. */
  desktop: boolean;
}

const LIVE: Preview["status"][] = ["requested", "starting", "running", "stopping"];
const LABEL: Record<Preview["status"], string> = {
  requested: "Waiting for the worker",
  starting: "Starting: cloning the branch and running the command",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
};

/**
 * The session's app, started from its branch in a sandbox of its own. It opens
 * on a separate origin (the relay's), so its code never runs as the Cloudly app,
 * or on the sandbox's desktop, where it never runs in your browser at all.
 */
export function PreviewPanel({ threadId }: { threadId: string }) {
  const [state, setState] = useState<PreviewState | null>(null);
  const [command, setCommand] = useState("");
  const [port, setPort] = useState("");
  const [desktop, setDesktop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);

  const load = useCallback(
    () =>
      api<PreviewState>(`/threads/${threadId}/previews`).then((s) => {
        setState(s);
        return s;
      }),
    [threadId],
  );

  useEffect(() => {
    load()
      .then((s) => {
        setCommand(s.preview?.command ?? s.defaults.command);
        setPort(String(s.preview?.port ?? s.defaults.port));
        setDesktop(s.preview?.desktop ?? (!s.available && s.desktop));
      })
      .catch((e: Error) => setError(e.message));
  }, [load]);

  const live = state?.preview && LIVE.includes(state.preview.status);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => load().catch(() => {}), 2500);
    return () => window.clearInterval(timer);
  }, [live, load]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/threads/${threadId}/previews`, { method: "POST", body: JSON.stringify({ command, port: Number(port), desktop }) });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the preview.");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!state?.preview) return;
    setWatching(false);
    await api(`/previews/${state.preview.id}/stop`, { method: "POST" }).catch(() => {});
    await load();
  }

  async function open() {
    if (!state?.preview) return;
    // Opened before the request so popup blockers allow it, then pointed at the link.
    const tab = window.open("about:blank", "_blank");
    try {
      const { url } = await api<{ url: string }>(`/previews/${state.preview.id}/link`);
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.assign(url);
      }
    } catch (err) {
      tab?.close();
      setError(err instanceof ApiError ? err.message : "Couldn't open the preview.");
    }
  }

  if (!state) {
    return error ? (
      <p className="hint" role="alert">
        {error}
      </p>
    ) : (
      <div className="skeleton" style={{ width: "50%" }} aria-busy="true" />
    );
  }

  const p = state.preview;
  const canStart = state.available || state.desktop;

  return (
    <div className="preview">
      {p && live ? (
        <>
          <div className="preview-status">
            <StatusIcon status={p.status === "running" ? "running" : "queued"} size={15} />
            <span>{LABEL[p.status]}</span>
            <span className="mono dim">
              {p.command} · port {p.port}
            </span>
            {p.expiresAt && p.status === "running" ? <span className="dim">until {new Date(p.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> : null}
          </div>
          <div className="form-foot" style={{ justifyContent: "flex-start" }}>
            {p.status === "running" && state.available ? (
              <button type="button" className="btn btn-primary" onClick={open}>
                <ArrowSquareOut size={15} />
                Open in a new tab
              </button>
            ) : null}
            {p.status === "running" && p.desktop ? (
              <button type="button" className="btn btn-secondary" onClick={() => setWatching((w) => !w)} aria-pressed={watching}>
                <Monitor size={15} />
                {watching ? "Hide desktop" : "Watch on the desktop"}
              </button>
            ) : null}
            <button type="button" className="btn btn-secondary" onClick={stop} disabled={p.status === "stopping"}>
              <Stop size={15} />
              Stop
            </button>
          </div>
          {watching && p.status === "running" ? <DesktopViewer source={`/previews/${p.id}/desktop`} title="Preview desktop" onClose={() => setWatching(false)} /> : null}
        </>
      ) : (
        <form className="preview-form" onSubmit={start}>
          {p?.status === "failed" || p?.error ? (
            <div className="notice" data-tone={p.status === "failed" ? "danger" : undefined}>
              <WarningCircle size={16} weight="bold" />
              {p.error ?? "The last preview failed."}
            </div>
          ) : null}
          <div className="preview-fields">
            <div className="field">
              <label className="label" htmlFor="pv-cmd">
                Command
              </label>
              <input id="pv-cmd" className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} required spellCheck={false} />
            </div>
            <div className="field">
              <label className="label" htmlFor="pv-port">
                Port
              </label>
              <input id="pv-port" className="input mono num" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} required style={{ width: 96 }} />
            </div>
          </div>
          {state.desktop ? (
            <label className="chip" style={{ justifySelf: "start" }}>
              <input type="checkbox" checked={desktop} onChange={(e) => setDesktop(e.target.checked)} />
              <span className="box">
                <Check size={11} weight="bold" />
              </span>
              Also open it on the sandbox&apos;s desktop
            </label>
          ) : null}
          <div className="form-foot">
            <span className="msg" role="status" data-tone={error ? "danger" : undefined}>
              {error ??
                (!canStart
                  ? "Previews need PREVIEW_ORIGIN in the server's configuration, or the Desktop and browser sandbox preset."
                  : !state.available
                    ? "Without PREVIEW_ORIGIN, previews show on the sandbox's desktop only."
                    : "Runs this session's branch, with the same network rules as the agent. Stops after an hour.")}
            </span>
            <button type="submit" className="btn btn-primary" disabled={busy || !canStart || !command.trim() || !port || (!state.available && !desktop)}>
              <Play size={15} />
              Start preview
            </button>
          </div>
        </form>
      )}
      {p?.log ? (
        <details className="disclosure" open={p.status === "failed"}>
          <summary>
            <CaretRight size={12} weight="bold" />
            Output
          </summary>
          <pre className="mono">{p.log}</pre>
        </details>
      ) : null}
    </div>
  );
}
