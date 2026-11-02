// Importing a session from a coding agent run elsewhere (on a laptop, another
// cloud), so it carries on in Cloudly. Each agent keeps its conversation in its
// own format; this reads them all into one shape: turns, each a user message
// and what the agent wrote and did in reply.
//
//   Claude Code  ~/.claude/projects/<dir>/<session id>.jsonl
//   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl
//   Pi           ~/.pi/agent/sessions/--<dir>--/<time>_<session id>.jsonl
//   Gemini CLI   ~/.gemini/tmp/<project>/chats/session-*.json(l), or a checkpoint
//   OpenCode     `opencode export <session id>`
//   Anything     JSON {"messages":[{"role","content"}]}, or text with User:/Assistant: lines
//
// The same agent can resume its own session when Cloudly has the file (Claude
// Code, Codex, Pi); any other agent gets the conversation written into its
// prompt, the way a session that changes agents does.

export const IMPORT_SOURCES = {
  "claude-code": { name: "Claude Code", harness: "native-claude", native: true },
  codex: { name: "Codex", harness: "native-codex", native: true },
  pi: { name: "Pi", harness: "acp-pi", native: true },
  gemini: { name: "Gemini CLI", harness: "gemini-acp", native: false },
  opencode: { name: "OpenCode", harness: "acp-opencode", native: false },
  chat: { name: "A chat export", harness: null, native: false },
  text: { name: "A conversation", harness: null, native: false },
} as const satisfies Record<string, { name: string; harness: string | null; native: boolean }>;
export type ImportSource = keyof typeof IMPORT_SOURCES;

export type ImportStep = { t: "text"; text: string } | { t: "tool"; title: string };
export interface ImportTurn {
  prompt: string;
  steps: ImportStep[];
}
export interface ParsedSession {
  source: ImportSource;
  /** The agent's own id for the session: what resuming it natively needs. */
  sessionId?: string;
  title: string;
  /** The directory it ran in, rewritten to /workspace when it's resumed. */
  cwd?: string;
  gitBranch?: string;
  repoUrl?: string;
  /** The agent's own summary of what came before a compaction, if there was one. */
  summary?: string;
  turns: ImportTurn[];
  /** Turns left out: only the most recent MAX_TURNS are kept. */
  dropped: number;
}

export const IMPORT_LIMITS = {
  /** Bytes in one uploaded file. */
  fileBytes: 64 * 1024 * 1024,
  turns: 300,
  promptChars: 20_000,
  textChars: 20_000,
  stepsPerTurn: 150,
  toolChars: 200,
  summaryChars: 20_000,
};

