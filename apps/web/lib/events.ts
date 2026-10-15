export interface StreamEvent {
  seq: number;
  kind: "status" | "text" | "tool_call" | "tool_result" | "raw" | "error" | "done" | "pr";
  data: unknown;
  ts: string;
}

function clip(s: string, n = 280) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** One readable line per event, across the three harnesses' event shapes. */
export function describeEvent(e: StreamEvent): string {
  const d = e.data as Record<string, any> | string | null;
  if (typeof d === "string") return clip(d);
  if (!d) return e.kind;

  switch (e.kind) {
    case "tool_call": {
      if (d.title && !d.input) return clip(String(d.title));
      if (d.name && d.input) return clip(`${d.name}  ${str(d.input.command ?? d.input.file_path ?? d.input.dir_path ?? d.input.path ?? d.input.pattern ?? d.input)}`);
      if (d.type === "command_execution") return clip(`command  ${d.command ?? ""}`);
      if (d.title || d.name) return clip(`${d.name ?? "tool"}  ${d.title ?? ""}`);
      return clip(str(d));
    }
    case "tool_result": {
      if (Array.isArray(d.content)) {
        const first = d.content[0] as Record<string, any> | undefined;
        if (first?.type === "diff" && first.path) return `edited ${String(first.path).replace(/^\/workspace\//, "")}`;
        const text = first?.content?.text ?? first?.text;
        if (typeof text === "string" && text.trim()) return clip(text, 140);
        return d.status === "completed" || !d.status ? "done" : String(d.status);
      }
      if ("content" in d && d.toolUseId) return clip(str(d.content));
      if (d.type === "command_execution") return clip(`exit ${d.exit_code ?? "?"}  ${d.aggregated_output ?? ""}`);
      if (d.type === "file_change") return clip(`changed ${(d.changes ?? []).map((c: any) => c.path).join(", ")}`);
      if (d.status) return clip(`${d.status}  ${str(d.output ?? d.content ?? "")}`);
      return clip(str(d));
    }
    case "status":
      if (d.subtype === "init") return `Session started${d.model ? ` · ${d.model}` : ""}`;
      if (d.type === "thread.started") return "Thread started";
      if (d.type === "turn.started") return "Turn started";
      return clip(str(d));
    case "done":
      return typeof d.totalCostUsd === "number" ? "Turn complete · cost reported" : "Turn complete";
    case "error":
      return clip(d.message ?? str(d));
    default:
      return clip(str(d));
  }
}

export interface ToolItem {
  call: string;
  result?: string;
}

export interface SubagentBlock {
  t: "subagent";
  id: string;
  /** The subagent's type, e.g. "general-purpose" or one defined in the repo's .claude/agents. */
  kind: string;
  description: string;
  blocks: Block[];
  done: boolean;
  /** What the subagent handed back to the main agent. */
  report?: string;
}

export type Block =
  | { t: "text"; text: string }
  | { t: "thought"; text: string }
  | { t: "tools"; items: ToolItem[] }
  | { t: "error"; text: string }
  | SubagentBlock;

// Claude starts a subagent with its Agent tool (named Task in older versions).
const SPAWN = new Set(["Agent", "Task"]);

/**
 * A subagent's hand-back is its report inside a framing note ("... The report
 * follows:" then the report, every line indented two spaces). Show the report.
 */
export function subagentReport(content: unknown): string {
  const text = Array.isArray(content)
    ? content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n")
    : typeof content === "string"
      ? content
      : "";
  const at = text.indexOf("The report follows:\n");
  if (at === -1) return text.trim();
  return text
    .slice(at + "The report follows:\n".length)
    .split("\n")
    .map((line) => line.replace(/^ {2}/, ""))
    .join("\n")
    .trim();
}

const idOf = (d: Record<string, any>) => (typeof d.toolUseId === "string" ? d.toolUseId : typeof d.id === "string" ? d.id : undefined);

