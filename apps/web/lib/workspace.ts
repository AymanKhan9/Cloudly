"use client";

import { useSyncExternalStore } from "react";

/**
 * Sessions open side by side: a tree of splits, each leaf a pane with tabs.
 * Kept in this browser (localStorage), like an editor's open files.
 */
export type Pane = { kind: "pane"; id: string; tabs: string[]; active: string | null };
export type Split = { kind: "split"; id: string; dir: "row" | "column"; children: Node[]; sizes: number[] };
export type Node = Pane | Split;
export type Edge = "left" | "right" | "top" | "bottom";

export interface Layout {
  root: Node;
  focus: string;
}

const KEY = "cloudly.workspace.v1";
let seq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const emptyPane = (): Pane => ({ kind: "pane", id: newId("p"), tabs: [], active: null });

function fresh(): Layout {
  const pane = emptyPane();
  return { root: pane, focus: pane.id };
}

function valid(n: unknown): n is Node {
  const x = n as Node;
  if (!x || typeof x !== "object" || typeof x.id !== "string") return false;
  if (x.kind === "pane") return Array.isArray(x.tabs) && x.tabs.every((t) => typeof t === "string");
  return x.kind === "split" && (x.dir === "row" || x.dir === "column") && Array.isArray(x.children) && x.children.every(valid) && Array.isArray(x.sizes) && x.sizes.length === x.children.length;
}

function load(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && valid(raw.root) && typeof raw.focus === "string") return normalize(raw);
  } catch {}
  return fresh();
}

let layout: Layout | null = null;
const listeners = new Set<() => void>();

function current(): Layout {
  if (!layout) layout = typeof window === "undefined" ? fresh() : load();
  return layout;
}

