"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import Markdown from "react-markdown";
import { useCallback, useEffect, useState } from "react";
import { ArrowSquareOut, CloudSlash, GitBranch, GitPullRequest, GithubLogo, Trophy, WarningCircle } from "@phosphor-icons/react";
import { api, ApiError, type ArenaEntry, type ArenaView } from "@/lib/api";
import { harnessById, STATUS_LABEL, usd, type RunStatus } from "@/lib/harness";
import { AgentLogo } from "@/components/agent-logo";
import { StatusIcon } from "@/components/status";

const ACTIVE: RunStatus[] = ["queued", "running", "finalizing"];

function duration(ms: number | null) {
  if (ms === null) return "-";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function Entry({
  entry,
  arena,
  best,
  onPick,
  picking,
}: {
  entry: ArenaEntry;
  arena: ArenaView["arena"];
  best: { cost: boolean; time: boolean; small: boolean };
  onPick: () => void;
  picking: boolean;
}) {
  const h = harnessById(entry.thread.harness);
  const r = entry.result;
  const active = r ? ACTIVE.includes(r.latestStatus) : true;
  const winner = arena.winnerThreadId === entry.thread.id;
  const compareUrl = `https://github.com/${arena.repo}/compare/${encodeURIComponent(arena.baseBranch)}...${encodeURIComponent(entry.thread.branch)}`;
  const status = r ? (r.cancelRequested && active ? "Cancelling" : r.status === "succeeded" && !r.filesChanged ? "Done, no changes" : r.status === "succeeded" ? "Done" : STATUS_LABEL[r.status]) : "Queued";

  return (
    <article className="arena-card" data-winner={winner || undefined}>
      <header>
        <AgentLogo harness={entry.thread.harness} size={18} />
        <h2>{h.name}</h2>
        {winner ? (
          <span className="arena-badge">
            <Trophy size={13} weight="fill" />
            Picked
          </span>
        ) : null}
        <span className="spacer" />
        <span className="status">
          <StatusIcon status={r?.latestStatus ?? "queued"} size={14} />
          {status}
        </span>
      </header>

      <dl className="arena-stats">
        <div data-best={best.cost || undefined}>
          <dt>Cost</dt>
          <dd className="num" title={r?.onPlan ? "On your plan" : h.cost === "estimated" ? "Estimated from token counts" : "Reported by the agent"}>
            {r?.onPlan ? "Plan" : r ? usd(r.costUsd, h.cost === "estimated") : "-"}
          </dd>
        </div>
        <div data-best={best.time || undefined}>
          <dt>Time</dt>
          <dd className="num">{duration(r?.durationMs ?? null)}</dd>
        </div>
        <div data-best={best.small || undefined}>
          <dt>Changes</dt>
          <dd className="num">
            {r?.filesChanged ? (
              <>
                <span className="add">+{r.additions}</span> <span className="del">−{r.deletions}</span>
                <small className="dim">
                  {r.filesChanged} file{r.filesChanged === 1 ? "" : "s"}
                </small>
              </>
            ) : active ? (
              "-"
            ) : (
              "None"
            )}
          </dd>
        </div>
      </dl>

      {r?.error ? (
        <div className="notice" data-tone="danger">
          <WarningCircle size={16} weight="bold" />
          {r.error}
        </div>
      ) : null}

      <div className="arena-summary reply">
        {r?.summary ? <Markdown>{r.summary}</Markdown> : <p className="hint">{active ? "Working on it." : "No summary from the agent."}</p>}
      </div>

      <footer>
        <Link href={`/app/s/${entry.thread.id}`} className="btn btn-secondary btn-sm">
          Open session{entry.turns > 1 ? ` (${entry.turns} turns)` : ""}
        </Link>
        {entry.pushed ? (
          <a href={compareUrl} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
            <GitBranch size={14} />
            Diff on GitHub
            <ArrowSquareOut size={12} />
          </a>
        ) : null}
        <span className="spacer" />
        {entry.thread.prUrl ? (
          <a href={entry.thread.prUrl} target="_blank" rel="noreferrer" className="pr-chip">
            <GitPullRequest size={14} weight="bold" />
            Pull request
            <ArrowSquareOut size={12} />
          </a>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" disabled={!entry.pushed || active || picking} onClick={onPick} title={entry.pushed ? "Open this agent's branch as the pull request" : "Nothing to open: this agent changed no files"}>
            <Trophy size={14} />
            Pick and open PR
          </button>
        )}
      </footer>
    </article>
  );
}

export default function ArenaPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<ArenaView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const load = useCallback(() => api<ArenaView>(`/arenas/${id}`).then(setView), [id]);

  useEffect(() => {
    setView(null);
    load().catch((e: Error) => setError(e instanceof ApiError && e.status === 404 ? "This arena doesn't exist, or it belongs to someone else." : e.message));
  }, [load]);

  const running = view?.entries.some((e) => !e.result || ACTIVE.includes(e.result.latestStatus));
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => load().catch(() => {}), 3000);
    return () => window.clearInterval(timer);
  }, [running, load]);

  async function pick(threadId: string) {
    setPicking(true);
    setActionError(null);
    try {
      await api(`/arenas/${id}/pick`, { method: "POST", body: JSON.stringify({ threadId }) });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't open the pull request.");
    } finally {
      setPicking(false);
    }
  }

  if (error) {
    return (
      <div className="center-state">
        <div>
          <CloudSlash size={36} style={{ color: "var(--text-3)" }} />
          <h2>Arena not found</h2>
          <p>{error}</p>
          <Link href="/app" className="btn btn-secondary">
            Start a new session
          </Link>
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="page" aria-busy="true">
        <div className="skeleton" style={{ width: "40%", height: 30 }} />
      </div>
    );
  }

  // Highlight the cheapest, fastest and smallest finished results that changed something.
  const done = view.entries.filter((e) => e.result && !ACTIVE.includes(e.result.latestStatus) && e.result.filesChanged > 0);
  const min = (f: (e: ArenaEntry) => number) => (done.length > 1 ? Math.min(...done.map(f)) : NaN);
  const cheapest = min((e) => (e.result!.onPlan ? 0 : e.result!.costUsd));
  const fastest = min((e) => e.result!.durationMs ?? Infinity);
  const smallest = min((e) => e.result!.additions + e.result!.deletions);

  return (
    <div className="page arena">
      <div className="page-head">
        <h1>Arena</h1>
        <p className="arena-task">{view.arena.prompt}</p>
        <div className="meta">
          <span>
            <GithubLogo size={13} />
            <span className="mono">{view.arena.repo}</span>
          </span>
          <span>
            <GitBranch size={13} />
            <span className="mono">{view.arena.baseBranch}</span>
          </span>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          {running
            ? "Agents are working. Turns run one at a time unless WORKER_CONCURRENCY is higher."
            : view.arena.winnerThreadId
              ? "A result was picked. Follow-ups in its session update the pull request."
              : "Compare the results and pick one to open as the pull request."}
        </p>
      </div>
      {actionError ? (
        <div className="notice" data-tone="danger" role="alert" style={{ marginBottom: 16 }}>
          <WarningCircle size={16} weight="bold" />
          {actionError}
        </div>
      ) : null}
      <div className="arena-grid" style={{ ["--n" as string]: view.entries.length }}>
        {view.entries.map((e) => (
          <Entry
            key={e.thread.id}
            entry={e}
            arena={view.arena}
            picking={picking}
            onPick={() => pick(e.thread.id)}
            best={{
              cost: e.result ? (e.result.onPlan ? 0 : e.result.costUsd) === cheapest : false,
              time: e.result?.durationMs === fastest,
              small: e.result ? e.result.additions + e.result.deletions === smallest : false,
            }}
          />
        ))}
      </div>
    </div>
  );
}
