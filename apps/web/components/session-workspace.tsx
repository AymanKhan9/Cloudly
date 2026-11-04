"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";
import { NotePencil, SquareSplitHorizontal, SquareSplitVertical, X } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { StatusIcon } from "@/components/status";
import { SessionView } from "@/components/session-view";
import type { RunStatus } from "@/lib/harness";
import {
  DRAG_TYPE,
  focusedSession,
  panes,
  setSessionInfo,
  useSessionInfo,
  useWorkspace,
  workspace,
  type Edge,
  type Node,
  type Pane,
  type Split,
} from "@/lib/workspace";

type Zone = Edge | "center";

/** What's being dragged: a session id, and the pane it came from (none from the sidebar). */
function readDrag(e: React.DragEvent): { id: string; from?: string } | null {
  try {
    const v = JSON.parse(e.dataTransfer.getData(DRAG_TYPE));
    return typeof v?.id === "string" ? v : null;
  } catch {
    return null;
  }
}

const isSessionDrag = (e: React.DragEvent | DragEvent) => Boolean(e.dataTransfer?.types.includes(DRAG_TYPE));

/**
 * Sessions side by side: panes with tabs, split any way and resized by
 * dragging the dividers. Drag a tab (or a session from the sidebar) onto a
 * pane to move it there, or onto a pane's edge to split it.
 */
export function SessionWorkspace() {
  const layout = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const [dragging, setDragging] = useState(false);
  const focused = focusedSession(layout);
  const seen = useRef<string | null | undefined>(undefined);

  // The address follows the focused session; the first render takes it from the address instead.
  useEffect(() => {
    if (seen.current === undefined) {
      seen.current = focused;
      return;
    }
    if (seen.current === focused) return;
    seen.current = focused;
    if (focused && pathname !== `/app/s/${focused}`) router.replace(`/app/s/${focused}`);
    // Every tab closed: back to a new session.
    if (!focused && panes(layout.root).every((p) => p.tabs.length === 0)) router.push("/app");
  }, [focused, pathname, router, layout.root]);

  // Titles for tabs that haven't loaded yet.
  useEffect(() => {
    api<{ threads: { id: string; title: string; lastStatus?: string; prUrl?: string | null }[] }>("/threads")
      .then((r) => setSessionInfo(r.threads))
      .catch(() => {});
  }, []);

  // While a session is dragged anywhere, panes show where it would land.
  useEffect(() => {
    const on = (e: DragEvent) => isSessionDrag(e) && setDragging(true);
    const off = () => setDragging(false);
    document.addEventListener("dragenter", on);
    document.addEventListener("dragend", off);
    document.addEventListener("drop", off);
    return () => {
      document.removeEventListener("dragenter", on);
      document.removeEventListener("dragend", off);
      document.removeEventListener("drop", off);
    };
  }, []);

  const many = panes(layout.root).length > 1;
  return (
    <div className="workspace" data-dragging={dragging || undefined}>
      <NodeView node={layout.root} focus={layout.focus} many={many} />
    </div>
  );
}

function NodeView({ node, focus, many }: { node: Node; focus: string; many: boolean }) {
  return node.kind === "pane" ? <PaneView pane={node} focused={node.id === focus} many={many} /> : <SplitView split={node} focus={focus} many={many} />;
}

