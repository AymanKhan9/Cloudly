"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Check, Lightbulb, X } from "@phosphor-icons/react";
import { api, ApiError, type Repo } from "@/lib/api";
import { harnessById, relativeTime, usd } from "@/lib/harness";

interface Lesson {
  id: string;
  title: string;
  rule: string;
  why: string;
  evidence: { ref: string; text: string; threadId: string | null }[];
  status: "proposed" | "accepted" | "dismissed";
  createdAt: string;
  decidedAt: string | null;
}
interface LessonsView {
  lessons: Lesson[];
  run: { id: string; status: string; output: string | null; error: string | null; createdAt: string; harness: string; costUsd: number | null } | null;
  autoLessons: boolean;
  contextOn: boolean;
}

const KIND: Record<string, string> = { F: "Review finding", R: "Rewound", C: "Correction", K: "Failing checks", I: "Failing CI" };

function Proposal({ lesson, onDone }: { lesson: Lesson; onDone: (note?: string) => void }) {
  const [title, setTitle] = useState(lesson.title);
  const [rule, setRule] = useState(lesson.rule);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (path: string, body?: object) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ turnedOnContext?: boolean }>(`/lessons/${lesson.id}/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
      onDone(r.turnedOnContext ? "Added to the repo's notes, and shared context is now on for the repo so agents get them." : undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save it.");
      setBusy(false);
    }
  };
  return (
    <article className="lesson">
      <input className="input lesson-title" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea className="textarea" aria-label="Rule" rows={2} value={rule} onChange={(e) => setRule(e.target.value)} />
      {lesson.why ? <p className="hint">Why: {lesson.why}</p> : null}
      {lesson.evidence.length ? (
        <details className="lesson-evidence">
          <summary>Based on {lesson.evidence.length} thing{lesson.evidence.length === 1 ? "" : "s"} that went wrong</summary>
          <ul>
            {lesson.evidence.map((e) => (
              <li key={e.ref}>
                <span className="dim">{KIND[e.ref[0]!] ?? e.ref}</span> {e.text}{" "}
                {e.threadId ? (
                  <Link href={`/app/s/${e.threadId}`} className="dim">
                    session
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="row-actions" style={{ justifyContent: "flex-start" }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || title.trim().length < 3 || rule.trim().length < 10} onClick={() => act("accept", { title: title.trim(), rule: rule.trim() })}>
          <Check size={14} weight="bold" /> Add to the repo&apos;s notes
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act("dismiss")}>
          <X size={14} /> Not this one
        </button>
      </div>
      {error ? <p className="hint" style={{ color: "var(--danger)" }}>{error}</p> : null}
    </article>
  );
}

/** Lessons from a repo's sessions: what keeps going wrong, as rules for its notes. */
export default function LessonsPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repo, setRepo] = useState("");
  const [view, setView] = useState<LessonsView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ repos: Repo[] }>("/repos")
      .then((r) => {
        setRepos(r.repos);
        setRepo((cur) => cur || r.repos[0]?.fullName || "");
      })
      .catch(() => {});
  }, []);
  const load = useCallback(() => {
    if (!repo) return;
    api<LessonsView>(`/lessons?repo=${encodeURIComponent(repo)}`).then(setView).catch((e: Error) => setError(e.message));
  }, [repo]);
  useEffect(() => {
    setView(null);
    setNote(null);
    load();
  }, [load]);
  const looking = view?.run && ["queued", "running"].includes(view.run.status);
  useEffect(() => {
    if (!looking) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [looking, load]);

  const proposed = view?.lessons.filter((l) => l.status === "proposed") ?? [];
  const decided = view?.lessons.filter((l) => l.status !== "proposed") ?? [];

  async function look() {
    setError(null);
    try {
      await api("/lessons/run", { method: "POST", body: JSON.stringify({ repo }) });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start.");
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Lessons</h1>
        <p>
          What keeps going wrong on a repo, from its sessions: the reviewer&apos;s findings, turns you undid, what you told the agent after a turn, checks and CI that failed.
          An agent turns the patterns into short rules; the ones you keep go into the repo&apos;s notes, which every agent working on it reads.
        </p>
      </div>
      <div className="score-filters">
        <select className="select" aria-label="Repository" value={repo} onChange={(e) => setRepo(e.target.value)}>
          {repos.map((r) => (
            <option key={r.fullName} value={r.fullName}>
              {r.fullName}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-primary" onClick={look} disabled={!repo || Boolean(looking)}>
          <Lightbulb size={15} /> {looking ? "Looking…" : "Look for lessons"}
        </button>
        {view ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={view.autoLessons}
              onChange={async (e) => {
                await api("/lessons/settings", { method: "PUT", body: JSON.stringify({ repo, autoLessons: e.target.checked }) }).catch(() => {});
                load();
              }}
            />
            Every week, when enough has gone wrong
          </label>
        ) : null}
      </div>

      {view?.run ? (
        <p className="hint" role="status">
          {looking ? (
            <span className="shimmer-text">{harnessById(view.run.harness).name} is reading this repo&apos;s recent sessions…</span>
          ) : view.run.status === "failed" ? (
            <span style={{ color: "var(--danger)" }}>The last look failed: {view.run.error}</span>
          ) : (
            <>
              Last looked {relativeTime(view.run.createdAt)}
              {view.run.costUsd ? `, for ${usd(view.run.costUsd)}` : ""}. {view.run.output?.split("\n")[0]}
            </>
          )}
        </p>
      ) : null}
      {note ? <div className="notice" role="status">{note}</div> : null}
      {error ? <div className="notice" data-tone="danger" role="alert">{error}</div> : null}

      {view === null ? (
        <div className="skeleton" style={{ height: 120 }} aria-busy="true" />
      ) : proposed.length ? (
        <section className="lessons">
          <h2>To look over</h2>
          {proposed.map((l) => (
            <Proposal
              key={l.id}
              lesson={l}
              onDone={(n) => {
                if (n) setNote(n);
                load();
              }}
            />
          ))}
        </section>
      ) : (
        <p className="hint">No lessons waiting. Each costs one agent turn to find; it needs at least 3 things that went wrong since the last look.</p>
      )}

      {decided.length ? (
        <details className="lessons-decided">
          <summary>
            {decided.filter((l) => l.status === "accepted").length} kept, {decided.filter((l) => l.status === "dismissed").length} turned down
          </summary>
          <ul>
            {decided.map((l) => (
              <li key={l.id} data-status={l.status}>
                <strong>{l.title}</strong> <span className="dim">({l.status === "accepted" ? "in the notes" : "turned down"})</span>
                <div>{l.rule}</div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
