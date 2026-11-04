"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive, ArrowSquareOut, BellSimpleZ, CaretDown, CaretRight, ChatsCircle, CheckCircle, Copy, Envelope, EnvelopeOpen,
  Funnel, GitBranch, GitPullRequest, Hash, LinkSimple, NotePencil, PencilSimpleLine, PushPin, PushPinSlash, Trash,
  SquareSplitHorizontal, SquareSplitVertical, UsersThree, X,
} from "@phosphor-icons/react";
import { api, ApiError, type CouncilSummary, type ThreadSummary } from "@/lib/api";
import { harnessById, relativeTime } from "@/lib/harness";
import { StatusIcon } from "./status";
import { DRAG_TYPE, setSessionInfo, workspace } from "@/lib/workspace";
import { ContextMenu, copyText, sessionReference, type MenuItem } from "./session-menu";

// The sidebar's sessions, with T3 Code's thread actions on right-click: pin,
// settle, snooze, rename, mark unread, filter by repo, copy, archive, delete.
// A session whose agent asked a question (ask_user) shows "Needs you"; one with
// a turn the user hasn't seen shows a dot.

const DAY = 86_400_000;

function groupOf(iso: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t = new Date(iso).getTime();
  if (t >= start.getTime()) return "Today";
  if (t >= start.getTime() - DAY) return "Yesterday";
  if (t >= start.getTime() - 7 * DAY) return "Previous 7 days";
  return "Older";
}

/** Snooze choices, as times on the user's own clock. */
function snoozeTimes(now = new Date()): { label: string; at: Date }[] {
  const at9 = (d: Date) => {
    const x = new Date(d);
    x.setHours(9, 0, 0, 0);
    return x;
  };
  const tomorrow = at9(new Date(now.getTime() + DAY));
  const monday = at9(new Date(now.getTime() + (((8 - now.getDay()) % 7 || 7) * DAY)));
  return [
    { label: "For an hour", at: new Date(now.getTime() + 3_600_000) },
    { label: "Until tomorrow, 9:00", at: tomorrow },
    { label: "Until Monday, 9:00", at: monday },
  ];
}

const until = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

const WORKING = ["queued", "running", "finalizing"];

type Section = "working" | "snoozed" | "settled" | "archived";

function DeleteDialog({ thread, onClose, onDeleted }: { thread: ThreadSummary; onClose: () => void; onDeleted: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => ref.current?.showModal(), []);
  async function remove() {
    setBusy(true);
    try {
      await api(`/threads/${thread.id}`, { method: "DELETE" });
      onDeleted();
      ref.current?.close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete it.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog ref={ref} className="agent-dialog confirm-dialog" onClose={onClose} aria-labelledby="del-h">
      <div className="agent-dialog-body">
        <h2 id="del-h">Delete &ldquo;{thread.title}&rdquo;?</h2>
        <p className="hint">
          Its conversation and turns are deleted for good. Its branch <span className="mono">{thread.branch}</span>
          {thread.prUrl ? " and its pull request stay" : " stays"} on GitHub. To keep it but hide it, archive it instead.
        </p>
        {error ? <p className="hint" style={{ color: "var(--danger)" }}>{error}</p> : null}
      </div>
      <footer className="form-foot agent-dialog-foot">
        <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
          {busy ? "Deleting" : "Delete session"}
        </button>
      </footer>
    </dialog>
  );
}

function Row({
  t,
  pathname,
  renaming,
  onRenamed,
  onMenu,
}: {
  t: ThreadSummary;
  pathname: string;
  renaming: boolean;
  onRenamed: (title: string | null) => void;
  onMenu: (t: ThreadSummary, at: { x: number; y: number }, from: HTMLElement) => void;
}) {
  const href = `/app/s/${t.id}`;
  const [title, setTitle] = useState(t.title);
  if (renaming) {
    return (
      <form
        className="rail-item rail-rename"
        onSubmit={(e) => {
          e.preventDefault();
          onRenamed(title.trim() || null);
        }}
      >
        <PencilSimpleLine size={15} />
        <input
          className="input"
          value={title}
          autoFocus
          maxLength={120}
          aria-label="Session title"
          onChange={(e) => setTitle(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => onRenamed(title.trim() || null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onRenamed(null);
          }}
        />
      </form>
    );
  }
  const where = `${t.repo ? t.repo.split("/")[1] : "No project"} · ${harnessById(t.harness).name}${t.arenaId ? " in an arena" : ""}`;
  return (
    <Link
      href={href}
      className="rail-item"
      aria-current={pathname === href ? "page" : undefined}
      aria-haspopup="menu"
      data-unread={t.unread || t.needsInput ? true : undefined}
      onDragStart={(e) => {
        // Into a pane of the workspace: drop on its middle to open there, on an edge to split.
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ id: t.id }));
        e.dataTransfer.effectAllowed = "copyMove";
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const from = e.currentTarget;
        // Shift+F10 or the menu key: no pointer position, so open beside the item.
        const r = from.getBoundingClientRect();
        onMenu(t, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 24, y: r.bottom }, from);
      }}
    >
      <StatusIcon status={t.lastStatus} pr={Boolean(t.prUrl)} size={15} />
      <span className="t">{t.title}</span>
      {t.needsInput ? (
        <span className="rail-badge" title={t.needsInput}>
          Needs you
        </span>
      ) : t.unread ? (
        <span className="rail-dot" title="New since you last looked">
          <span className="visually-hidden">Unread</span>
        </span>
      ) : (
        <span />
      )}
      <span className="m">
        {t.pinnedAt ? <PushPin size={11} weight="fill" aria-label="Pinned" /> : null}
        {t.snoozed && t.snoozedUntil ? `Snoozed until ${until(t.snoozedUntil)} · ${where}` : `${where}, ${relativeTime(t.updatedAt)}`}
      </span>
    </Link>
  );
}

