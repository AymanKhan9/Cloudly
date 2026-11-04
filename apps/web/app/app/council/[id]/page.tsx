"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { RichMarkdown } from "@/components/rich-markdown";
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

/** Round 1 is research; the last round, final positions; any between, debate. */
function roundName(round: number, rounds: number) {
  if (round > rounds) return "Report";
  if (round === 1) return "Research";
  if (round === rounds) return "Final positions";
  return rounds > 3 ? `Debate ${round - 1}` : "Debate";
}

function roundHint(name: string) {
  if (name === "Research") return "Every member at once, each on its own, without seeing the others.";
  if (name.startsWith("Debate")) return "Every member reads the others' latest answers, then challenges, defends and refines.";
  if (name === "Final positions") return "Each member's conclusion after everything it read.";
  return "The chair writes the council's report.";
}

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
            <RichMarkdown>{turn.output}</RichMarkdown>
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

  async function finish() {
    setActionError(null);
    try {
      await api(`/councils/${id}/finish`, { method: "POST" });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't finish the council.");
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
          ? "Stopped at its cap"
          : council.status === "cancelled"
            ? "Stopped"
            : "Failed";

  return (
    <div className="page council">
      <header className="council-top">
        <p className="council-kind">
          <span className="council-dot" data-live={running || undefined} />
          Council · {council.repo ? <span className="mono">{council.repo}</span> : "web research"}
        </p>
        <h1 className="council-question">{council.question}</h1>
        <div className="council-people">
          {council.members.map((m) => {
            const s = council.settings?.[m];
            return (
              <span key={m} className="council-person">
                <AgentLogo harness={m} size={15} />
                <span>
                  {memberName(m)}
                  {s?.model || s?.effort ? <span className="dim"> · {[s.model, s.effort].filter(Boolean).join(", ")}</span> : null}
                </span>
                {m === council.chair ? <Crown size={13} aria-label="Chairs" /> : null}
              </span>
            );
          })}
          {!council.members.includes(council.chair) ? (
            <span className="council-person">
              <AgentLogo harness={council.chair} size={15} />
              <span>{memberName(council.chair)}</span>
              <Crown size={13} aria-label="Chairs" />
            </span>
          ) : null}
        </div>

        <ol className="council-steps" aria-label="Rounds">
          {stages.map((r) => {
            const name = roundName(r, council.rounds);
            const state = r < council.round || council.status === "done" ? "done" : r === council.round && running ? "now" : "next";
            return (
              <li key={r} data-state={state}>
                <span className="n">{r > council.rounds ? <Crown size={12} /> : r}</span>
                <span className="t">{name}</span>
              </li>
            );
          })}
        </ol>

        <div className="council-bar">
          <span className="council-status">
            <StatusIcon status={running ? "running" : council.status === "done" ? "succeeded" : council.status === "failed" ? "failed" : "cancelled"} size={14} />
            {status}
          </span>
          <span className="num dim">{usd(view.spentUsd)}</span>
          <span className="spacer" />
          {running && council.round < council.rounds ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={finish} title="This round is the last; then the chair writes the report">
              <Crown size={13} />
              Finish after this round
            </button>
          ) : null}
          {running ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={cancel}>
              <Stop size={13} weight="fill" />
              Stop
            </button>
          ) : null}
        </div>
      </header>

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
            <RichMarkdown>{council.report}</RichMarkdown>
          </div>
        </section>
      ) : null}

      {running && council.round <= council.rounds ? (
        <form className="council-note" onSubmit={addNote}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Steer the next round: a question to settle, a point to dig into…" maxLength={2000} aria-label="Note for the next round" />
          <button type="submit" className="btn btn-primary" disabled={!note.trim()}>
            Send to the council
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
                <p className="hint">{roundHint(name)}</p>
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
