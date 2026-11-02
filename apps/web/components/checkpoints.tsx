"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowCounterClockwise, DotsThree, DownloadSimple, GitFork } from "@phosphor-icons/react";
import { IMPORT_SOURCES, type ImportSource } from "@repo/shared/session-import";
import { api, ApiError, type ThreadSummary, type Turn } from "@/lib/api";
import { HARNESSES, type Harness } from "@/lib/harness";

/** The line at the top of a rewind, fork or import turn. */
export function CheckpointRequest({ turn }: { turn: Turn }) {
  return (
    <div className="msg-system">
      {turn.kind === "rewind" ? <ArrowCounterClockwise size={14} /> : turn.kind === "import" ? <DownloadSimple size={14} /> : <GitFork size={14} />}
      {turn.prompt}
    </div>
  );
}

/** Where a fork came from, above its first turn. */
export function ForkBanner({ forkOf }: { forkOf: { threadId: string; title: string | null; turn: number | null } }) {
  return (
    <div className="fork-banner">
      <GitFork size={14} />
      <span>
        Forked from{" "}
        {forkOf.title ? <Link href={`/app/s/${forkOf.threadId}`}>{forkOf.title}</Link> : "a session that's gone"}
        {forkOf.turn ? ` after turn ${forkOf.turn}` : ""}.
      </span>
    </div>
  );
}

/** Where an imported session came from, above its first turn. */
export function ImportBanner({ imported, harness, settingUp }: { imported: NonNullable<ThreadSummary["imported"]>; harness: string; settingUp: boolean }) {
  const source = IMPORT_SOURCES[imported.source as ImportSource];
  const name = source?.name ?? "another agent";
  const total = imported.turns + imported.dropped;
  return (
    <div className="fork-banner">
      <DownloadSimple size={14} />
      <span>
        Imported from {name}: {total} turn{total === 1 ? "" : "s"}
        {imported.dropped ? `, the most recent ${imported.turns} shown` : ""}.{" "}
        {settingUp
          ? "Setting up its branch and session…"
          : imported.resumed && source?.harness === harness
            ? `${name} carries on in its own session.`
            : "Later turns get this conversation with each message."}
      </span>
    </div>
  );
}

/**
 * A finished turn's menu: rewind the session to just after it, or fork a new
 * session from there (with another agent, if you like).
 */
export function TurnMenu({ threadId, turn, harness, canRewind, rewindNote }: { threadId: string; turn: Turn; harness: string; canRewind: boolean; rewindNote?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState<"menu" | "fork" | null>(null);
  const [agents, setAgents] = useState<Harness[]>(HARNESSES);
  const [agent, setAgent] = useState(harness);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Opens upward unless there isn't room above (the first turns, near the header).
  const [down, setDown] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  useEffect(() => {
    if (open !== "fork") return;
    api<{ harnesses: Harness[] }>("/harnesses").then((r) => r.harnesses.length && setAgents(r.harnesses)).catch(() => {});
  }, [open]);

  async function rewind() {
    if (!window.confirm("Rewind the session to just after this turn? The branch goes back to that point, and the later turns are undone. The pull request is updated.")) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/threads/${threadId}/rewind`, { method: "POST", body: JSON.stringify({ runId: turn.id }) });
      setOpen(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't rewind.");
    } finally {
      setBusy(false);
    }
  }

  async function fork(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>(`/threads/${threadId}/fork`, {
        method: "POST",
        body: JSON.stringify({ runId: turn.id, harness: agent, prompt: prompt.trim() || undefined }),
      });
      router.push(`/app/s/${id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't fork.");
      setBusy(false);
    }
  }

  return (
    <div className="turn-menu" ref={root}>
      <button type="button" className="icon-btn" aria-label="Turn actions" aria-haspopup="menu" aria-expanded={open !== null} onClick={() => {
          setDown((root.current?.getBoundingClientRect().top ?? 1000) < 420);
          setOpen((o) => (o ? null : "menu"));
        }}>
        <DotsThree size={16} weight="bold" />
      </button>
      {open === "menu" ? (
        <div className="menu turn-menu-pop" role="menu" data-down={down || undefined}>
          <button type="button" role="menuitem" disabled={!canRewind || busy} onClick={rewind} title={canRewind ? undefined : rewindNote}>
            <ArrowCounterClockwise size={15} />
            <span>
              Rewind to here
              <span className="dim">{canRewind ? "Undo the turns after this one" : rewindNote}</span>
            </span>
          </button>
          <button type="button" role="menuitem" onClick={() => setOpen("fork")}>
            <GitFork size={15} />
            <span>
              Fork from here
              <span className="dim">A new session from this point</span>
            </span>
          </button>
          {error ? <p className="hint" role="alert" style={{ color: "var(--danger)" }}>{error}</p> : null}
        </div>
      ) : open === "fork" ? (
        <form className="menu turn-menu-pop fork-form" onSubmit={fork} data-down={down || undefined}>
          <strong>Fork from this turn</strong>
          <p className="hint">A new session whose branch starts here, with the conversation so far.</p>
          <label className="label" htmlFor={`fork-agent-${turn.id}`}>
            Agent
          </label>
          <select id={`fork-agent-${turn.id}`} className="select" value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <textarea className="textarea" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What to try instead (optional)" maxLength={8000} aria-label="First message" />
          {error ? <p className="hint" role="alert" style={{ color: "var(--danger)" }}>{error}</p> : null}
          <div className="comment-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              <GitFork size={14} />
              Fork
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
