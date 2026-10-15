"use client";

import { useRef } from "react";

/**
 * A 3D model of the user's own cloud account: one VM running the control plane
 * and a throwaway sandbox per run, with the only ways out (model API through the
 * key gateway, GitHub through the worker). Built from CSS 3D transforms so the
 * labels stay real, crisp text. Steps light the parts that are doing the work.
 */

export type NodeId = "browser" | "web" | "db" | "gateway" | "worker" | "sandbox" | "model" | "github";
export type FlowId = "task" | "dispatch" | "placeholder" | "key" | "blocked" | "patch" | "pr";

export interface SceneState {
  sandbox: boolean;
  flows: FlowId[];
  lit: NodeId[];
  absent?: NodeId[];
  badge?: string;
}

interface Box {
  id: NodeId;
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  label: string;
  sub?: string;
  z?: number;
}

const VM_TOP = 12;

const BOXES: Box[] = [
  { id: "browser", x: -345, y: -95, w: 84, d: 58, h: 22, label: "Your browser" },
  { id: "web", x: -145, y: -95, w: 90, d: 64, h: 40, label: "Web + API", z: VM_TOP },
  { id: "db", x: -45, y: -95, w: 64, d: 64, h: 30, label: "Postgres", z: VM_TOP },
  { id: "gateway", x: 70, y: -95, w: 84, d: 64, h: 36, label: "Key gateway", z: VM_TOP },
  { id: "sandbox", x: -80, y: 80, w: 66, d: 60, h: 50, label: "Sandbox", sub: "no keys, no GitHub", z: VM_TOP },
  { id: "worker", x: 70, y: 80, w: 84, d: 70, h: 42, label: "Worker", z: VM_TOP },
  { id: "model", x: 258, y: -95, w: 96, d: 64, h: 34, label: "Model API" },
  { id: "github", x: 258, y: 80, w: 96, d: 70, h: 34, label: "GitHub" },
];

const at = (id: NodeId) => BOXES.find((b) => b.id === id)!;

// Ephemeral beams only exist while their step is happening.
const FLOWS: { id: FlowId; from: [number, number]; to: [number, number]; ephemeral?: boolean; stop?: number }[] = [
  { id: "task", from: [at("browser").x, at("browser").y], to: [at("web").x, at("web").y] },
  { id: "dispatch", from: [at("worker").x, at("worker").y], to: [at("sandbox").x, at("sandbox").y], ephemeral: true },
  { id: "placeholder", from: [at("sandbox").x, at("sandbox").y], to: [at("gateway").x, at("gateway").y] },
  { id: "key", from: [at("gateway").x, at("gateway").y], to: [at("model").x, at("model").y] },
  { id: "blocked", from: [at("sandbox").x, at("sandbox").y], to: [at("sandbox").x, 262], ephemeral: true, stop: 72 },
  { id: "patch", from: [at("sandbox").x, at("sandbox").y], to: [at("worker").x, at("worker").y], ephemeral: true },
  { id: "pr", from: [at("worker").x, at("worker").y], to: [at("github").x, at("github").y] },
];

const RX = { min: 30, max: 68, start: 47 };
const RZ = { min: -80, max: 20, start: -28 };

function Faces() {
  return (
    <>
      <i className="f back" />
      <i className="f left" />
      <i className="f right" />
      <i className="f front" />
      <i className="f top" />
    </>
  );
}