function SplitView({ split, focus, many }: { split: Split; focus: string; many: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="ws-split" data-dir={split.dir}>
      {split.children.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 ? <Divider split={split} index={i} container={ref} /> : null}
          <div className="ws-cell" style={{ flex: `${split.sizes[i] ?? 1} 1 0px` }} data-has-focus={panes(c).some((p) => p.id === focus) || undefined}>
            <NodeView node={c} focus={focus} many={many} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

const MIN = 0.12;

/** The handle between two neighbours of a split: drag it, or use the arrow keys. */
function Divider({ split, index, container }: { split: Split; index: number; container: React.RefObject<HTMLDivElement | null> }) {
  const row = split.dir === "row";
  // Moves the line by `delta` (a share of the split) from where `from` had it.
  const move = (from: number[], delta: number) => {
    const sizes = [...from];
    const a = sizes[index - 1]!;
    const b = sizes[index]!;
    const d = Math.max(MIN - a, Math.min(b - MIN, delta));
    sizes[index - 1] = a + d;
    sizes[index] = b - d;
    workspace.resize(split.id, sizes);
  };
  return (
    <div
      className="ws-divider"
      data-dir={split.dir}
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label="Resize"
      aria-valuenow={Math.round((split.sizes[index - 1] ?? 0) * 100)}
      tabIndex={0}
      onPointerDown={(e) => {
        const box = container.current?.getBoundingClientRect();
        if (!box) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const total = row ? box.width : box.height;
        const start = row ? e.clientX : e.clientY;
        const from = [...split.sizes];
        const el = e.currentTarget;
        const onMove = (ev: PointerEvent) => move(from, ((row ? ev.clientX : ev.clientY) - start) / total);
        const onUp = () => {
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerup", onUp);
          el.removeEventListener("pointercancel", onUp);
          document.body.removeAttribute("data-resizing");
          workspace.persist();
        };
        document.body.setAttribute("data-resizing", row ? "row" : "column");
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("pointercancel", onUp);
      }}
      onKeyDown={(e) => {
        const back = row ? "ArrowLeft" : "ArrowUp";
        const fwd = row ? "ArrowRight" : "ArrowDown";
        if (e.key === back || e.key === fwd) {
          e.preventDefault();
          move(split.sizes, e.key === fwd ? 0.03 : -0.03);
          workspace.persist();
        }
      }}
      onDoubleClick={() => {
        // Even out the two neighbours.
        const sizes = [...split.sizes];
        const half = (sizes[index - 1]! + sizes[index]!) / 2;
        sizes[index - 1] = half;
        sizes[index] = half;
        workspace.resize(split.id, sizes);
        workspace.persist();
      }}
    />
  );
}

function zoneAt(e: React.DragEvent, el: HTMLElement): Zone {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const edge = Math.min(x, 1 - x, y, 1 - y);
  if (edge > 0.22) return "center";
  if (edge === x) return "left";
  if (edge === 1 - x) return "right";
  return edge === y ? "top" : "bottom";
}

function PaneView({ pane, focused, many }: { pane: Pane; focused: boolean; many: boolean }) {
  const info = useSessionInfo();
  const [zone, setZone] = useState<Zone | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  const slotAt = (clientX: number) => {
    const tabs = [...(strip.current?.querySelectorAll<HTMLElement>(".ws-tab") ?? [])];
    const i = tabs.findIndex((t) => {
      const r = t.getBoundingClientRect();
      return clientX < r.left + r.width / 2;
    });
    return i < 0 ? tabs.length : i;
  };

  return (
    <section
      className="ws-pane"
      data-focused={focused || undefined}
      aria-label={pane.active ? info[pane.active]?.title ?? "Session" : "Empty pane"}
      onPointerDownCapture={() => workspace.focus(pane.id)}
    >
      <div
        className="ws-tabs"
        ref={strip}
        role="tablist"
        aria-label="Open sessions"
        onDragOver={(e) => {
          if (!isSessionDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setSlot(slotAt(e.clientX));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setSlot(null);
        }}
        onDrop={(e) => {
          const d = readDrag(e);
          setSlot(null);
          if (!d) return;
          e.preventDefault();
          let index = slotAt(e.clientX);
          // Moving within the strip: the tab's own slot doesn't count.
          const at = pane.tabs.indexOf(d.id);
          if (at >= 0 && at < index) index--;
          workspace.drop(d.id, pane.id, { index });
        }}
      >
        {pane.tabs.map((t, i) => {
          const s = info[t];
          const on = pane.active === t;
          return (
            <div
              key={t}
              className="ws-tab"
              role="tab"
              aria-selected={on}
              data-slot={slot === i || undefined}
              tabIndex={on ? 0 : -1}
              draggable
              title={s?.title}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ id: t, from: pane.id }));
                e.dataTransfer.setData("text/uri-list", `${location.origin}/app/s/${t}`);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => workspace.activate(pane.id, t)}
              onAuxClick={(e) => {
                if (e.button === 1) workspace.close(pane.id, t);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") workspace.activate(pane.id, t);
                if (e.key === "Delete") workspace.close(pane.id, t);
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  const next = pane.tabs[(i + (e.key === "ArrowRight" ? 1 : pane.tabs.length - 1)) % pane.tabs.length]!;
                  workspace.activate(pane.id, next);
                  window.requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(".ws-tab[aria-selected=true]")?.focus());
                }
              }}
            >
              <StatusIcon status={(s?.status ?? "queued") as RunStatus} pr={s?.pr} size={13} />
              <span className="ws-tab-title">{s?.title ?? "Session"}</span>
              <button
                type="button"
                className="ws-tab-close"
                aria-label={`Close ${s?.title ?? "session"}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  workspace.close(pane.id, t);
                }}
              >
                <X size={12} weight="bold" />
              </button>
            </div>
          );
        })}
        <span className="ws-tab-end" data-slot={slot === pane.tabs.length || undefined} />
        <div className="ws-pane-actions">
          <button type="button" className="icon-btn" aria-label="Split right" title="Split right" onClick={() => workspace.split(pane.id, "right")}>
            <SquareSplitHorizontal size={16} />
          </button>
          <button type="button" className="icon-btn" aria-label="Split down" title="Split down" onClick={() => workspace.split(pane.id, "bottom")}>
            <SquareSplitVertical size={16} />
          </button>
          {many ? (
            <button type="button" className="icon-btn" aria-label="Close pane" title="Close pane" onClick={() => workspace.closePane(pane.id)}>
              <X size={16} />
            </button>
          ) : null}
        </div>
      </div>

      <div
        className="pane-body"
        role="tabpanel"
        onDragOver={(e) => {
          if (!isSessionDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setZone(zoneAt(e, e.currentTarget));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setZone(null);
        }}
        onDrop={(e) => {
          const d = readDrag(e);
          const z = zoneAt(e, e.currentTarget);
          setZone(null);
          if (!d) return;
          e.preventDefault();
          workspace.drop(d.id, pane.id, z === "center" ? {} : { edge: z });
        }}
      >
        {pane.active ? <SessionView key={pane.active} id={pane.active} /> : <EmptyPane pane={pane} />}
      </div>
      {zone ? <div className="ws-drop" data-zone={zone} aria-hidden="true" /> : null}
    </section>
  );
}

/** A pane with nothing in it yet (just split): pick a session, or drag one in. */
function EmptyPane({ pane }: { pane: Pane }) {
  const [recent, setRecent] = useState<{ id: string; title: string; lastStatus: string; prUrl: string | null; repo: string }[] | null>(null);
  useEffect(() => {
    api<{ threads: { id: string; title: string; lastStatus: string; prUrl: string | null; repo: string; archivedAt: string | null }[] }>("/threads")
      .then((r) => setRecent(r.threads.filter((t) => !t.archivedAt).slice(0, 12)))
      .catch(() => setRecent([]));
  }, []);
  const open = new Set(panes(workspace.get().root).flatMap((p) => p.tabs));
  return (
    <div className="ws-empty">
      <h2>Open a session here</h2>
      <p>Pick one, or drag a session from the sidebar or a tab into this pane.</p>
      <ul>
        {(recent ?? []).map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => workspace.drop(t.id, pane.id, {})}>
              <StatusIcon status={t.lastStatus as RunStatus} pr={Boolean(t.prUrl)} size={14} />
              <span className="t">{t.title}</span>
              <span className="dim">{open.has(t.id) ? "Open in another pane" : t.repo.split("/")[1]}</span>
            </button>
          </li>
        ))}
      </ul>
      {recent && recent.length === 0 ? <p className="dim">No sessions yet.</p> : null}
      <Link href="/app" className="btn btn-secondary btn-sm">
        <NotePencil size={15} />
        New session
      </Link>
    </div>
  );
}
