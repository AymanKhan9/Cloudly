"use client";

import { CaretRight, GitDiff, MagnifyingGlass, Wrench } from "@phosphor-icons/react";
import type { Turn } from "@/lib/api";
import type { StreamEvent } from "@/lib/events";

/** The line at the top of a turn Cloudly started for the reviewer, or for the author to fix what it found. */
export function ReviewRequest({ turn, agent, reviewer }: { turn: Turn; agent: string; reviewer: string }) {
  if (turn.kind === "review") {
    return (
      <div className="msg-system">
        <MagnifyingGlass size={14} />
        {reviewer} reviews the changes
      </div>
    );
  }
  const round = /round (\d+) of (\d+)/.exec(turn.prompt.split("\n")[0] ?? "");
  return (
    <details className="msg-system">
      <summary>
        <Wrench size={14} />
        Cloudly sent the blocking findings to {agent}
        {round ? ` (round ${round[1]} of ${round[2]})` : ""}
        <CaretRight size={12} weight="bold" className="chev" />
      </summary>
      <pre className="mono">{turn.prompt}</pre>
    </details>
  );
}

/** What a review or audit found, under its turn, with the way to act on it. */
export function ReviewResult({ turn, events, onOpen }: { turn: Turn; events: StreamEvent[]; onOpen: () => void }) {
  if (turn.status !== "succeeded" || !turn.output) return null;
  const status = events.find((e) => e.kind === "status" && ["review", "audit"].includes((e.data as { type?: string } | null)?.type ?? ""));
  const c = (status?.data ?? {}) as { blocking?: number; suggestions?: number; nits?: number };
  const counts = typeof c.blocking === "number" ? c : (() => {
    const m = /(\d+) blocking, (\d+) suggestions?, (\d+) nits?/.exec(turn.output);
    return m ? { blocking: Number(m[1]), suggestions: Number(m[2]), nits: Number(m[3]) } : null;
  })();
  const total = counts ? (counts.blocking ?? 0) + (counts.suggestions ?? 0) + (counts.nits ?? 0) : 0;
  const posted = events.find((e) => (e.data as { type?: string } | null)?.type === "review.posted")?.data as { url?: string } | undefined;
  const fixing = events.some((e) => (e.data as { type?: string } | null)?.type === "review.fix");
  return (
    <div className="review-result" data-clean={total === 0 || undefined}>
      <div className="review-counts">
        {total === 0 ? (
          <span>Nothing to fix.</span>
        ) : (
          <>
            {counts!.blocking ? <span className="sev" data-severity="blocking">{counts!.blocking} blocking</span> : null}
            {counts!.suggestions ? <span className="sev" data-severity="suggestion">{counts!.suggestions} suggestion{counts!.suggestions === 1 ? "" : "s"}</span> : null}
            {counts!.nits ? <span className="sev" data-severity="nit">{counts!.nits} nit{counts!.nits === 1 ? "" : "s"}</span> : null}
          </>
        )}
        <span className="spacer" />
        {posted?.url ? (
          <a href={posted.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
            On the pull request
          </a>
        ) : null}
        {total > 0 ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onOpen}>
            <GitDiff size={14} />
            {turn.kind === "audit" ? "Pick findings to fix" : "Open in Changes"}
          </button>
        ) : null}
      </div>
      {fixing ? <p className="hint">The blocking findings went back to the agent automatically.</p> : null}
    </div>
  );
}
