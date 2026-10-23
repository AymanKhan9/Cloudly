"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import Markdown from "react-markdown";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  ArrowUp,
  CaretRight,
  CloudSlash,
  FileText,
  FolderSimple,
  Monitor,
  AppWindow,
  Scales,
  Notebook,
  GitBranch,
  GitPullRequest,
  GithubLogo,
  Globe,
  Lightbulb,
  MagnifyingGlass,
  PencilSimpleLine,
  Robot,
  Stop,
  TreeStructure,
  Terminal,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import { api, ApiError, type Capabilities, type ThreadView, type Turn } from "@/lib/api";
import { harnessById, MODELS, STATUS_LABEL, usd, type HarnessId, type RunStatus } from "@/lib/harness";
import { buildBlocks, type Block, type StreamEvent } from "@/lib/events";
import { StatusIcon } from "@/components/status";
import { Picker } from "@/components/picker";
import { AgentLogo, providerOf } from "@/components/agent-logo";
import { EffortControl } from "@/components/effort-control";
import { FilesPanel } from "@/components/files-panel";
import { PreviewPanel } from "@/components/preview-panel";
import { DesktopViewer } from "@/components/desktop-viewer";
import { ContextPanel } from "@/components/context-panel";

const ACTIVE: RunStatus[] = ["queued", "running", "finalizing"];

type TurnEvent = StreamEvent & { runId: string };

