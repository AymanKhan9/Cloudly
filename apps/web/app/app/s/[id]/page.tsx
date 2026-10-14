"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import Markdown from "react-markdown";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type ThreadView, type Turn } from "@/lib/api";
import { harnessById, oktasFor, STATUS_LABEL, usd, type RunStatus } from "@/lib/harness";
import { buildBlocks, type StreamEvent } from "@/lib/events";
import { Oktas } from "@/components/notation";
import { ArrowIcon, ExternalIcon, StopIcon } from "@/components/icons";

const ACTIVE: RunStatus[] = ["queued", "running", "finalizing"];

type TurnEvent = StreamEvent & { runId: string };

function elapsed(from: string, now: number) {
  const s = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function TurnView({ turn, events, harness, now }: { turn: Turn; events: StreamEvent[]; harness: string; now: number }) {
  const h = harnessById(harness);
  const blocks = useMemo(() => buildBlocks(events, harness), [events, harness]);
  const active = ACTIVE.includes(turn.status);
  const hasReply = blocks.some((b) => b.t === "text" || b.t === "tools");

  return (
    <article className="turn">
      <div className="msg-user">{turn.prompt}</div>

      <div className="msg-agent">
        {blocks.map((b, i) => {
          if (b.t === "text") return <div key={i} className="reply"><Markdown>{b.text}</Markdown></div>;
          if (b.t === "thought")
            return (
              <details key={i} className="thought">
                <summary>Reasoning</summary>
                <p>{b.text}</p>
              </details>
            );
          if (b.t === "error") return <div key={i} className="error-box">{b.text}</div>;
          return (
            <ul key={i} className="tool-rows">
              {b.items.map((item, j) => (
                <li key={j}>
                  <span className="mono">{item.call}</span>
                  {item.result ? <span className="tool-result mono">{item.result}</span> : null}
                </li>
              ))}
            </ul>
          );
        })}

        {active && !hasReply ? (
          <p className="waiting" role="status">
            {turn.status === "queued" ? "Waiting for the worker" : "Waiting for the model"} · <span className="num">{elapsed(turn.createdAt, now)}</span>
          </p>
        ) : null}

        {turn.error ? <div className="error-box" role="alert">{turn.error}</div> : null}

        <footer className="turn-foot">
          <Oktas eighths={oktasFor(turn.status, Math.min(0.9, events.length / 24))} obscured={turn.status === "failed"} size={18} title={STATUS_LABEL[turn.status]} />
          <span className="stamp" data-inked={!active && turn.status === "succeeded" ? true : undefined} data-struck={turn.status === "cancelled" ? true : undefined}>
            {turn.cancelRequested && active ? "Cancelling" : turn.status === "succeeded" && !turn.prUrl ? "Done" : STATUS_LABEL[turn.status]}
          </span>
          {active ? <span className="num">{elapsed(turn.createdAt, now)}</span> : null}
          {turn.onPlan ? (
            <span className="num">on your plan</span>
          ) : turn.costUsd !== null ? (
            <span className="num">
              {usd(turn.costUsd, h.cost === "estimated")}
              {h.cost === "estimated" ? <span className="est"> est.</span> : null}
            </span>
          ) : null}
          {turn.prUrl ? (
            <a href={turn.prUrl} target="_blank" rel="noreferrer" className="link-arrow" style={{ marginLeft: "auto", borderColor: "var(--hair-ink)" }}>
              Pull request
              <ExternalIcon />
            </a>
          ) : null}
        </footer>
      </div>
    </article>
  );
}

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<ThreadView | null>(null);
  const [events, setEvents] = useState<Record<string, StreamEvent[]>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const stickRef = useRef(true);

  useEffect(() => {
    setView(null);
    setEvents({});
    api<ThreadView>(`/threads/${id}`)
      .then(setView)
      .catch((e: Error) => setLoadError(e instanceof ApiError && e.status === 404 ? "This session doesn't exist, or it belongs to someone else." : e.message));

    const source = new EventSource(`/api/threads/${id}/events`, { withCredentials: true });
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("turn-event", (msg) => {
      const e = JSON.parse((msg as MessageEvent).data) as TurnEvent;
      setEvents((prev) => {
        const list = prev[e.runId] ?? [];
        if (list.some((x) => x.seq === e.seq)) return prev;
        return { ...prev, [e.runId]: [...list, e] };
      });
    });
    source.addEventListener("thread-status", (msg) => setView(JSON.parse((msg as MessageEvent).data) as ThreadView));
    return () => source.close();
  }, [id]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const eventCount = Object.values(events).reduce((n, l) => n + l.length, 0);

  // The agent announces its commands (built-ins, bundled skills, the repo's own)
  // at the start of every turn; the latest list is what "/" offers.
  const commands = useMemo(() => {
    let latest: string[] = [];
    for (const list of Object.values(events)) {
      for (const e of list) {
        const names = (e.data as { slash_commands?: unknown } | null)?.slash_commands;
        if (Array.isArray(names)) latest = names.filter((n): n is string => typeof n === "string");
      }
    }
    return [...new Set(latest)].sort();
  }, [events]);

  // Model and context fill from the latest turn: Claude reports both at the end
  // of each turn, and its start-of-turn message names the model.
  const context = useMemo(() => {
    let model: string | undefined;
    let usage: { tokens: number; max: number; percentage: number } | undefined;
    for (const list of Object.values(events)) {
      for (const e of list) {
        const d = e.data as Record<string, unknown> | null;
        if (!d || typeof d !== "object") continue;
        if (typeof d.model === "string" && (d.subtype === "init" || d.type === "context")) model = d.model;
        if (d.type === "context" && typeof d.tokens === "number" && typeof d.max === "number") {
          usage = { tokens: d.tokens, max: d.max, percentage: Number(d.percentage) || 0 };
        }
      }
    }
    return { model, usage };
  }, [events]);
  // To the page's real bottom: an anchor above the sticky composer would scroll
  // the page up on every event and hide the newest output behind the composer.
  useEffect(() => {
    if (stickRef.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [eventCount, view?.turns.length]);

  useEffect(() => {
    const onScroll = () => {
      stickRef.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (loadError) {
    return (
      <div className="empty">
        <Oktas eighths={8} obscured size={56} />
        <div>
          <h2 className="display">Session not found.</h2>
          <p>{loadError}</p>
          <Link href="/app" className="btn btn-quiet">
            New session
          </Link>
        </div>
      </div>
    );
  }
  if (!view) return <div className="skeleton" style={{ width: "40%", height: 28 }} aria-busy="true" />;

  const { thread, turns } = view;
  const h = harnessById(thread.harness);
  const latest = turns.at(-1);
  const busy = latest ? ACTIVE.includes(latest.status) : false;
  const total = turns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);

  // While typing a command name: "/" alone or "/co", but not once arguments start.
  const typing = /^\/([\w:.-]*)$/.exec(draft);
  const suggestions = typing ? commands.filter((c) => c.startsWith(typing[1]!) && c !== typing[1]).slice(0, 10) : [];
  // A /word the agent didn't announce isn't a command in this mode (interactive-only
  // ones like /stats or /plan): it would go to the model as text, which then improvises.
  const typed = /^\/([\w:.-]+)(\s|$)/.exec(draft)?.[1];
  const unknownCommand = typed && commands.length > 0 && !commands.includes(typed) && !commands.some((c) => c.startsWith(typed + " ")) && suggestions.length === 0 ? typed : null;

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || busy || sending) return;
    setSending(true);
    setActionError(null);
    try {
      await api(`/threads/${id}/messages`, { method: "POST", body: JSON.stringify({ prompt: draft }) });
      setDraft("");
      stickRef.current = true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't send.");
    } finally {
      setSending(false);
    }
  }

  async function cancel() {
    if (!latest) return;
    setActionError(null);
    try {
      await api(`/runs/${latest.id}/cancel`, { method: "POST" });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't cancel.");
    }
  }

  return (
    <div className="chat">
      <header className="chat-head">
        <div>
          <h1 className="display">{thread.title}</h1>
          <p className="chat-meta">
            <span className="mono">{thread.repo}</span>
            <span aria-hidden="true">·</span>
            <span>
              <span className="latin">{h.genus}</span> {h.name}
            </span>
            <span aria-hidden="true">·</span>
            <span className="mono">{thread.branch}</span>
            {context.model ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="mono">{context.model}</span>
              </>
            ) : null}
            {context.usage ? (
              <>
                <span aria-hidden="true">·</span>
                <ContextRing {...context.usage} />
              </>
            ) : null}
            {total > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="num">{usd(total, h.cost === "estimated")}</span>
              </>
            ) : null}
          </p>
        </div>
        {thread.prUrl ? (
          <a href={thread.prUrl} target="_blank" rel="noreferrer" className="btn btn-signal">
            Pull request
            <ExternalIcon />
          </a>
        ) : null}
      </header>

      <div className="turns">
        {turns.map((t) => (
          <TurnView key={t.id} turn={t} events={events[t.id] ?? []} harness={thread.harness} now={now} />
        ))}
      </div>

      <form className="composer" onSubmit={send}>
        {suggestions.length > 0 ? (
          <div className="command-suggest" role="listbox" aria-label="Agent commands">
            {suggestions.map((name) => (
              <button key={name} type="button" role="option" aria-selected={false} className="mono" onClick={() => setDraft(`/${name} `)}>
                /{name}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Tab" && suggestions.length > 0) {
              e.preventDefault();
              setDraft(`/${suggestions[0]} `);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={busy ? "The agent is working. You can type the next message now." : commands.length ? "Ask for a change, or type / for the agent's commands" : "Ask for a change, or a question about the code"}
          rows={2}
          maxLength={8000}
          aria-label="Message"
        />
        <div className="composer-row">
          <span className="composer-hint" role={actionError ? "alert" : undefined} style={actionError ? { color: "var(--storm)" } : undefined}>
            {actionError ??
              (unknownCommand
                ? `/${unknownCommand} isn't one of this agent's commands here, so it will be sent as an ordinary message.`
                : connected
                  ? "Enter to send · Shift+Enter for a new line"
                  : "Reconnecting…")}
          </span>
          {busy ? (
            <button type="button" className="btn btn-quiet" onClick={cancel} disabled={latest?.cancelRequested}>
              <StopIcon />
              {latest?.cancelRequested ? "Cancelling" : "Cancel turn"}
            </button>
          ) : null}
          <button type="submit" className="btn btn-signal" disabled={busy || sending || !draft.trim()}>
            Send
            <ArrowIcon />
          </button>
        </div>
      </form>
    </div>
  );
}

const compact = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

/** How full the agent's context window is, as in Claude Code. /compact empties it. */
function ContextRing({ tokens, max, percentage }: { tokens: number; max: number; percentage: number }) {
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const filled = Math.min(1, percentage / 100);
  const label = `Context: ${compact(tokens)} of ${compact(max)} tokens (${percentage}%). /compact frees it up.`;
  return (
    <span className="context-ring" title={label} aria-label={label} role="img" data-full={percentage >= 80 ? true : undefined}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={r} className="track" />
        <circle cx="9" cy="9" r={r} className="fill" strokeDasharray={`${filled * circumference} ${circumference}`} transform="rotate(-90 9 9)" />
      </svg>
      <span className="num">{percentage}%</span>
    </span>
  );
}
