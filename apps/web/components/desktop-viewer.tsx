"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowsOut, HandPointing, Monitor, X } from "@phosphor-icons/react";
import { api } from "@/lib/api";

type Rfb = {
  scaleViewport: boolean;
  resizeSession: boolean;
  viewOnly: boolean;
  disconnect(): void;
  addEventListener(type: string, fn: (e: CustomEvent) => void): void;
};

/**
 * A sandbox's virtual desktop, live. `source` is the API path that hands out a
 * relay link and the VNC password for it (a turn's, or a preview's). The VNC
 * stream goes browser → web app /relay → relay → the container, by token.
 */
export function DesktopViewer({ source, onClose, title = "Desktop" }: { source: string; onClose: () => void; title?: string }) {
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<Rfb | null>(null);
  const [state, setState] = useState<"connecting" | "connected" | "closed">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [control, setControl] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState("connecting");
    setError(null);
    (async () => {
      try {
        const { url, password } = await api<{ url: string; password: string }>(source);
        // noVNC touches window on import, so it loads only here, in the browser.
        // Pinned to 1.4: 1.5+ ships a top-level await in its CommonJS build, which breaks bundling.
        const { default: RFB } = (await import("@novnc/novnc/lib/rfb.js")) as { default: new (el: HTMLElement, url: string, opts: object) => Rfb };
        if (cancelled || !screen.current) return;
        const ws = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${url}`;
        const r = new RFB(screen.current, ws, { credentials: { password } });
        r.scaleViewport = true;
        r.resizeSession = false;
        r.viewOnly = true;
        r.addEventListener("connect", () => setState("connected"));
        r.addEventListener("disconnect", () => setState("closed"));
        r.addEventListener("securityfailure", () => setError("The desktop refused the password. Reopen it."));
        rfb.current = r;
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Couldn't open the desktop.");
          setState("closed");
        }
      }
    })();
    return () => {
      cancelled = true;
      rfb.current?.disconnect();
      rfb.current = null;
    };
  }, [source, attempt]);

  useEffect(() => {
    if (rfb.current) rfb.current.viewOnly = !control;
  }, [control, state]);

  return (
    <div className="desktop" data-state={state}>
      <div className="desktop-bar">
        <Monitor size={15} />
        <span className="label">{title}</span>
        <span className="dim">{state === "connected" ? (control ? "You have control" : "Watching") : state === "connecting" ? "Connecting" : "Disconnected"}</span>
        <span className="spacer" />
        {state === "connected" ? (
          <button type="button" className="btn btn-secondary btn-sm" aria-pressed={control} onClick={() => setControl((c) => !c)} title="Use the mouse and keyboard on the desktop">
            <HandPointing size={14} />
            {control ? "Hand back" : "Take control"}
          </button>
        ) : state === "closed" ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAttempt((a) => a + 1)}>
            Reconnect
          </button>
        ) : null}
        <button type="button" className="icon-btn" onClick={() => screen.current?.requestFullscreen?.()} aria-label="Full screen" title="Full screen">
          <ArrowsOut size={15} />
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close the desktop" title="Close">
          <X size={15} />
        </button>
      </div>
      {error ? (
        <p className="hint" role="alert" style={{ padding: 12 }}>
          {error}
        </p>
      ) : null}
      <div ref={screen} className="desktop-screen" />
    </div>
  );
}