function elapsed(from: string, now: number) {
  const s = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// Tool calls arrive as "Name  argument" lines from all three agents; group them
// by what they did so a turn's activity reads as one sentence.
const KINDS = {
  cmd: { icon: Terminal, one: "Ran a command", many: (n: number) => `Ran ${n} commands`, live: "Running" },
  read: { icon: FileText, one: "Read a file", many: (n: number) => `Read ${n} files`, live: "Reading" },
  edit: { icon: PencilSimpleLine, one: "Edited a file", many: (n: number) => `Edited ${n} files`, live: "Editing" },
  search: { icon: MagnifyingGlass, one: "Searched once", many: (n: number) => `Searched ${n} times`, live: "Searching" },
  web: { icon: Globe, one: "Fetched a page", many: (n: number) => `Fetched ${n} pages`, live: "Fetching" },
  other: { icon: Wrench, one: "Used a tool", many: (n: number) => `Used ${n} tools`, live: "Using" },
};
type Kind = keyof typeof KINDS;

function parseCall(call: string): { kind: Kind; name: string; arg: string } {
  const split = call.split(/\s{2,}/);
  let [name, arg] = split.length > 1 ? [split[0]!, split.slice(1).join(" ")] : [call.split(" ")[0]!, call.split(" ").slice(1).join(" ")];
  arg = arg.replaceAll("/workspace/", "");
  const n = name.toLowerCase();
  const kind: Kind = /bash|command|shell|exec/.test(n)
    ? "cmd"
    : /edit|write|replace|file_change|patch|edited|changed/.test(n)
      ? "edit"
      : /read|view|cat/.test(n)
        ? "read"
        : /grep|glob|search|find|^ls$|list|rg/.test(n)
          ? "search"
          : /web|fetch|url/.test(n)
            ? "web"
            : "other";
  return { kind, name, arg };
}

function Activity({ items, live }: { items: { call: string; result?: string }[]; live: boolean }) {
  const parsed = items.map((i) => ({ ...parseCall(i.call), result: i.result }));
  const last = parsed.at(-1)!;
  const counts = new Map<Kind, number>();
  for (const p of parsed) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  const summary = [...counts]
    .map(([k, n], i) => {
      const text = n === 1 ? KINDS[k].one : KINDS[k].many(n);
      return i === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
    })
    .join(", ");
  const LastIcon = KINDS[last.kind].icon;

  return (
    <details className="activity">
      <summary>
        <LastIcon size={15} />
        {live ? (
          <span className="label shimmer-text">
            {KINDS[last.kind].live} <span className="mono">{last.arg || last.name}</span>
          </span>
        ) : (
          <span className="label">{summary}</span>
        )}
        <CaretRight size={12} weight="bold" className="chev" />
      </summary>
      <ol>
        {parsed.map((p, i) => {
          const Icon = KINDS[p.kind].icon;
          return (
            <li key={i}>
              <Icon size={14} />
              <span className="call mono" title={`${p.name} ${p.arg}`}>
                <b>{p.name}</b>
                {p.arg}
              </span>
              {p.result ? <span className="result mono">{p.result.replaceAll("/workspace/", "")}</span> : null}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

/** One level of a turn's work. Subagents render their own work with the same component. */
function Blocks({ blocks, live }: { blocks: Block[]; live: boolean }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.t === "text")
          return (
            <div key={i} className="reply">
              <Markdown>{b.text}</Markdown>
            </div>
          );
        if (b.t === "thought")
          return (
            <details key={i} className="thought">
              <summary>
                <Lightbulb size={15} />
                Reasoning
              </summary>
              <p>{b.text}</p>
            </details>
          );
        if (b.t === "error")
          return (
            <div key={i} className="notice" data-tone="danger">
              <WarningCircle size={16} weight="bold" />
              {b.text}
            </div>
          );
        if (b.t === "subagent") {
          const running = live && !b.done;
          return (
            <details key={b.id} className="subagent" data-running={running || undefined}>
              <summary>
                {running ? <StatusIcon status="running" size={15} /> : <TreeStructure size={15} />}
                <span className="label">
                  <span className={running ? "shimmer-text" : undefined}>{b.description || "Subagent"}</span>
                  <span className="kind">{b.kind}</span>
                </span>
                <CaretRight size={12} weight="bold" className="chev" />
              </summary>
              <div className="subagent-body">
                {b.blocks.length ? <Blocks blocks={b.blocks} live={running} /> : running ? <p className="hint">Starting</p> : null}
                {b.report ? (
                  <div className="reply subagent-report">
                    <Markdown>{b.report}</Markdown>
                  </div>
                ) : null}
              </div>
            </details>
          );
        }
        return <Activity key={i} items={b.items} live={live && i === blocks.length - 1} />;
      })}
    </>
  );
}

function TurnView({ turn, events, harness, now }: { turn: Turn; events: StreamEvent[]; harness: string; now: number }) {
  const h = harnessById(harness);
  const blocks = useMemo(() => buildBlocks(events, harness), [events, harness]);
  const active = ACTIVE.includes(turn.status);
  const status = turn.cancelRequested && active ? "Cancelling" : turn.status === "succeeded" && !turn.prUrl ? "Done" : STATUS_LABEL[turn.status];

  return (
    <article className="turn">
      <div className="msg-user">
        <div>{turn.prompt}</div>
      </div>

      <div className="msg-agent">
        <Blocks blocks={blocks} live={active} />

        {active && blocks.length === 0 ? (
          <p className="shimmer-text" role="status" style={{ fontSize: 14, justifySelf: "start" }}>
            {turn.status === "queued" ? "Waiting for the worker to pick this up" : "Thinking"}
          </p>
        ) : null}

        {turn.error ? (
          <div className="notice" data-tone="danger" role="alert">
            <WarningCircle size={16} weight="bold" />
            {turn.error}
          </div>
        ) : null}

        <footer className="turn-foot">
          <span className="status">
            <StatusIcon status={turn.status} pr={Boolean(turn.prUrl)} size={14} />
            {status}
          </span>
          {active ? <span className="num">{elapsed(turn.createdAt, now)}</span> : null}
          {turn.onPlan ? (
            <span>On your plan</span>
          ) : turn.costUsd !== null ? (
            <span className="num" title={h.cost === "estimated" ? "Estimated from token counts" : "Reported by the agent"}>
              {usd(turn.costUsd, h.cost === "estimated")}
              {h.cost === "estimated" ? " est." : ""}
            </span>
          ) : null}
          {turn.filesChanged ? (
            <span className="num diffstat" title={`${turn.filesChanged} file${turn.filesChanged === 1 ? "" : "s"} changed`}>
              <span className="add">+{turn.additions ?? 0}</span> <span className="del">−{turn.deletions ?? 0}</span>
            </span>
          ) : null}
          {turn.prUrl ? (
            <a href={turn.prUrl} target="_blank" rel="noreferrer" className="pr-chip">
              <GitPullRequest size={14} weight="bold" />
              Pull request
              <ArrowSquareOut size={12} />
            </a>
          ) : null}
        </footer>
      </div>
    </article>
  );
}

const compact = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

/** How full the agent's context window is, as in Claude Code. /compact empties it. */
function ContextRing({ tokens, max, percentage }: { tokens: number; max: number; percentage: number }) {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const label = `Context: ${compact(tokens)} of ${compact(max)} tokens (${percentage}%). /compact frees it up.`;
  return (
    <span className="ring" title={label} aria-label={label} role="img" data-full={percentage >= 80 || undefined}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" strokeWidth="2.2">
        <circle cx="8" cy="8" r={r} className="track" />
        <circle cx="8" cy="8" r={r} className="fill" strokeLinecap="round" strokeDasharray={`${Math.min(1, percentage / 100) * c} ${c}`} transform="rotate(-90 8 8)" />
      </svg>
      <span className="num">{percentage}%</span>
    </span>
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
  const [pick, setPick] = useState(0);
  const [panel, setPanel] = useState<"files" | "preview" | "desktop" | "context" | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const stickRef = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelMenu = useRef<{ show: () => void }>(null);

  useEffect(() => {
    setView(null);
    setEvents({});
    setLoadError(null);
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

  useEffect(() => {
    api<Capabilities>("/capabilities").then(setCaps).catch(() => {});
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

  // Follow new output only while the reader is already at the bottom.
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => (stickRef.current = Boolean(e?.isIntersecting)), { rootMargin: "0px 0px 160px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [view !== null]);

  // To the page's real bottom: an anchor above the sticky composer would leave
  // the newest output hidden behind it.
  useEffect(() => {
    if (stickRef.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [eventCount, view?.turns.length]);

  // While typing a command name: "/" alone or "/co", but not once arguments start.
  const typing = /^\/([\w:.-]*)$/.exec(draft);
  const suggestions = typing ? commands.filter((c) => c.startsWith(typing[1]!) && c !== typing[1]).slice(0, 10) : [];
  useEffect(() => setPick(0), [suggestions.length]);

  if (loadError) {
    return (
      <div className="center-state">
        <div>
          <CloudSlash size={36} style={{ color: "var(--text-3)" }} />
          <h2>Session not found</h2>
          <p>{loadError}</p>
          <Link href="/app" className="btn btn-secondary">
            Start a new session
          </Link>
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="chat" aria-busy="true">
        <div className="thread" style={{ display: "grid", gap: 16, paddingTop: 48 }}>
          <div className="skeleton" style={{ width: "45%", height: 38, justifySelf: "end", borderRadius: 18 }} />
          <div className="skeleton" style={{ width: "80%" }} />
          <div className="skeleton" style={{ width: "65%" }} />
          <div className="skeleton" style={{ width: "30%" }} />
        </div>
      </div>
    );
  }

  const { thread, turns } = view;
  const h = harnessById(thread.harness);
  const latest = turns.at(-1);
  const busy = latest ? ACTIVE.includes(latest.status) : false;
  // The running turn has a desktop to watch.
  const desktopLive = Boolean(latest && latest.status === "running" && latest.desktop);
  const toggle = (p: NonNullable<typeof panel>) => setPanel((cur) => (cur === p ? null : p));
  const total = turns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);

  // A /word the agent didn't announce isn't a command in this mode (interactive-only
  // ones like /stats or /plan): it would go to the model as text, which then improvises.
  const typed = /^\/([\w:.-]+)(\s|$)/.exec(draft)?.[1];
  const unknownCommand =
    typed && typed.toLowerCase() !== "model" && commands.length > 0 && !commands.includes(typed) && !commands.some((c) => c.startsWith(typed + " ")) && suggestions.length === 0 ? typed : null;

  async function send(e?: React.FormEvent, text = draft) {
    e?.preventDefault();
    // A bare "/model" opens the model menu instead of asking the agent.
    if (text === draft && /^\/model\s*$/i.test(text.trim())) {
      setDraft("");
      modelMenu.current?.show();
      return;
    }
    if (!text.trim() || busy || sending) return;
    setSending(true);
    setActionError(null);
    try {
      await api(`/threads/${id}/messages`, { method: "POST", body: JSON.stringify({ prompt: text }) });
      if (text === draft) setDraft("");
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

  // Saved on the session, not sent as a message: the next turn picks it up.
  // Saved on the session, not sent as a message: the next turn picks it up.
  async function saveSetting(field: "model" | "effort" | "desktop", value: string | boolean | null) {
    const before = view!.thread[field] ?? null;
    setView((v) => (v ? { ...v, thread: { ...v.thread, [field]: value } } : v));
    setActionError(null);
    try {
      await api(`/threads/${id}`, { method: "PATCH", body: JSON.stringify({ [field]: value }) });
    } catch (err) {
      setView((v) => (v ? { ...v, thread: { ...v.thread, [field]: before } } : v));
      setActionError(err instanceof Error ? err.message : `Couldn't change the ${field}.`);
    }
  }
  const setModel = (model: string | null) => saveSetting("model", model);

  // The second line of a model in the menu: vendor logo, vendor, and a note.
  const by = (note?: string) => (
    <>
      <AgentLogo harness={thread.harness} size={13} />
      {providerOf(thread.harness)}
      {note ? <span className="dim">{note}</span> : null}
    </>
  );

  const choose = (name: string) => {
    setDraft(`/${name} `);
    inputRef.current?.focus();
  };

  const hint = actionError
    ? { tone: "danger", text: actionError }
    : typed && typed.toLowerCase() !== "model" && thread.harness === "native-codex"
      ? { tone: "warn", text: "Codex has no / commands when it runs headless, so this will be sent as an ordinary message." }
      : unknownCommand
        ? { tone: "warn", text: `/${unknownCommand} isn't one of this agent's commands here, so it will be sent as an ordinary message.` }
        : !connected
          ? { tone: undefined, text: "Reconnecting to the live log" }
          : busy
            ? { tone: undefined, text: "The agent is working. Your next message can wait here until the turn ends." }
            : null;

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="titles">
          <h1 title={thread.title}>{thread.title}</h1>
          <div className="meta">
            <span>
              <GithubLogo size={13} />
              <span className="mono">{thread.repo}</span>
            </span>
            <span className="hide-sm">
              <GitBranch size={13} />
              <span className="mono">{thread.branch}</span>
            </span>
          </div>
        </div>
        <div className="tools">
          {thread.arenaId ? (
            <Link href={`/app/arena/${thread.arenaId}`} className="btn btn-secondary btn-sm" title="Compare with the other agents on this task" aria-label="Arena">
              <Scales size={15} />
              <span className="hide-sm">Arena</span>
            </Link>
          ) : null}
          {desktopLive ? (
            <button type="button" className="btn btn-secondary btn-sm" aria-pressed={panel === "desktop"} onClick={() => toggle("desktop")} title="Watch the agent's desktop" aria-label="Desktop">
              <Monitor size={15} />
              <span className="hide-sm">Desktop</span>
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary btn-sm" aria-pressed={panel === "preview"} onClick={() => toggle("preview")} title="Run this branch's app" aria-label="Preview">
            <AppWindow size={15} />
            <span className="hide-sm">Preview</span>
          </button>
          <button type="button" className="btn btn-secondary btn-sm" aria-pressed={panel === "context"} onClick={() => toggle("context")} title="Notes and work shared by every agent on this repo" aria-label="Context">
            <Notebook size={15} />
            <span className="hide-sm">Context</span>
          </button>
          <button type="button" className="btn btn-secondary btn-sm" aria-pressed={panel === "files"} onClick={() => toggle("files")} title="The repo's kept files, at /files in every run" aria-label="Files">
            <FolderSimple size={15} />
            <span className="hide-sm">Files</span>
          </button>
          {thread.prUrl ? (
            <a href={thread.prUrl} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
              <GitPullRequest size={15} weight="bold" style={{ color: "var(--ok)" }} />
              <span className="hide-sm">Pull request</span>
            </a>
          ) : null}
        </div>
      </header>

      {panel ? (
        <section className="side-panel" aria-label={panel === "files" ? "Repo files" : panel === "preview" ? "Preview" : panel === "context" ? "Shared context" : "Desktop"}>
          {panel === "context" ? (
            <>
              <h2>
                Shared context for <span className="mono">{thread.repo}</span>
              </h2>
              <ContextPanel repo={thread.repo} />
            </>
          ) : panel === "files" ? (
            <>
              <h2>
                Files in <span className="mono">/files</span>
              </h2>
              <p className="hint">Kept for {thread.repo} outside git, in every session&apos;s sandbox. Mention them in your message to point the agent at them.</p>
              <FilesPanel repo={thread.repo} compact />
            </>
          ) : panel === "preview" ? (
            <>
              <h2>Preview</h2>
              <PreviewPanel threadId={thread.id} />
            </>
          ) : desktopLive && latest ? (
            <DesktopViewer key={latest.id} source={`/threads/${thread.id}/desktop`} title="The agent's desktop" onClose={() => setPanel(null)} />
          ) : (
            <p className="hint">The desktop is only there while a turn runs.</p>
          )}
        </section>
      ) : null}

      <div className="thread">
        {turns.map((t) => (
          <TurnView key={t.id} turn={t} events={events[t.id] ?? []} harness={thread.harness} now={now} />
        ))}
      </div>

      <form className="dock" onSubmit={send}>
        <div className="composer">
          {suggestions.length > 0 ? (
            <div className="suggest" role="listbox" id="commands" aria-label="Agent commands">
              {suggestions.map((name, i) => (
                <button
                  key={name}
                  id={`cmd-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === pick}
                  className="mono"
                  onMouseEnter={() => setPick(i)}
                  onClick={() => choose(name)}
                >
                  /{name}
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (suggestions.length > 0) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setPick((p) => (p + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
                  return;
                }
                if (e.key === "Tab" || e.key === "Enter") {
                  e.preventDefault();
                  choose(suggestions[pick]!);
                  return;
                }
                if (e.key === "Escape") {
                  setDraft("");
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={commands.length ? "Reply to the agent, or type / for its commands" : "Ask for a change, or a question about the code"}
            rows={1}
            maxLength={8000}
            aria-label="Message"
            aria-controls={suggestions.length ? "commands" : undefined}
            aria-activedescendant={suggestions.length ? `cmd-${pick}` : undefined}
          />
          <div className="composer-bar">
            <Picker
              ref={modelMenu}
              label="Model"
              icon={<AgentLogo harness={thread.harness} size={15} />}
              up
              searchable
              value={thread.model ?? "default"}
              placeholder={context.model ?? "Default"}
              options={[
                { value: "default", label: "Default", hint: !thread.model ? context.model : undefined, sub: by("Chosen by the agent") },
                ...(MODELS[thread.harness as HarnessId] ?? []).map((m) => ({ value: m.value, label: m.label, sub: by(m.hint) })),
              ]}
              custom={(q) => `Use ${q}`}
              note={busy ? "A new model applies from the next turn." : undefined}
              onChange={(v) => {
                setModel(v === "default" ? null : v);
                inputRef.current?.focus();
              }}
            />
            <EffortControl
              harness={thread.harness}
              value={thread.effort ?? null}
              up
              note={busy ? "A new effort applies from the next turn." : undefined}
              onChange={(effort) => saveSetting("effort", effort)}
            />
            {caps?.desktop || thread.desktop ? (
              <button
                type="button"
                className="pill"
                aria-pressed={Boolean(thread.desktop)}
                onClick={() => saveSetting("desktop", !thread.desktop)}
                title={thread.desktop ? "Turns get a virtual desktop. Click to turn it off from the next turn." : "Give the agent a virtual desktop and browser from the next turn"}
              >
                <Monitor size={14} />
                <span className="pill-text">{thread.desktop ? "Desktop on" : "Desktop"}</span>
              </button>
            ) : null}
            <span className="composer-meta">
              <Robot size={14} />
              {h.name}
            </span>
            {context.usage ? <ContextRing {...context.usage} /> : null}
            {total > 0 ? (
              <span className="composer-meta num" title={h.cost === "estimated" ? "Session total, estimated" : "Session total"}>
                {usd(total, h.cost === "estimated")}
              </span>
            ) : null}
            <span className="spacer" />
            {busy ? (
              <button type="button" className="send stop" onClick={cancel} disabled={latest?.cancelRequested} aria-label="Cancel turn" title="Cancel turn">
                <Stop size={15} weight="fill" />
              </button>
            ) : (
              <button type="submit" className="send" disabled={sending || !draft.trim()} aria-label="Send">
                <ArrowUp size={18} weight="bold" />
              </button>
            )}
          </div>
        </div>
        <div className="composer-note" data-tone={hint?.tone === "danger" ? "danger" : undefined} role={hint?.tone ? "alert" : undefined}>
          <span style={hint?.tone === "warn" ? { color: "var(--warn)" } : undefined}>{hint?.text ?? "Follow-ups continue on the same branch and pull request."}</span>
          <span className="hide-sm">
            <kbd>Enter</kbd> to send
          </span>
        </div>
        <div ref={bottomRef} />
      </form>
    </div>
  );
}
