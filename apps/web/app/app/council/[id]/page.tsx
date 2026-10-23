"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCallback, useEffect, useState } from "react";
import { CaretRight, CloudSlash, Crown, DownloadSimple, GithubLogo, Globe, Stop, WarningCircle } from "@phosphor-icons/react";
import { api, ApiError, type CouncilTurn, type CouncilView } from "@/lib/api";
import { describeEvent, type StreamEvent } from "@/lib/events";
import { harnessById, usd, type RunStatus } from "@/lib/harness";
import { AgentLogo } from "@/components/agent-logo";
import { StatusIcon } from "@/components/status";

const ACTIVE: RunStatus[] = ["queued", "running", "finalizing"];
const NAMES: Record<string, string> = { "native-claude": "Claude", "native-codex": "Codex (GPT)", "gemini-acp": "Gemini" };
const memberName = (h: string) => NAMES[h] ?? harnessById(h).name;

function roundName(round: number, rounds: number) {
  if (round > rounds) return "Report";
  return round === 1 ? "Research" : round === 2 ? "Cross-review" : "Final positions";
}

const ROUND_HINT: Record<string, string> = {
  Research: "Each member on its own, without seeing the others.",
  "Cross-review": "Each member reads the others' findings and challenges them.",
  "Final positions": "Each member's conclusion after everything it read.",
  Report: "The chair writes the council's report.",
};