type Json = Record<string, any>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
/** The last item that matches (Array.prototype.findLast, for older targets). */
function findLast<T>(list: T[], pred: (x: T) => unknown): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i]!)) return list[i];
  return undefined;
}
const str = (v: unknown) => (typeof v === "string" ? v : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [shortened]` : s);
const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Collects turns as a conversation is read. Anything the agent says before the first user message is dropped. */
class Turns {
  list: ImportTurn[] = [];
  user(prompt: string) {
    const p = prompt.trim();
    if (!p) return;
    this.list.push({ prompt: clip(p, IMPORT_LIMITS.promptChars), steps: [] });
  }
  text(text: string) {
    const t = text.trim();
    const turn = this.list.at(-1);
    if (!t || !turn || turn.steps.length >= IMPORT_LIMITS.stepsPerTurn) return;
    const last = turn.steps.at(-1);
    if (last?.t === "text") last.text = clip(`${last.text}\n\n${t}`, IMPORT_LIMITS.textChars);
    else turn.steps.push({ t: "text", text: clip(t, IMPORT_LIMITS.textChars) });
  }
  tool(title: string) {
    const turn = this.list.at(-1);
    const t = oneLine(title, IMPORT_LIMITS.toolChars);
    if (!t || !turn || turn.steps.length >= IMPORT_LIMITS.stepsPerTurn) return;
    turn.steps.push({ t: "tool", title: t });
  }
}

function finish(source: ImportSource, turns: Turns, meta: Omit<ParsedSession, "source" | "turns" | "dropped" | "title"> & { title?: string }): ParsedSession {
  const all = turns.list;
  const kept = all.slice(-IMPORT_LIMITS.turns);
  const first = all[0]?.prompt.split("\n").find((l) => l.trim()) ?? "";
  const title = oneLine(meta.title?.trim() || first || `${IMPORT_SOURCES[source].name} session`, 64);
  return {
    source,
    ...meta,
    summary: meta.summary ? clip(meta.summary.trim(), IMPORT_LIMITS.summaryChars) : undefined,
    title,
    turns: kept,
    dropped: all.length - kept.length,
  };
}

/** A tool call as one line: its name and the argument that says what it did. */
export function toolTitle(name: string, input: unknown): string {
  let args: unknown = input;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {}
  }
  if (!isObj(args)) return `${name} ${typeof args === "string" ? args : ""}`.trim();
  const command = Array.isArray(args.command) ? args.command.join(" ") : args.command ?? args.cmd;
  const what = command ?? args.file_path ?? args.filePath ?? args.path ?? args.absolute_path ?? args.pattern ?? args.query ?? args.url ?? args.description ?? args.prompt ?? "";
  return `${name} ${typeof what === "string" ? what : JSON.stringify(what)}`.trim();
}

/** The entries on the conversation's current branch, oldest first: from the last entry back through its parents. */
function activePath<T extends Json>(entries: T[], id: (e: T) => unknown, parent: (e: T) => unknown): T[] {
  const byId = new Map<unknown, T>();
  for (const e of entries) if (id(e) != null) byId.set(id(e), e);
  const leaf = entries.at(-1);
  if (!leaf || id(leaf) == null) return entries;
  const path: T[] = [];
  const seen = new Set<unknown>();
  for (let e: T | undefined = leaf; e && !seen.has(id(e)); e = byId.get(parent(e))) {
    seen.add(id(e));
    path.push(e);
  }
  return path.reverse();
}

const jsonl = (content: string): Json[] =>
  content.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const v = JSON.parse(line);
      return isObj(v) ? [v] : [];
    } catch {
      return [];
    }
  });

/** Text out of a message's content: a string, or blocks of {type:"text", text}. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return isObj(content) ? str(content.text) : "";
  return content
    .map((b) => (typeof b === "string" ? b : isObj(b) && (b.type === "text" || b.type === "input_text" || b.type === "output_text" || b.type === undefined) ? str(b.text) : isObj(b) && b.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

// ---------- Claude Code ----------

const CLAUDE_NOISE = /^(<local-command-(stdout|stderr|caveat)>|<system-reminder>|\[Request interrupted by user)/;

function parseClaude(lines: Json[]): ParsedSession {
  const entries = lines.filter((e) => typeof e.uuid === "string" && !e.isSidechain);
  // Compaction starts a new root that points at what it replaced through logicalParentUuid.
  const path = activePath(entries, (e) => e.uuid, (e) => e.parentUuid ?? e.logicalParentUuid);
  const turns = new Turns();
  let summary: string | undefined;
  for (const e of path) {
    const content = e.message?.content;
    if (e.type === "user") {
      if (e.isCompactSummary) {
        summary = contentText(content);
        continue;
      }
      if (e.isMeta) continue;
      if (Array.isArray(content) && content.some((b) => isObj(b) && b.type === "tool_result")) continue;
      const text = contentText(content).trim();
      if (!text || CLAUDE_NOISE.test(text)) continue;
      const command = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text);
      if (command) {
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
        turns.user(`/${command[1]}${args ? ` ${args}` : ""}`);
      } else {
        turns.user(text);
      }
    } else if (e.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (!isObj(b)) continue;
        if (b.type === "text") turns.text(str(b.text));
        else if (b.type === "tool_use") turns.tool(toolTitle(str(b.name), b.input));
      }
    }
  }
  const last = [...entries].reverse();
  const title = str(findLast(lines, (l) => l.type === "custom-title")?.customTitle) || str(findLast(lines, (l) => l.type === "summary")?.summary);
  return finish("claude-code", turns, {
    sessionId: str(last.find((e) => e.sessionId)?.sessionId) || undefined,
    cwd: str(last.find((e) => e.cwd)?.cwd) || undefined,
    gitBranch: str(last.find((e) => e.gitBranch)?.gitBranch) || undefined,
    title,
    summary,
  });
}

// ---------- Codex ----------

/** Codex puts its own context in user messages: the environment and AGENTS.md. */
const CODEX_CONTEXT = /^\s*(<environment_context>|<user_instructions>|<user_shell_command>|# AGENTS\.md instructions|<INSTRUCTIONS>)/;

function codexPatchTitle(input: string): string {
  const files = [...input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim());
  return files.length ? `Edit ${files.join(", ")}` : "Edit files";
}

function parseCodex(lines: Json[]): ParsedSession {
  // Each line is {timestamp, type, payload}; older files have the item itself on the line.
  const items: Json[] = lines.map((l) => (isObj(l.payload) ? { kind: str(l.type), ...l.payload } : { kind: "", ...l }));
  const meta = items.find((i) => i.kind === "session_meta") ?? (lines[0] && !lines[0].payload && lines[0].id && !lines[0].type ? lines[0] : undefined);
  const typedPrompts = items.some((i) => i.kind === "event_msg" && i.type === "user_message");
  const assistantItems = items.some((i) => i.type === "message" && i.role === "assistant");
  const turns = new Turns();
  let summary: string | undefined;
  for (const i of items) {
    if (i.kind === "event_msg") {
      if (i.type === "user_message" && !CODEX_CONTEXT.test(str(i.message))) turns.user(str(i.message));
      else if (i.type === "agent_message" && !assistantItems) turns.text(str(i.message));
      continue;
    }
    if (i.kind === "compacted") {
      summary = str(i.message) || summary;
      continue;
    }
    if (i.kind && i.kind !== "response_item") continue;
    if (i.type === "message") {
      const text = contentText(i.content);
      if (i.role === "user" && !typedPrompts && !CODEX_CONTEXT.test(text)) turns.user(text);
      else if (i.role === "assistant") turns.text(text);
    } else if (i.type === "function_call") {
      const name = str(i.name);
      if (name === "apply_patch") {
        let input = str(i.arguments);
        try {
          input = str(JSON.parse(input).input) || input;
        } catch {}
        turns.tool(codexPatchTitle(input));
      } else turns.tool(toolTitle(/^(shell|exec_command|shell_command|container\.exec)$/.test(name) ? "Bash" : name, i.arguments));
    } else if (i.type === "custom_tool_call") {
      turns.tool(i.name === "apply_patch" ? codexPatchTitle(str(i.input)) : toolTitle(str(i.name), i.input));
    } else if (i.type === "local_shell_call") {
      turns.tool(toolTitle("Bash", i.action));
    } else if (i.type === "web_search_call") {
      turns.tool(`Web search ${str(i.action?.query)}`);
    }
  }
  return finish("codex", turns, {
    sessionId: str(meta?.id) || undefined,
    cwd: str(meta?.cwd) || str(findLast(items, (i) => i.kind === "turn_context")?.cwd) || undefined,
    gitBranch: str(meta?.git?.branch) || undefined,
    repoUrl: str(meta?.git?.repository_url) || undefined,
    summary,
  });
}

// ---------- Pi ----------

function parsePi(lines: Json[]): ParsedSession {
  const header = lines.find((l) => l.type === "session") ?? {};
  const entries = lines.filter((l) => l.type !== "session" && typeof l.id === "string");
  const path = activePath(entries, (e) => e.id, (e) => e.parentId);
  const turns = new Turns();
  let summary: string | undefined;
  let title = "";
  for (const e of entries) if (e.type === "session_info" && typeof e.name === "string") title = e.name;
  for (const e of path) {
    if (e.type === "compaction" || e.type === "branch_summary") {
      summary = str(e.summary) || summary;
      continue;
    }
    if (e.type !== "message" || !isObj(e.message)) continue;
    const m = e.message;
    if (m.role === "user") turns.user(contentText(m.content));
    else if (m.role === "bashExecution") turns.tool(`Bash ${str(m.command)}`);
    else if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!isObj(b)) continue;
        if (b.type === "text") turns.text(str(b.text));
        else if (b.type === "toolCall") turns.tool(toolTitle(str(b.name), b.arguments));
      }
    }
  }
  return finish("pi", turns, { sessionId: str(header.id) || undefined, cwd: str(header.cwd) || undefined, title, summary });
}

// ---------- Gemini CLI ----------

function geminiParts(parts: unknown): { text: string; calls: string[] } {
  if (typeof parts === "string") return { text: parts, calls: [] };
  const list = Array.isArray(parts) ? parts : isObj(parts) ? [parts] : [];
  const text: string[] = [];
  const calls: string[] = [];
  for (const p of list) {
    if (typeof p === "string") text.push(p);
    else if (isObj(p) && typeof p.text === "string" && !p.thought) text.push(p.text);
    else if (isObj(p) && isObj(p.functionCall)) calls.push(toolTitle(str(p.functionCall.name), p.functionCall.args));
  }
  return { text: text.join("\n"), calls };
}

function parseGemini(records: Json[], meta: Json): ParsedSession {
  const turns = new Turns();
  for (const r of records) {
    // A chat log has type user/gemini; a checkpoint has role user/model with parts.
    const role = r.type ?? r.role;
    const { text, calls } = geminiParts(r.content ?? r.parts);
    if (role === "user") {
      if (text.trim()) turns.user(text);
    } else if (role === "gemini" || role === "model") {
      turns.text(text);
      for (const c of calls) turns.tool(c);
      for (const t of Array.isArray(r.toolCalls) ? r.toolCalls : []) {
        if (isObj(t)) turns.tool(toolTitle(str(t.displayName) || str(t.name), t.args));
      }
    }
  }
  return finish("gemini", turns, { sessionId: str(meta.sessionId) || undefined, cwd: str(meta.directory) || undefined, title: str(meta.summary) });
}

// ---------- OpenCode (opencode export) ----------

function parseOpenCode(doc: Json): ParsedSession {
  const turns = new Turns();
  for (const m of Array.isArray(doc.messages) ? doc.messages : []) {
    if (!isObj(m)) continue;
    const role = m.info?.role;
    const parts = Array.isArray(m.parts) ? m.parts : [];
    if (role === "user") {
      turns.user(parts.filter((p: Json) => p?.type === "text" && !p.synthetic && !p.ignored).map((p: Json) => str(p.text)).join("\n"));
    } else if (role === "assistant") {
      for (const p of parts) {
        if (!isObj(p)) continue;
        if (p.type === "text" && !p.synthetic) turns.text(str(p.text));
        else if (p.type === "tool") turns.tool(toolTitle(str(p.tool), p.state?.input));
      }
    }
  }
  return finish("opencode", turns, { sessionId: str(doc.info?.id) || undefined, cwd: str(doc.info?.directory) || undefined, title: str(doc.info?.title) });
}

// ---------- Any agent: chat JSON, or text ----------

const USER_ROLES = new Set(["user", "human"]);
const AGENT_ROLES = new Set(["assistant", "model", "ai", "agent", "bot"]);

function parseChat(messages: unknown[], meta: Json): ParsedSession {
  const turns = new Turns();
  for (const m of messages) {
    if (!isObj(m)) continue;
    const role = String(m.role ?? m.author ?? m.from ?? "").toLowerCase();
    const text = contentText(m.content ?? m.text ?? m.message);
    if (USER_ROLES.has(role)) turns.user(text);
    else if (AGENT_ROLES.has(role)) {
      turns.text(text);
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (isObj(c)) turns.tool(toolTitle(str(c.function?.name ?? c.name), c.function?.arguments ?? c.arguments ?? c.input));
      }
    }
  }
  return finish("chat", turns, { title: str(meta.title), sessionId: str(meta.id) || undefined });
}

const SPEAKER = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(user|human|me|assistant|ai|agent|model|claude|codex|gemini|pi|opencode)(?:\*\*)?\s*(?::|$)(?:\*\*)?\s?(.*)$/i;

function parseText(content: string): ParsedSession {
  const turns = new Turns();
  let who: "user" | "agent" | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (who === "user") turns.user(buf.join("\n"));
    else if (who === "agent") turns.text(buf.join("\n"));
    buf = [];
  };
  let before: string[] = [];
  for (const line of content.split("\n")) {
    const m = SPEAKER.exec(line);
    // A heading form needs nothing after it; "User: ..." needs the colon, so prose starting "Pi is" isn't a speaker.
    if (m && (line.includes(":") || /^\s*#/.test(line))) {
      flush();
      who = USER_ROLES.has(m[1]!.toLowerCase()) || m[1]!.toLowerCase() === "me" ? "user" : "agent";
      if (m[2]) buf.push(m[2]);
    } else if (who) buf.push(line);
    else before.push(line);
  }
  flush();
  // Nothing that reads as a conversation: keep it all as background.
  const summary = turns.list.length ? before.join("\n").trim() || undefined : content.trim();
  return finish("text", turns, { summary });
}

/** Reads an exported or saved session, whichever agent wrote it. */
export function parseSession(name: string, content: string): ParsedSession | { error: string } {
  if (content.length > IMPORT_LIMITS.fileBytes) return { error: "That file is too big to import (64 MB at most)." };
  const trimmed = content.trim();
  if (!trimmed) return { error: "That file is empty." };

  // One JSON document.
  if (/^[[{]/.test(trimmed)) {
    let doc: unknown;
    try {
      doc = JSON.parse(trimmed);
    } catch {}
    if (isObj(doc)) {
      if (isObj(doc.info) && Array.isArray(doc.messages)) return parseOpenCode(doc);
      if (Array.isArray(doc.messages) && doc.messages.some((m: unknown) => isObj(m) && (m.type === "gemini" || (m.type === "user" && !("role" in m))))) {
        return parseGemini(doc.messages, doc);
      }
      if (Array.isArray(doc.messages)) return parseChat(doc.messages, doc);
    }
    if (Array.isArray(doc)) {
      if (doc.some((m) => isObj(m) && Array.isArray(m.parts))) return parseGemini(doc, {});
      return parseChat(doc, {});
    }
  }

  // JSON lines.
  const lines = jsonl(content);
  if (lines.length >= 1 && lines.length >= content.split("\n").filter((l) => l.trim()).length * 0.8) {
    if (lines.some((l) => l.type === "session" && "version" in l) && lines.some((l) => l.type === "message")) return parsePi(lines);
    if (lines.some((l) => l.type === "session_meta" || l.type === "response_item" || l.type === "event_msg")) return parseCodex(lines);
    if (lines.some((l) => typeof l.uuid === "string" && typeof l.sessionId === "string")) return parseClaude(lines);
    if (lines.some((l) => l.type === "gemini" || (l.type === "user" && l.content !== undefined && !l.message))) {
      return parseGemini(lines, lines.find((l) => l.sessionId && !l.type) ?? lines.find((l) => l.sessionId) ?? {});
    }
    // An older Codex file: the session's details first, then the items.
    if (lines[0]?.id && lines[0]?.timestamp && lines.some((l) => l.type === "message" && l.role)) return parseCodex(lines);
    if (lines.every((l) => "role" in l)) return parseChat(lines, {});
    return { error: `Couldn't tell which agent wrote ${name}. Import a Claude Code, Codex, Pi, Gemini CLI or OpenCode session, or a file of {"role","content"} messages.` };
  }

  return parseText(content);
}