/**
 * Folds one turn's raw events into what a chat shows: replies as prose,
 * reasoning folded away, tool calls grouped with their results, and each
 * subagent's work nested under the call that started it.
 * Results pair with their call by id; all three agents send one (Claude's
 * tool_use id, Codex's item id, ACP's toolCallId). A call seen again under the
 * same id (Codex reports a command when it starts and as it runs) updates its row.
 * Gemini streams its reply in fragments that join with nothing between them;
 * Claude and Codex emit whole messages that need a paragraph break.
 */
export function buildBlocks(events: StreamEvent[], harness: string): Block[] {
  const joiner = harness === "gemini-acp" ? "" : "\n\n";
  const root: Block[] = [];
  const subagents = new Map<string, SubagentBlock>();
  const calls = new Map<string, ToolItem>();
  const hidden = new Set<string>();

  for (const e of events) {
    const d = e.data as Record<string, any> | string | null;
    const obj = d && typeof d === "object" ? d : null;
    const parent = typeof obj?.parent === "string" ? obj.parent : undefined;
    const blocks = (parent && subagents.get(parent)?.blocks) || root;
    const last = blocks.at(-1);
    const id = obj ? idOf(obj) : undefined;

    // Gemini narrates its progress through an internal "Update topic" tool.
    // That is bookkeeping, not something the user asked for.
    if (e.kind === "tool_call" && typeof obj?.title === "string" && /^Update topic/i.test(obj.title)) {
      if (id) hidden.add(id);
      continue;
    }
    if (e.kind === "tool_result" && id && hidden.has(id)) continue;

    if (e.kind === "text") {
      const text = typeof d === "string" ? d : typeof obj?.text === "string" ? obj.text : null;
      if (text === null) continue;
      if (last?.t === "text") last.text += joiner + text;
      else blocks.push({ t: "text", text });
    } else if (e.kind === "raw" && typeof obj?.thought === "string") {
      if (last?.t === "thought") last.text += obj.thought;
      else blocks.push({ t: "thought", text: obj.thought });
    } else if (e.kind === "tool_call") {
      if (obj && SPAWN.has(obj.name) && id) {
        const input = (obj.input ?? {}) as Record<string, unknown>;
        const sub: SubagentBlock = {
          t: "subagent",
          id,
          kind: typeof input.subagent_type === "string" ? input.subagent_type : "general-purpose",
          description: typeof input.description === "string" ? input.description : "",
          blocks: [],
          done: false,
        };
        subagents.set(id, sub);
        blocks.push(sub);
        continue;
      }
      const known = id ? calls.get(id) : undefined;
      if (known) {
        known.call = describeEvent(e);
        continue;
      }
      const item: ToolItem = { call: describeEvent(e) };
      if (id) calls.set(id, item);
      if (last?.t === "tools") last.items.push(item);
      else blocks.push({ t: "tools", items: [item] });
    } else if (e.kind === "tool_result") {
      const sub = id ? subagents.get(id) : undefined;
      if (sub) {
        sub.done = true;
        // Gemini's own invoke_agent result is empty; don't let it wipe the report.
        const report = subagentReport(obj?.content);
        if (report) sub.report = report;
        continue;
      }
      const result = describeEvent(e).slice(0, 140);
      const item = id ? calls.get(id) : [...blocks].reverse().flatMap((b) => (b.t === "tools" ? [...b.items].reverse() : [])).find((i) => !i.result);
      if (item) item.result = result;
      else if (id) {
        // A result with no call before it (Codex reports a file change only once it's done).
        const row: ToolItem = { call: result };
        calls.set(id, row);
        if (last?.t === "tools") last.items.push(row);
        else blocks.push({ t: "tools", items: [row] });
      }
    } else if (e.kind === "error") {
      blocks.push({ t: "error", text: describeEvent(e) });
    }
  }
  return root;
}