function commit(next: Layout) {
  layout = normalize(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {}
  for (const l of listeners) l();
}

// ---------- Tree helpers ----------

export function panes(n: Node, out: Pane[] = []): Pane[] {
  if (n.kind === "pane") out.push(n);
  else for (const c of n.children) panes(c, out);
  return out;
}

function mapTree(n: Node, f: (n: Node) => Node): Node {
  const m = f(n);
  return m.kind === "split" ? { ...m, children: m.children.map((c) => mapTree(c, f)) } : m;
}

function findPaneOf(root: Node, tab: string): Pane | undefined {
  return panes(root).find((p) => p.tabs.includes(tab));
}

/** Drops empty panes (keeping one), splits of one, and nests of the same direction. */
export function normalize(l: Layout): Layout {
  const clean = (n: Node): Node | null => {
    if (n.kind === "pane") return n;
    const kept: { node: Node; size: number }[] = [];
    n.children.forEach((c, i) => {
      const cc = clean(c);
      if (!cc) return;
      if (cc.kind === "pane" && cc.tabs.length === 0 && cc.id !== l.focus) return;
      const size = n.sizes[i] ?? 1;
      // A same-direction child splits this one's share among its own children.
      if (cc.kind === "split" && cc.dir === n.dir) {
        const total = cc.sizes.reduce((a, b) => a + b, 0) || 1;
        cc.children.forEach((g, j) => kept.push({ node: g, size: (size * (cc.sizes[j] ?? 1)) / total }));
      } else kept.push({ node: cc, size });
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]!.node;
    const total = kept.reduce((a, k) => a + k.size, 0) || 1;
    return { ...n, children: kept.map((k) => k.node), sizes: kept.map((k) => k.size / total) };
  };
  // An empty pane among others stays only while it's focused (just split, waiting for a session).
  let root = clean(l.root) ?? emptyPane();
  const list = panes(root);
  const focus = list.some((p) => p.id === l.focus) ? l.focus : list[0]!.id;
  // Each pane's active tab is one of its tabs.
  root = mapTree(root, (n) => (n.kind === "pane" && (!n.active || !n.tabs.includes(n.active)) ? { ...n, active: n.tabs[0] ?? null } : n));
  return { root, focus };
}

/** Puts `node` beside `target` on `edge`, splitting where needed. */
function insertBeside(root: Node, targetId: string, edge: Edge, node: Node): Node {
  const dir = edge === "left" || edge === "right" ? "row" : "column";
  const before = edge === "left" || edge === "top";
  const visit = (n: Node, parent: Split | null): Node => {
    if (n.id === targetId) {
      return { kind: "split", id: newId("s"), dir, children: before ? [node, n] : [n, node], sizes: [0.5, 0.5] };
    }
    if (n.kind === "split") {
      // Beside a child of a split in the same direction: a new sibling, sharing that child's room.
      const i = n.children.findIndex((c) => c.id === targetId);
      if (i >= 0 && n.dir === dir) {
        const children = [...n.children];
        const sizes = [...n.sizes];
        const half = (sizes[i] ?? 1) / 2;
        sizes[i] = half;
        children.splice(before ? i : i + 1, 0, node);
        sizes.splice(before ? i : i + 1, 0, half);
        return { ...n, children, sizes };
      }
      return { ...n, children: n.children.map((c) => visit(c, n)) };
    }
    return n;
  };
  return visit(root, null);
}

function withoutTab(root: Node, tab: string): Node {
  return mapTree(root, (n) => (n.kind === "pane" && n.tabs.includes(tab) ? { ...n, tabs: n.tabs.filter((t) => t !== tab) } : n));
}

// ---------- Actions ----------

export const workspace = {
  get: current,

  /** Shows a session: where it's already open, else as a tab in the focused pane. */
  open(id: string) {
    const l = current();
    const where = findPaneOf(l.root, id);
    if (where) {
      if (where.active === id && l.focus === where.id) return;
      commit({ root: mapTree(l.root, (n) => (n.id === where.id ? { ...where, active: id } : n)), focus: where.id });
      return;
    }
    commit({
      root: mapTree(l.root, (n) => (n.id === l.focus && n.kind === "pane" ? { ...n, tabs: [...n.tabs, id], active: id } : n)),
      focus: l.focus,
    });
  },

  /** A tab for starting a new session in this pane ("new:…" until the session exists). */
  newTab(paneId: string) {
    const l = current();
    const tab = `${NEW_TAB}${newId("")}`;
    commit({ root: mapTree(l.root, (n) => (n.id === paneId && n.kind === "pane" ? { ...n, tabs: [...n.tabs, tab], active: tab } : n)), focus: paneId });
  },

  /** A tab becomes another: a new-session tab, the session it started. */
  replace(paneId: string, from: string, to: string) {
    const l = current();
    commit({
      root: mapTree(withoutTab(l.root, to), (n) => (n.id === paneId && n.kind === "pane" ? { ...n, tabs: n.tabs.map((t) => (t === from ? to : t)), active: to } : n)),
      focus: paneId,
    });
  },

  /** Opens a session in a new pane beside the focused one. */
  openBeside(id: string, edge: Edge = "right") {
    const l = current();
    const pane: Pane = { kind: "pane", id: newId("p"), tabs: [id], active: id };
    const root = insertBeside(withoutTab(l.root, id), l.focus, edge, pane);
    commit({ root, focus: pane.id });
  },

  focus(paneId: string) {
    const l = current();
    if (l.focus !== paneId) commit({ ...l, focus: paneId });
  },

  activate(paneId: string, id: string) {
    const l = current();
    commit({ root: mapTree(l.root, (n) => (n.id === paneId && n.kind === "pane" ? { ...n, active: id } : n)), focus: paneId });
  },

  close(paneId: string, id: string) {
    const l = current();
    const root = mapTree(l.root, (n) => {
      if (n.id !== paneId || n.kind !== "pane") return n;
      const i = n.tabs.indexOf(id);
      const tabs = n.tabs.filter((t) => t !== id);
      // Closing the shown tab shows its neighbour, as a browser does.
      const active = n.active === id ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : n.active;
      return { ...n, tabs, active };
    });
    // A pane's last tab closed: the pane goes too (when there are others), and focus moves on.
    const emptied = panes(root).find((p) => p.id === paneId)?.tabs.length === 0;
    const other = panes(root).find((p) => p.id !== paneId && p.tabs.length);
    commit({ root, focus: emptied && other ? other.id : l.focus });
  },

  /** Removes a pane and its tabs. */
  closePane(paneId: string) {
    const l = current();
    const all = panes(l.root);
    if (all.length <= 1) return;
    const others = all.filter((p) => p.id !== paneId);
    const root = mapTree(l.root, (n) => (n.id === paneId && n.kind === "pane" ? { ...n, tabs: [], active: null } : n));
    commit({ root, focus: l.focus === paneId ? others[0]!.id : l.focus });
  },

  /** An empty pane beside this one, for picking or dropping a session into. */
  split(paneId: string, edge: Edge) {
    const l = current();
    const pane = emptyPane();
    commit({ root: insertBeside(l.root, paneId, edge, pane), focus: pane.id });
  },

  /** A tab dropped on a pane: into it (at an index), or beside it on an edge. */
  drop(id: string, targetPane: string, where: { edge?: Edge; index?: number }) {
    const l = current();
    if (where.edge) {
      const from = findPaneOf(l.root, id);
      // Splitting a pane with its only tab: nothing would move.
      if (from && from.id === targetPane && from.tabs.length === 1) return;
      const pane: Pane = { kind: "pane", id: newId("p"), tabs: [id], active: id };
      commit({ root: insertBeside(withoutTab(l.root, id), targetPane, where.edge, pane), focus: pane.id });
      return;
    }
    const removed = withoutTab(l.root, id);
    commit({
      root: mapTree(removed, (n) => {
        if (n.id !== targetPane || n.kind !== "pane") return n;
        const tabs = [...n.tabs];
        tabs.splice(where.index ?? tabs.length, 0, id);
        return { ...n, tabs, active: id };
      }),
      focus: targetPane,
    });
  },

  resize(splitId: string, sizes: number[]) {
    const l = current();
    layout = { ...l, root: mapTree(l.root, (n) => (n.id === splitId && n.kind === "split" ? { ...n, sizes } : n)) };
    for (const fn of listeners) fn();
  },

  /** Saves after a resize drag ends (not on every move). */
  persist() {
    commit(current());
  },

  /** Forgets a session everywhere (deleted, or not found). */
  forget(id: string) {
    const l = current();
    const root = withoutTab(l.root, id);
    const focused = panes(root).find((p) => p.id === l.focus);
    const other = panes(root).find((p) => p.tabs.length);
    commit({ root, focus: focused?.tabs.length || !other ? l.focus : other.id });
  },
};

export function useWorkspace(): Layout {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    current,
    () => SERVER,
  );
}
const SERVER = fresh();

/** A tab that's a new-session form, not a session yet. */
export const NEW_TAB = "new:";
export const isNewTab = (id: string | null | undefined) => Boolean(id?.startsWith(NEW_TAB));

/** The session shown in the focused pane. */
export function focusedSession(l: Layout): string | null {
  return panes(l.root).find((p) => p.id === l.focus)?.active ?? null;
}

// ---------- Session titles, shared with the sidebar's list ----------

export interface SessionInfo {
  title: string;
  status?: string;
  pr?: boolean;
}
let titles: Record<string, SessionInfo> = {};
const titleListeners = new Set<() => void>();

export function setSessionInfo(list: { id: string; title: string; lastStatus?: string; prUrl?: string | null }[]) {
  const next = { ...titles };
  let changed = false;
  for (const t of list) {
    const info = { title: t.title, status: t.lastStatus, pr: Boolean(t.prUrl) };
    const old = next[t.id];
    if (!old || old.title !== info.title || old.status !== info.status || old.pr !== info.pr) {
      next[t.id] = info;
      changed = true;
    }
  }
  if (!changed) return;
  titles = next;
  for (const l of titleListeners) l();
}

export function useSessionInfo(): Record<string, SessionInfo> {
  return useSyncExternalStore(
    (fn) => {
      titleListeners.add(fn);
      return () => titleListeners.delete(fn);
    },
    () => titles,
    () => titles,
  );
}

/** The drag payload for a session (a tab, or an item from the sidebar). */
export const DRAG_TYPE = "application/x-cloudly-session";
