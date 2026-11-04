"use client";

import Link from "next/link";
import { RichMarkdown } from "@/components/rich-markdown";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  ArrowUp,
  CaretRight,
  CloudSlash,
  FileText,
  FolderSimple,
  ArrowBendDownRight,
  Laptop,
  Monitor,
  AppWindow,
  ChatsCircle,
  ArrowBendUpLeft,
  Scales,
  Notebook,
  GitBranch,
  GitDiff,
  GitMerge,
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
import { type ArtifactMeta, api, ApiError, type Capabilities, type ThreadView, type Turn } from "@/lib/api";
import { harnessById, MODELS, STATUS_LABEL, usd, type HarnessId, type RunStatus } from "@/lib/harness";
import { buildBlocks, showsError, type Block, type StreamEvent } from "@/lib/events";
import { StatusIcon } from "@/components/status";
import { Picker } from "@/components/picker";
import { AgentLogo, providerOf } from "@/components/agent-logo";
import { EffortControl } from "@/components/effort-control";
import { PEER_SCOPES, PEER_SCOPE_LABEL, type PeerScope } from "@repo/shared/sessions";
import { FilesPanel } from "@/components/files-panel";
import { PreviewPanel } from "@/components/preview-panel";
import { DesktopViewer } from "@/components/desktop-viewer";
import { ContextPanel } from "@/components/context-panel";
import { ChecksBadge, ChecksDetail, FixRequest } from "@/components/checks";
import { ReviewRequest, ReviewResult, TriggerNote, CiFixRequest } from "@/components/review";
import { CheckpointRequest, ForkBanner, ImportBanner, TurnMenu } from "@/components/checkpoints";
import { TurnArtifacts } from "@/components/artifacts";
import { HandoffPanel } from "@/components/handoff-panel";
import { setSessionInfo } from "@/lib/workspace";
import { ChangesPanel } from "@/components/changes-panel";

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
              <RichMarkdown>{b.text}</RichMarkdown>
            </div>
          );
        if (b.t === "steer")
          return (
            <div key={i} className="msg-user msg-steer">
              <span className="msg-from">
                <ArrowBendDownRight size={14} />
                Sent while it worked
              </span>
              <div>{b.text}</div>
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
                    <RichMarkdown>{b.report}</RichMarkdown>
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

function TurnView({
  turn,
  events,
  harness: sessionHarness,
  now,
  onOpenChanges,
  checkpoint,
  artifacts,
}: {
  turn: Turn;
  events: StreamEvent[];
  harness: string;
  now: number;
  onOpenChanges: () => void;
  /** Rewind and fork, for a finished turn. */
  checkpoint?: { threadId: string; canRewind: boolean; rewindNote?: string };
  /** The session's artifacts; the turn shows the ones it wrote. */
  artifacts?: ArtifactMeta[];
}) {
  // A review runs with the repo's reviewer, not the session's agent.
  const harness = turn.harness ?? sessionHarness;
  const h = harnessById(harness);
  const blocks = useMemo(() => buildBlocks(events, harness), [events, harness]);
  const active = ACTIVE.includes(turn.status);
  const status = turn.cancelRequested && active ? "Cancelling" : turn.status === "succeeded" && !turn.prUrl ? "Done" : STATUS_LABEL[turn.status];
  // Messages this turn's agent sent other sessions.
  const sent = useMemo(() => {
    const e = events.find((x) => x.kind === "status" && (x.data as { type?: string } | null)?.type === "sessions.sent");
    return ((e?.data as { to?: { id: string; title: string; replyWanted: boolean }[] } | undefined)?.to ?? []).filter((t) => typeof t?.id === "string");
  }, [events]);

  return (
    <article className="turn" data-rewound={turn.rewoundAt ? true : undefined}>
      {turn.rewoundAt ? <div className="rewound-tag">Rewound</div> : null}
      {turn.kind === "fork" ? null : turn.kind === "rewind" || turn.kind === "import" || turn.kind === "screenshots" ? (
        <CheckpointRequest turn={turn} />
      ) : turn.kind === "fix" ? (
        <FixRequest turn={turn} agent={h.name} />
      ) : turn.kind === "ci_fix" ? (
        <CiFixRequest turn={turn} agent={h.name} />
      ) : turn.kind === "review" || turn.kind === "review_fix" ? (
        <ReviewRequest turn={turn} agent={harnessById(sessionHarness).name} reviewer={h.name} />
      ) : (
      <div className="msg-user">
        {turn.from ? (
          <Link className="msg-from" href={`/app/s/${turn.from.threadId}`}>
            <ChatsCircle size={14} />
            From session {turn.from.title ? `"${turn.from.title}"` : "(removed)"}
            {turn.replyToThreadId ? ", which asked for a reply" : ""}
          </Link>
        ) : null}
        <TriggerNote turn={turn} />
        {turn.kind === "audit" ? (
          <span className="msg-from">
            <MagnifyingGlass size={14} />
            Audit of the whole repo
          </span>
        ) : null}
        <div>{turn.prompt}</div>
      </div>
      )}

      <div className="msg-agent">
        <Blocks blocks={blocks} live={active} />
        {artifacts?.length ? <TurnArtifacts turnId={turn.id} all={artifacts} /> : null}

        {active && blocks.length === 0 ? (
          <p className="shimmer-text" role="status" style={{ fontSize: 14, justifySelf: "start" }}>
            {turn.status === "queued" ? "Waiting for the worker to pick this up" : "Thinking"}
          </p>
        ) : null}

        {turn.error && !showsError(blocks, turn.error) ? (
          <div className="notice" data-tone="danger" role="alert">
            <WarningCircle size={16} weight="bold" />
            {turn.error}
          </div>
        ) : null}

        {turn.error && /free usage limit/i.test(turn.error) && harness.includes("opencode") ? (
          <p className="hint">
            OpenCode caps how much its free models can be used, and the cap resets after some hours. To keep going, add an OpenCode key (Zen credit or the Go plan,
            from opencode.ai/auth) or a vendor key under <Link href="/app/settings/agents">Settings → Agents → OpenCode</Link>, or pick another agent.
          </p>
        ) : null}

        <footer className="turn-foot">
          <span className="status">
            <StatusIcon status={turn.status} pr={Boolean(turn.prUrl)} size={14} />
            {status}
          </span>
          {active ? <span className="num">{elapsed(turn.createdAt, now)}</span> : null}
          {turn.kind === "import_turn" ? <span className="imported-tag">Imported</span> : null}
          {turn.kind === "rewind" || turn.kind === "fork" || turn.kind === "import" || turn.kind === "import_turn" || turn.kind === "screenshots" ? null : turn.onPlan ? (
            <span>On your plan</span>
          ) : turn.costUsd !== null ? (
            <span className="num" title={h.cost === "estimated" ? "Estimated from token counts" : "Reported by the agent"}>
              {usd(turn.costUsd, h.cost === "estimated")}
              {h.cost === "estimated" ? " est." : ""}
            </span>
          ) : null}
          <ChecksBadge turn={turn} events={events} active={active} />
          {turn.filesChanged ? (
            <span className="num diffstat" title={`${turn.filesChanged} file${turn.filesChanged === 1 ? "" : "s"} changed`}>
              <span className="add">+{turn.additions ?? 0}</span> <span className="del">−{turn.deletions ?? 0}</span>
            </span>
          ) : null}
          {sent.map((t) => (
            <Link key={t.id} href={`/app/s/${t.id}`} className="pr-chip" title={t.replyWanted ? "Its answer comes back here as a new turn" : "No reply asked for"}>
              {t.replyWanted ? <ArrowBendUpLeft size={13} weight="bold" /> : <ChatsCircle size={13} />}
              Sent to {t.title}
            </Link>
          ))}
          {turn.prUrl ? (
            <a href={turn.prUrl} target="_blank" rel="noreferrer" className="pr-chip">
              <GitPullRequest size={14} weight="bold" />
              Pull request
              <ArrowSquareOut size={12} />
            </a>
          ) : null}
          {checkpoint ? <TurnMenu threadId={checkpoint.threadId} turn={turn} harness={sessionHarness} canRewind={checkpoint.canRewind} rewindNote={checkpoint.rewindNote} /> : null}
        </footer>
        <ChecksDetail turn={turn} events={events} />
        {turn.kind === "review" || turn.kind === "audit" ? <ReviewResult turn={turn} events={events} onOpen={onOpenChanges} /> : null}
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

/**
 * One session: its turns, the composer and its panels. Shown in a pane of the
 * session workspace, which is what scrolls; `active` is whether it's on screen.
 */
export function SessionView({ id, active = true }: { id: string; active?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  // The pane's scroll container (the window, outside the workspace).
  const scroller = () => (rootRef.current?.closest(".pane-body") as HTMLElement | null) ?? null;
  const scrollToEnd = (smooth = false) => {
    const el = scroller();
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    else window.scrollTo({ top: document.documentElement.scrollHeight });
  };
  const scrollToTop = () => {
    const el = scroller();
    if (el) el.scrollTo({ top: 0, behavior: "smooth" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const [view, setView] = useState<ThreadView | null>(null);
  const [events, setEvents] = useState<Record<string, StreamEvent[]>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pick, setPick] = useState(0);
  const [panel, setPanel] = useState<"changes" | "files" | "preview" | "desktop" | "context" | "local" | null>(null);
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
  // Added agents list the models they offer at the start of each turn.
  const context = useMemo(() => {
    let model: string | undefined;
    let usage: { tokens: number; max: number; percentage: number } | undefined;
    let offered: { value: string; label: string }[] = [];
    let efforts: { current?: string; options: { value: string; label: string }[] } | null = null;
    for (const list of Object.values(events)) {
      for (const e of list) {
        const d = e.data as Record<string, unknown> | null;
        if (!d || typeof d !== "object") continue;
        if (typeof d.model === "string" && (d.subtype === "init" || d.type === "context")) model = d.model;
        if (d.type === "models" && Array.isArray(d.options)) {
          if (typeof d.current === "string") model = d.current;
          offered = (d.options as { value?: unknown; label?: unknown }[])
            .filter((o) => typeof o?.value === "string")
            .map((o) => ({ value: String(o.value), label: typeof o.label === "string" ? o.label : String(o.value) }));
        }
        if (d.type === "efforts" && Array.isArray(d.options)) {
          efforts = {
            current: typeof d.current === "string" ? d.current : undefined,
            options: (d.options as { value?: unknown; label?: unknown }[])
              .filter((o) => typeof o?.value === "string")
              .map((o) => ({ value: String(o.value), label: typeof o.label === "string" ? o.label : String(o.value) })),
          };
        }
        if (d.type === "context" && typeof d.tokens === "number" && typeof d.max === "number") {
          usage = { tokens: d.tokens, max: d.max, percentage: Number(d.percentage) || 0 };
        }
      }
    }
    return { model, usage, offered, efforts };
  }, [events]);

  // Follow new output only while the reader is already at the bottom.
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => (stickRef.current = Boolean(e?.isIntersecting)), { root: scroller(), rootMargin: "0px 0px 160px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [view !== null]);

  // To the page's real bottom: an anchor above the sticky composer would leave
  // the newest output hidden behind it.
  useEffect(() => {
    if (stickRef.current) scrollToEnd();
  }, [eventCount, view?.turns.length]);

  // While typing a command name: "/" alone or "/co", but not once arguments start.
  const typing = /^\/([\w:.-]*)$/.exec(draft);
  const suggestions = typing ? commands.filter((c) => c.startsWith(typing[1]!) && c !== typing[1]).slice(0, 10) : [];
  useEffect(() => setPick(0), [suggestions.length]);

  // Looking at a session reads it: when it opens, and when a turn ends while it's in view.
  const lastTurn = view?.turns.at(-1);
  const seenKey = view ? `${lastTurn?.id ?? ""}:${lastTurn?.status ?? ""}` : "";
  useEffect(() => {
    if (!seenKey || !active) return;
    const mark = () => {
      if (document.visibilityState === "visible") api(`/threads/${id}`, { method: "PATCH", body: JSON.stringify({ seen: true }) }).catch(() => {});
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [id, seenKey, active]);

  // Its tab's title and status.
  useEffect(() => {
    if (view) setSessionInfo([{ id, title: view.thread.title, lastStatus: view.turns.at(-1)?.status, prUrl: view.thread.prUrl }]);
  }, [id, view]);

  if (loadError) {
    return (
      <div className="center-state" ref={rootRef}>
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
      <div className="chat" aria-busy="true" ref={rootRef}>
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
  const toggle = (p: NonNullable<typeof panel>) => {
    const opening = panel !== p;
    setPanel(opening ? p : null);
    // The panel opens above the conversation, which is usually scrolled to its end.
    if (opening) window.requestAnimationFrame(() => rootRef.current?.querySelector(".side-panel")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const total = turns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  // The latest review's findings, as a count on the Changes button.
  const lastReview = [...turns].reverse().find((t) => t.kind === "review" || t.kind === "audit");
  // The latest turn that wasn't undone: nothing after it to rewind.
  const lastLiveTurn = [...turns].reverse().find((t) => !t.rewoundAt && t.kind !== "rewind" && t.kind !== "fork" && t.kind !== "import" && t.kind !== "screenshots");
  // Of an imported conversation, only the last turn has its code (the code as it was imported).
  const lastImported = [...turns].reverse().find((t) => t.kind === "import_turn");
  const openFindings = lastReview?.status === "succeeded" && lastReview.output ? Number(/(\d+) blocking/.exec(lastReview.output)?.[1] ?? 0) + Number(/(\d+) suggestions?/.exec(lastReview.output)?.[1] ?? 0) : 0;

  // A /word the agent didn't announce isn't a command in this mode (interactive-only
  // ones like /stats or /plan): it would go to the model as text, which then improvises.
  const typed = /^\/([\w:.-]+)(\s|$)/.exec(draft)?.[1];
  const unknownCommand =
    typed && typed.toLowerCase() !== "model" && commands.length > 0 && !commands.includes(typed) && !commands.some((c) => c.startsWith(typed + " ")) && suggestions.length === 0 ? typed : null;

  async function send(e?: React.FormEvent, text = draft, after = false) {
    e?.preventDefault();
    // A bare "/model" opens the model menu instead of asking the agent.
    if (text === draft && /^\/model\s*$/i.test(text.trim())) {
      setDraft("");
      modelMenu.current?.show();
      return;
    }
    if (!text.trim() || sending) return;
    setSending(true);
    setActionError(null);
    try {
      // While a turn runs, the agent gets it now (the API decides); "after" waits for the turn to end.
      await api(`/threads/${id}/messages`, { method: "POST", body: JSON.stringify({ prompt: text, ...(after ? { after: true } : {}) }) });
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
  async function saveSetting(field: "model" | "effort" | "desktop" | "peers" | "autoMerge", value: string | boolean | null) {
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
            ? { tone: undefined, text: "The agent is working. What you send now goes to it as it works; it takes it in at its next step." }
            : null;

  return (
    <div className="chat" ref={rootRef}>
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
          <button type="button" className="btn btn-secondary btn-sm" aria-pressed={panel === "changes"} onClick={() => toggle("changes")} title="What this session changed, the reviewer's findings, and your comments" aria-label="Changes">
            <GitDiff size={15} />
            <span className="hide-sm">Changes</span>
            {openFindings ? <span className="count num">{openFindings}</span> : null}
          </button>
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
          <button type="button" className="btn btn-secondary btn-sm" aria-pressed={panel === "local"} onClick={() => toggle("local")} title="Continue this session on your computer" aria-label="On your computer">
            <Laptop size={15} />
            <span className="hide-sm">Local</span>
          </button>
          {thread.prUrl && (thread.mergedAt || thread.autoMerge) ? (
            <span className="merge-chip" data-merged={thread.mergedAt ? true : undefined} title={thread.mergedAt ? "Merged by Cloudly when it was ready" : "Merge when ready is on"}>
              <GitMerge size={14} weight="bold" />
              <span className="hide-sm">{thread.mergedAt ? "Merged" : thread.mergeStatus ?? "Merge when ready"}</span>
            </span>
          ) : null}
          {thread.prUrl ? (
            <a href={thread.prUrl} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
              <GitPullRequest size={15} weight="bold" style={{ color: "var(--ok)" }} />
              <span className="hide-sm">Pull request</span>
            </a>
          ) : null}
        </div>
      </header>

      {panel ? (
        <section
          className="side-panel"
          data-wide={panel === "changes" || undefined}
          aria-label={panel === "changes" ? "Changes" : panel === "files" ? "Repo files" : panel === "preview" ? "Preview" : panel === "context" ? "Shared context" : panel === "local" ? "On your computer" : "Desktop"}
        >
          {panel === "changes" ? (
            <>
              <h2>Changes</h2>
              <ChangesPanel threadId={thread.id} agent={h.name} busy={busy} version={`${turns.length}:${latest?.status ?? ""}`} audit={turns[0]?.kind === "audit"} />
            </>
          ) : panel === "context" ? (
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
          ) : panel === "local" ? (
            <>
              <h2>Continue on your computer</h2>
              <HandoffPanel threadId={thread.id} harness={thread.harness} busy={busy} />
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
        {thread.forkOf ? <ForkBanner forkOf={thread.forkOf} /> : null}
        {thread.imported ? <ImportBanner imported={thread.imported} harness={thread.harness} settingUp={turns.some((t) => t.kind === "import" && ACTIVE.includes(t.status))} /> : null}
        {turns.map((t) => (
          <TurnView
            key={t.id}
            turn={t}
            events={events[t.id] ?? []}
            harness={thread.harness}
            now={now}
            artifacts={thread.artifacts}
            checkpoint={
              !t.rewoundAt && t.kind !== "rewind" && t.kind !== "fork" && t.kind !== "import" && t.kind !== "screenshots" && (t.kind !== "import_turn" || t.id === lastImported?.id) && !ACTIVE.includes(t.status)
                ? {
                    threadId: thread.id,
                    canRewind: !busy && !thread.mergedAt && t.id !== lastLiveTurn?.id,
                    rewindNote: busy ? "Wait for the current turn" : thread.mergedAt ? "The pull request is merged" : "This is the latest turn",
                  }
                : undefined
            }
            onOpenChanges={() => {
              setPanel("changes");
              scrollToTop();
            }}
          />
        ))}
      </div>

      <form className="dock" onSubmit={send}>
        {thread.needsInput && !busy ? (
          <div className="notice needs-you" data-tone="warn" role="status">
            <ChatsCircle size={16} weight="bold" />
            <span>
              <strong>The agent needs your answer:</strong> {thread.needsInput}
            </span>
          </div>
        ) : null}
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
                ...(MODELS[thread.harness as HarnessId] ?? context.offered).map((m: { value: string; label: string; hint?: string }) => ({ value: m.value, label: m.label, sub: by(m.hint) })),
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
              offered={context.efforts}
              up
              note={busy ? "A new effort applies from the next turn." : undefined}
              onChange={(effort) => saveSetting("effort", effort)}
            />
            <Picker
              label="Other sessions"
              icon={<ChatsCircle size={14} />}
              up
              value={thread.peers ?? "repo"}
              options={PEER_SCOPES.map((s: PeerScope) => ({
                value: s,
                label: PEER_SCOPE_LABEL[s],
                sub: (
                  <span className="dim">
                    {s === "repo" ? "Its agent can read and message them" : s === "all" ? "Every repo's, so it can bring their work here" : "It can't see or message any"}
                  </span>
                ),
              }))}
              note="Which of your sessions this one's agent may read and send messages to. Applies from the next turn."
              onChange={(v) => saveSetting("peers", v)}
            />
            <button
              type="button"
              className="pill"
              aria-pressed={Boolean(thread.autoMerge)}
              disabled={Boolean(thread.mergedAt)}
              onClick={() => saveSetting("autoMerge", !thread.autoMerge)}
              title={
                thread.mergedAt
                  ? "Merged"
                  : thread.autoMerge
                    ? `Cloudly merges the pull request once checks, review and CI pass. ${thread.mergeStatus ?? ""}`.trim()
                    : "Merge the pull request once checks, review and CI pass"
              }
            >
              <GitMerge size={14} />
              <span className="pill-text">{thread.mergedAt ? "Merged" : "Merge when ready"}</span>
            </button>
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
            {busy && draft.trim() ? (
              <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => send(undefined, draft, true)} disabled={sending} title="Send it as the next turn instead">
                  After this turn
                </button>
                <button type="submit" className="send" disabled={sending} aria-label="Send to the agent now" title="Send to the agent now: it takes it in as it works">
                  <ArrowUp size={18} weight="bold" />
                </button>
              </>
            ) : busy ? (
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