function duration(ms: number | null) {
  if (ms === null) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** What a working agent is doing right now, from its live event stream. */
function LiveLine({ runId }: { runId: string }) {
  const [line, setLine] = useState("Starting");
  useEffect(() => {
    const source = new EventSource(`/api/runs/${runId}/events`, { withCredentials: true });
    source.addEventListener("run-event", (msg) => {
      const e = JSON.parse((msg as MessageEvent).data) as StreamEvent;
      if (e.kind === "tool_call" || e.kind === "text") setLine(describeEvent(e));
    });
    return () => source.close();
  }, [runId]);
  return (
    <p className="council-live shimmer-text" title={line}>
      {line}
    </p>
  );
}

function TurnCard({ turn }: { turn: CouncilTurn }) {
  const h = harnessById(turn.harness);
  const active = ACTIVE.includes(turn.status);
  const took = duration(turn.durationMs);
  return (
    <article className="council-turn" data-status={turn.status}>
      <header>
        <AgentLogo harness={turn.harness} size={16} />
        <h3>{memberName(turn.harness)}</h3>
        <span className="spacer" />
        <span className="council-meta">
          <StatusIcon status={turn.status} size={14} />
          {turn.status === "queued" ? "Waiting" : active ? (turn.cancelRequested ? "Stopping" : "Working") : turn.status === "succeeded" ? "Done" : turn.status === "cancelled" ? "Stopped" : "Didn't finish"}
          {took ? <span className="num">{took}</span> : null}
          {turn.onPlan ? <span>Plan</span> : turn.costUsd ? <span className="num">{usd(turn.costUsd, h.cost === "estimated")}</span> : null}
        </span>
      </header>
      {turn.status === "running" ? <LiveLine runId={turn.id} /> : null}
      {turn.error && !turn.output ? (
        <div className="notice" data-tone="danger">
          <WarningCircle size={16} weight="bold" />
          {turn.error}
        </div>
      ) : null}
      {turn.output ? (
        <details className="council-output">
          <summary>
            <CaretRight size={12} weight="bold" />
            Answer
          </summary>
          <div className="reply">
            <Markdown remarkPlugins={[remarkGfm]}>{turn.output}</Markdown>
          </div>
        </details>
      ) : null}
    </article>
  );
}

export default function CouncilPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<CouncilView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => api<CouncilView>(`/councils/${id}`).then(setView), [id]);
  useEffect(() => {
    setView(null);
    load().catch((e: Error) => setError(e instanceof ApiError && e.status === 404 ? "This council doesn't exist, or it belongs to someone else." : e.message));
  }, [load]);

  const running = view?.council.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => load().catch(() => {}), 3000);
    return () => window.clearInterval(timer);
  }, [running, load]);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    setActionError(null);
    try {
      await api(`/councils/${id}/guidance`, { method: "POST", body: JSON.stringify({ text: note }) });
      setNote("");
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't add the note.");
    }
  }

  async function cancel() {
    setActionError(null);
    try {
      await api(`/councils/${id}/cancel`, { method: "POST" });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't stop the council.");
    }
  }

  if (error) {
    return (
      <div className="center-state">
        <div>
          <CloudSlash size={36} style={{ color: "var(--text-3)" }} />
          <h2>Council not found</h2>
          <p>{error}</p>
          <Link href="/app" className="btn btn-secondary">
            Start something new
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

  const { council, turns } = view;
  const stages = [...Array(council.rounds + 1).keys()].map((i) => i + 1);
  const status =
    council.status === "running"
      ? `${roundName(council.round, council.rounds)}${council.round <= council.rounds ? `, round ${council.round} of ${council.rounds}` : ""}`
      : council.status === "done"
        ? "Done"
        : council.status === "stopped"
          ? "Stopped at the cap"
          : council.status === "cancelled"
            ? "Stopped"
            : "Failed";

  return (
    <div className="page council">
      <div className="page-head">
        <h1>Council</h1>
        <p className="arena-task">{council.question}</p>
        <div className="meta council-head">
          <span className="council-members">
            {council.members.map((m) => (
              <span key={m}>
                <AgentLogo harness={m} size={14} />
                {memberName(m)}
              </span>
            ))}
          </span>
          <span>
            <Crown size={13} />
            {memberName(council.chair)} chairs
          </span>
          <span>
            {council.repo ? <GithubLogo size={13} /> : <Globe size={13} />}
            {council.repo ? <span className="mono">{council.repo}</span> : "Web research"}
          </span>
          <span>
            <StatusIcon status={running ? "running" : council.status === "done" ? "succeeded" : council.status === "failed" ? "failed" : "cancelled"} size={13} />
            {status}
          </span>
          <span className="num">
            {usd(view.spentUsd)}
            {council.budgetUsd ? ` of ${usd(council.budgetUsd)} cap` : ""}
          </span>
          {running ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={cancel}>
              <Stop size={13} weight="fill" />
              Stop
            </button>
          ) : null}
        </div>
      </div>

      {actionError || council.error ? (
        <div className="notice" data-tone={council.status === "failed" || actionError ? "danger" : "warn"} role="alert" style={{ marginBottom: 16 }}>
          <WarningCircle size={16} weight="bold" />
          {actionError ?? council.error}
        </div>
      ) : null}

      {council.report ? (
        <section className="council-report">
          <header>
            <h2>Report</h2>
            <span className="spacer" />
            <a className="btn btn-secondary btn-sm" href={`/api/councils/${council.id}/report`}>
              <DownloadSimple size={14} />
              Download
            </a>
          </header>
          <div className="reply prose">
            <Markdown remarkPlugins={[remarkGfm]}>{council.report}</Markdown>
          </div>
        </section>
      ) : null}

      {running && council.round <= council.rounds ? (
        <form className="council-note" onSubmit={addNote}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note for the next round, e.g. focus on roles that involve AI tools" maxLength={2000} aria-label="Note for the next round" />
          <button type="submit" className="btn btn-secondary" disabled={!note.trim()}>
            Add note
          </button>
        </form>
      ) : null}
      {council.guidance.length ? (
        <ul className="council-guidance">
          {council.guidance.map((g, i) => (
            <li key={i}>
              <span className="dim">After round {g.round}:</span> {g.text}
            </li>
          ))}
        </ul>
      ) : null}

      {stages
        .filter((r) => r <= council.round || turns.some((t) => t.round === r))
        .reverse()
        .map((r) => {
          const name = roundName(r, council.rounds);
          const inRound = turns.filter((t) => t.round === r);
          return (
            <section key={r} className="council-round">
              <header>
                <h2>{r > council.rounds ? "Report" : `Round ${r}: ${name}`}</h2>
                <p className="hint">{ROUND_HINT[name]}</p>
              </header>
              <div className="council-grid" style={{ ["--n" as string]: Math.max(1, inRound.length) }}>
                {inRound.map((t) => (
                  // The chair's text is already the report above.
                  <TurnCard key={t.id} turn={r > council.rounds ? { ...t, output: council.report ? null : t.output } : t} />
                ))}
              </div>
            </section>
          );
        })}
    </div>
  );
}