export function CloudScene({ state, label, compact = false }: { state: SceneState; label: string; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const angle = useRef({ rx: RX.start, rz: RZ.start });
  const drag = useRef<{ x: number; y: number; rx: number; rz: number } | null>(null);

  const apply = (rx: number, rz: number) => {
    angle.current = { rx: Math.min(RX.max, Math.max(RX.min, rx)), rz: Math.min(RZ.max, Math.max(RZ.min, rz)) };
    ref.current?.style.setProperty("--rx", `${angle.current.rx}deg`);
    ref.current?.style.setProperty("--rz", `${angle.current.rz}deg`);
  };

  const lit = new Set(state.lit);
  const absent = new Set(state.absent);
  if (!state.sandbox) absent.add("sandbox");
  const flows = new Set(state.flows);

  return (
    <div
      ref={ref}
      className="scene"
      data-compact={compact || undefined}
      data-busy={state.lit.length > 0 || undefined}
      role="img"
      aria-label={label}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        drag.current = { x: e.clientX, y: e.clientY, ...angle.current };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.dragging = "";
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        apply(d.rx - (e.clientY - d.y) * 0.18, d.rz - (e.clientX - d.x) * 0.3);
      }}
      onPointerUp={(e) => {
        drag.current = null;
        delete e.currentTarget.dataset.dragging;
      }}
      onPointerCancel={(e) => {
        drag.current = null;
        delete e.currentTarget.dataset.dragging;
      }}
      onDoubleClick={() => apply(RX.start, RZ.start)}
      onKeyDown={(e) => {
        const step: Record<string, [number, number]> = { ArrowLeft: [0, 6], ArrowRight: [0, -6], ArrowUp: [3, 0], ArrowDown: [-3, 0] };
        const s = step[e.key];
        if (!s) return;
        e.preventDefault();
        apply(angle.current.rx + s[0], angle.current.rz + s[1]);
      }}
    >
      <div className="world" aria-hidden="true">
        <div className="plate" style={{ "--x": -35, "--y": -7, "--w": 384, "--d": 318 } as React.CSSProperties}>
        </div>
        <div className="plate" style={{ "--x": -80, "--y": 262, "--w": 160, "--d": 56, borderColor: "color-mix(in srgb, var(--danger) 45%, transparent)" } as React.CSSProperties}>
          <div className="tag">
            <span>Anywhere else</span>
          </div>
        </div>

        <div className="b3 slab" style={{ "--x": -35, "--y": -7, "--w": 344, "--d": 274, "--h": VM_TOP } as React.CSSProperties}>
          <div className="lift">
            <Faces />
          </div>
          <div className="tag" style={{ left: "0%", top: "100%" }}>
            <span>
              Your VM <small>in your own cloud account</small>
            </span>
          </div>
        </div>

        {FLOWS.map((f) => {
          const dx = f.to[0] - f.from[0];
          const dy = f.to[1] - f.from[1];
          const on = flows.has(f.id);
          return (
            <div
              key={f.id}
              className="beam"
              data-kind={f.id}
              data-on={on || undefined}
              data-hidden={(f.ephemeral && !on) || undefined}
              style={
                {
                  "--x1": f.from[0],
                  "--y1": f.from[1],
                  "--len": Math.hypot(dx, dy),
                  "--ang": `${(Math.atan2(dy, dx) * 180) / Math.PI}deg`,
                  "--stop": f.stop ?? 0,
                } as React.CSSProperties
              }
            >
              <i className="packet" />
              {f.stop ? <i className="wall" /> : null}
            </div>
          );
        })}

        {BOXES.map((b) => (
          <div
            key={b.id}
            className={`b3${b.id === "sandbox" ? " sandbox" : ""}`}
            data-lit={lit.has(b.id) || undefined}
            data-absent={absent.has(b.id) || undefined}
            style={{ "--x": b.x, "--y": b.y, "--w": b.w, "--d": b.d, "--h": b.h, "--z": b.z ?? 0 } as React.CSSProperties}
          >
            <div className="lift">
              <Faces />
            </div>
            <div className="tag">
              <span>
                {b.label}
                {b.sub ? <small>{b.sub}</small> : null}
              </span>
            </div>
            {b.id === "github" && state.badge ? (
              <div key={state.badge} className="tag badge" style={{ "--h": b.h + 34 } as React.CSSProperties}>
                <span>{state.badge}</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
