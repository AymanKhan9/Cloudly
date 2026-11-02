"use client";

import { useMemo } from "react";
import { CaretRight, CheckCircle, CircleNotch, WarningCircle, Wrench, XCircle } from "@phosphor-icons/react";
import type { Turn } from "@/lib/api";
import type { StreamEvent } from "@/lib/events";

type ChecksEvent = { type: "checks"; status: string; command?: string | null } | { type: "checks.gave_up"; reason?: string };

/** The latest checks events of a turn: whether they're running now, and whether Cloudly gave up fixing them. */
function useChecksEvents(events: StreamEvent[]) {
  return useMemo(() => {
    let latest: { status: string; command?: string | null } | null = null;
    let gaveUp: string | null = null;
    for (const e of events) {
      const d = e.data as ChecksEvent | null;
      if (e.kind !== "status" || !d || typeof d !== "object") continue;
      if (d.type === "checks") latest = d;
      if (d.type === "checks.gave_up") gaveUp = d.reason ?? "attempts used up";
    }
    return { latest, gaveUp };
  }, [events]);
}

const LABEL: Record<string, string> = {
  passed: "Checks passed",
  failed: "Checks failed",
  error: "Couldn't run checks",
  skipped: "No checks",
};

/** The checks' result in a turn's footer, live while they run. */
export function ChecksBadge({ turn, events, active }: { turn: Turn; events: StreamEvent[]; active: boolean }) {
  const { latest } = useChecksEvents(events);
  const running = active && latest?.status === "running";
  const status = running ? "running" : turn.checkStatus;
  if (!status || status === "skipped") return null;
  const Icon = status === "running" ? CircleNotch : status === "passed" ? CheckCircle : status === "failed" ? XCircle : WarningCircle;
  return (
    <span className="checks-badge" data-s={status} title={turn.checkCommand ?? latest?.command ?? undefined}>
      <Icon size={13} weight="bold" className={running ? "spin" : undefined} />
      {running ? <span className="shimmer-text">Running checks</span> : LABEL[status]}
      {!running && turn.checkMs ? <span className="num dim">{Math.max(1, Math.round(turn.checkMs / 1000))}s</span> : null}
    </span>
  );
}

/** The checks' output under a turn, and a note when Cloudly stopped trying to fix them. */
export function ChecksDetail({ turn, events }: { turn: Turn; events: StreamEvent[] }) {
  const { gaveUp } = useChecksEvents(events);
  return (
    <>
      {gaveUp ? (
        <div className="notice" data-tone="warn" role="status">
          <WarningCircle size={16} weight="bold" />
          {gaveUp === "attempts used up"
            ? "The checks still fail after the fix attempts. The session is waiting for you: reply with what to do."
            : `The checks fail, and no fix was attempted: ${gaveUp}.`}
        </div>
      ) : null}
      {turn.checkOutput && (turn.checkStatus === "failed" || turn.checkStatus === "error") ? (
        <details className="disclosure checks-out">
          <summary>
            <CaretRight size={12} weight="bold" />
            Check output
            {turn.checkCommand ? <code className="mono dim">{turn.checkCommand.split("\n")[0]}</code> : null}
          </summary>
          <pre className="mono">{turn.checkOutput}</pre>
        </details>
      ) : null}
    </>
  );
}

/** A turn Cloudly started itself, to fix failing checks: shown as Cloudly's, not the user's. */
export function FixRequest({ turn, agent }: { turn: Turn; agent: string }) {
  const title = turn.prompt.split("\n")[0] ?? "";
  const attempt = /attempt (\d+) of (\d+)/.exec(title);
  return (
    <details className="msg-system">
      <summary>
        <Wrench size={14} />
        Cloudly asked {agent} to fix the failing checks{attempt ? ` (attempt ${attempt[1]} of ${attempt[2]})` : ""}
        <CaretRight size={12} weight="bold" className="chev" />
      </summary>
      <pre className="mono">{turn.prompt}</pre>
    </details>
  );
}