export function SessionList({ pathname }: { pathname: string }) {
  const router = useRouter();
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [councils, setCouncils] = useState<CouncilSummary[]>([]);
  const [menu, setMenu] = useState<{ thread: ThreadSummary; at: { x: number; y: number }; from: HTMLElement } | null>(null);
  const [said, setSaid] = useState("");
  const saidTimer = useRef<number | undefined>(undefined);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ThreadSummary | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<Section, boolean>>({ working: true, snoozed: false, settled: false, archived: false });

  const load = useCallback(() => {
    api<{ councils: CouncilSummary[] }>("/councils").then((r) => setCouncils(r.councils)).catch(() => {});
    return api<{ threads: ThreadSummary[] }>("/threads")
      .then((r) => {
        setThreads(r.threads);
        setSessionInfo(r.threads);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 4000);
    return () => window.clearInterval(timer);
  }, [load]);

  const say = (message: string) => {
    setSaid(message);
    window.clearTimeout(saidTimer.current);
    saidTimer.current = window.setTimeout(() => setSaid(""), 2200);
  };

  const closeMenu = useCallback(
    (message?: string) => {
      menu?.from.focus();
      setMenu(null);
      if (message) say(message);
    },
    [menu],
  );

  /** Saves a change, showing it at once and putting it back if the save fails. */
  async function update(t: ThreadSummary, body: Record<string, unknown>, local: Partial<ThreadSummary>, message?: string) {
    setThreads((list) => list?.map((x) => (x.id === t.id ? { ...x, ...local } : x)) ?? list);
    try {
      await api(`/threads/${t.id}`, { method: "PATCH", body: JSON.stringify(body) });
      if (message) say(message);
    } catch (err) {
      say(err instanceof ApiError ? err.message : "Couldn't save that.");
    }
    load();
  }

  function itemsFor(t: ThreadSummary): MenuItem[] {
    const now = new Date().toISOString();
    const link = () => `${window.location.origin}/app/s/${t.id}`;
    const copy = (text: () => string) => () => void copyText(text());
    const short = t.repo ? t.repo.split("/")[1] ?? t.repo : "No project";
    return [
      { kind: "action", label: `New session on ${short}`, icon: <NotePencil size={15} />, run: () => router.push(`/app?repo=${encodeURIComponent(t.repo)}&branch=${encodeURIComponent(t.baseBranch)}`) },
      t.pinnedAt
        ? { kind: "action", label: "Unpin", icon: <PushPinSlash size={15} />, run: () => update(t, { pinned: false }, { pinnedAt: null }) }
        : { kind: "action", label: "Pin", icon: <PushPin size={15} />, run: () => update(t, { pinned: true }, { pinnedAt: now }, "Pinned to the top") },
      t.settledAt
        ? { kind: "action", label: "Unsettle", icon: <CheckCircle size={15} />, run: () => update(t, { settled: false }, { settledAt: null }) }
        : { kind: "action", label: "Settle", icon: <CheckCircle size={15} />, run: () => update(t, { settled: true }, { settledAt: now }, "Settled. New activity brings it back") },
      {
        kind: "submenu",
        label: "Snooze",
        icon: <BellSimpleZ size={15} />,
        items: [
          ...snoozeTimes().map((s): MenuItem => ({
            kind: "action",
            label: s.label,
            icon: <BellSimpleZ size={15} />,
            run: () => update(t, { snoozeUntil: s.at.toISOString() }, { snoozedUntil: s.at.toISOString(), snoozed: true }, `Snoozed until ${until(s.at.toISOString())}`),
          })),
          ...(t.snoozed ? [{ kind: "action" as const, label: "Wake it now", icon: <BellSimpleZ size={15} />, run: () => update(t, { snoozeUntil: null }, { snoozedUntil: null, snoozed: false }) }] : []),
        ],
      },
      { kind: "separator" },
      { kind: "action", label: "Rename", icon: <PencilSimpleLine size={15} />, run: () => setRenaming(t.id) },
      t.unread
        ? { kind: "action", label: "Mark as read", icon: <EnvelopeOpen size={15} />, run: () => update(t, { seen: true }, { unread: false }) }
        : { kind: "action", label: "Mark unread", icon: <Envelope size={15} />, run: () => update(t, { seen: false }, { unread: true }) },
      repo === t.repo
        ? { kind: "action", label: "Show every repo", icon: <Funnel size={15} />, run: () => setRepo(null) }
        : { kind: "action", label: `Show only ${short}`, icon: <Funnel size={15} />, run: () => setRepo(t.repo) },
      { kind: "separator" },
      {
        kind: "action",
        label: "Open to the side",
        icon: <SquareSplitHorizontal size={15} />,
        run: () => {
          workspace.openBeside(t.id, "right");
          router.push(`/app/s/${t.id}`);
        },
      },
      {
        kind: "action",
        label: "Open below",
        icon: <SquareSplitVertical size={15} />,
        run: () => {
          workspace.openBeside(t.id, "bottom");
          router.push(`/app/s/${t.id}`);
        },
      },
      { kind: "action", label: "Open in a new browser tab", icon: <ArrowSquareOut size={15} />, run: () => window.open(link(), "_blank", "noopener") },
      ...(t.prUrl ? [{ kind: "action" as const, label: "Open pull request", icon: <GitPullRequest size={15} />, run: () => window.open(t.prUrl!, "_blank", "noopener,noreferrer") }] : []),
      {
        kind: "submenu",
        label: "Copy",
        icon: <Copy size={15} />,
        items: [
          { kind: "action", label: "Link", icon: <LinkSimple size={15} />, run: copy(link), done: "Copied the session's link" },
          { kind: "action", label: "Branch", icon: <GitBranch size={15} />, run: copy(() => t.branch), done: `Copied ${t.branch}` },
          { kind: "action", label: "Session", icon: <ChatsCircle size={15} />, run: copy(() => sessionReference(t)), done: "Copied a reference to paste into another session" },
          { kind: "action", label: "Session ID", icon: <Hash size={15} />, run: copy(() => t.id), done: "Copied the session's id" },
        ],
      },
      { kind: "separator" },
      t.archivedAt
        ? { kind: "action", label: "Unarchive", icon: <Archive size={15} />, run: () => update(t, { archived: false }, { archivedAt: null }, "Back in the list") }
        : { kind: "action", label: "Archive", icon: <Archive size={15} />, run: () => update(t, { archived: true }, { archivedAt: now }, "Archived. Other sessions can't reach it") },
      { kind: "action", label: "Delete", icon: <Trash size={15} />, danger: true, run: () => setDeleting(t) },
    ];
  }

  if (threads === null)
    return (
      <div style={{ display: "grid", gap: 14, padding: "18px 10px" }} aria-busy="true">
        {[70, 55, 80, 60].map((w) => (
          <div key={w} className="skeleton" style={{ width: `${w}%` }} />
        ))}
      </div>
    );

  if (threads.length === 0 && councils.length === 0) return <p className="rail-empty">Your sessions show up here. Start one to hand the agent its first task.</p>;

  const shown = repo ? threads.filter((t) => t.repo === repo) : threads;
  const archived = shown.filter((t) => t.archivedAt);
  const live = shown.filter((t) => !t.archivedAt);
  const snoozed = live.filter((t) => t.snoozed);
  // Sessions with a turn under way, together at the top, as in T3 Code.
  const working = live.filter((t) => WORKING.includes(t.lastStatus));
  const awake = live.filter((t) => !t.snoozed && !WORKING.includes(t.lastStatus));
  // A session that needs the user stays in view even if it was settled.
  const settled = awake.filter((t) => t.settledAt && !t.needsInput);
  const pinned = awake.filter((t) => t.pinnedAt && !(t.settledAt && !t.needsInput));
  const rest = awake.filter((t) => !t.pinnedAt && !(t.settledAt && !t.needsInput));

  // Sessions and councils, newest first.
  const items = [
    ...rest.map((t) => ({ kind: "thread" as const, at: t.updatedAt, t })),
    ...(repo ? councils.filter((c) => c.repo === repo) : councils).map((c) => ({ kind: "council" as const, at: c.updatedAt, c })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const row = (t: ThreadSummary) => (
    <Row
      key={t.id}
      t={t}
      pathname={pathname}
      renaming={renaming === t.id}
      onRenamed={(title) => {
        setRenaming(null);
        if (title && title !== t.title) update(t, { title }, { title }, "Renamed");
      }}
      onMenu={(thread, at, from) => setMenu({ thread, at, from })}
    />
  );

  const fold = (key: Section, label: string, list: ThreadSummary[], always = false) =>
    list.length || always ? (
      <div className="rail-fold" key={key}>
        <button type="button" className="rail-group rail-fold-head" aria-expanded={open[key]} onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
          {open[key] ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
          {label}
          <span className="num">{list.length}</span>
        </button>
        {open[key] ? list.map(row) : null}
      </div>
    ) : null;

  let last = "";
  return (
    <>
      {repo ? (
        <div className="rail-filter">
          <Funnel size={13} />
          <span className="mono">{repo}</span>
          <button type="button" className="icon-btn" onClick={() => setRepo(null)} aria-label="Show every repo" title="Show every repo">
            <X size={13} />
          </button>
        </div>
      ) : null}
      {fold("working", "Working", working)}
      {pinned.length ? (
        <>
          <div className="rail-group">Pinned</div>
          {pinned.map(row)}
        </>
      ) : null}
      {items.map((item) => {
        const at = item.kind === "thread" ? item.t.updatedAt : item.c.updatedAt;
        const group = groupOf(at);
        const head = group !== last ? <div className="rail-group">{(last = group)}</div> : null;
        if (item.kind === "council") {
          const c = item.c;
          const href = `/app/council/${c.id}`;
          return (
            <div key={c.id}>
              {head}
              <Link href={href} className="rail-item" aria-current={pathname === href ? "page" : undefined}>
                {c.status === "running" ? <StatusIcon status="running" size={15} /> : <UsersThree size={15} style={{ color: c.status === "done" ? "var(--ok)" : "var(--text-3)" }} />}
                <span className="t">{c.question}</span>
                <span />
                <span className="m">
                  Council of {c.members.length}
                  {c.repo ? ` · ${c.repo.split("/")[1]}` : ", web research"}, {relativeTime(c.updatedAt)}
                </span>
              </Link>
            </div>
          );
        }
        return (
          <div key={item.t.id}>
            {head}
            {row(item.t)}
          </div>
        );
      })}
      {fold("snoozed", "Snoozed", snoozed)}
      {fold("settled", "Settled", settled, true)}
      {fold("archived", "Archived", archived)}
      {menu ? <ContextMenu items={itemsFor(menu.thread)} at={menu.at} label={`${menu.thread.title}: actions`} onClose={closeMenu} /> : null}
      {deleting ? (
        <DeleteDialog
          thread={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            say("Deleted");
            // Its tab closes; the workspace moves on to another session, or a new one.
            workspace.forget(deleting.id);
            load();
          }}
        />
      ) : null}
      <div className="ctx-said" role="status" aria-live="polite" data-show={said ? true : undefined}>
        {said}
      </div>
    </>
  );
}