/** Whether Cloudly can hand the file back to the agent that wrote it, to resume its own session. */
export function canResumeNatively(s: ParsedSession): boolean {
  return IMPORT_SOURCES[s.source].native && Boolean(s.sessionId) && Boolean(s.cwd);
}

/** owner/repo from a git remote's URL, when it's GitHub. */
export function githubRepoFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The session file with the directory it ran in replaced by /workspace, where
 * Cloudly's sandbox has the repo, so the resumed agent's paths point at real files.
 * Only whole path segments: /home/me/app doesn't turn /home/me/app2 into /workspace2.
 */
export function rewriteCwd(content: string, cwd: string, to = "/workspace"): string {
  if (!cwd || cwd === "/" || cwd === to) return content;
  // As it appears inside JSON strings (Windows paths have their backslashes escaped).
  const escaped = JSON.stringify(cwd).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(new RegExp(`${escaped}(?=[/\\\\"'\`\\s:)]|$)`, "g"), to);
}

/**
 * How the earlier, imported part of a session reads in an agent's prompt: the
 * agent's own summary if it compacted, then the turns. Kept to `budget` characters,
 * the most recent turns first.
 */
export function importedHistory(turns: { prompt: string; reply: string; tools?: string[] }[], summary: string | null | undefined, budget = 24_000): string {
  const parts: string[] = [];
  let used = 0;
  for (const t of [...turns].reverse()) {
    const tools = t.tools?.length ? `\n(${t.tools.slice(0, 12).join("; ")}${t.tools.length > 12 ? `; and ${t.tools.length - 12} more` : ""})` : "";
    const block = `User: ${clip(t.prompt, 2000)}\nYou: ${t.reply ? clip(t.reply, 3000) : "(no written reply)"}${tools}`;
    if (used + block.length > budget && parts.length) break;
    parts.unshift(block);
    used += block.length;
  }
  const left = turns.length - parts.length;
  return [
    summary ? `Summary of the earliest part:\n${clip(summary, 8000)}` : "",
    left > 0 ? `(${left} earlier turn${left === 1 ? "" : "s"} not shown.)` : "",
    parts.join("\n\n"),
  ].filter(Boolean).join("\n\n");
}
