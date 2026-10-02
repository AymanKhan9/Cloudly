import type { Course } from "@/components/courses";

export interface StreamEvent {
  seq: number;
  kind: Course["kind"];
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
      if (d.name && d.input) return clip(`${d.name}  ${str(d.input.command ?? d.input.file_path ?? d.input.pattern ?? d.input)}`);
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

export function stampFrom(start: string, ts: string) {
  const s = Math.max(0, Math.round((new Date(ts).getTime() - new Date(start).getTime()) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export type Block =
  | { t: "text"; text: string }
  | { t: "thought"; text: string }
  | { t: "tools"; items: { call: string; result?: string }[] }
  | { t: "error"; text: string };

/**
 * Folds one turn's raw events into what a chat shows: replies as prose,
 * reasoning folded away, tool calls grouped with their results.
 * Gemini streams its reply in fragments that join with nothing between them;
 * Claude and Codex emit whole messages that need a paragraph break.
 */
export function buildBlocks(events: StreamEvent[], harness: string): Block[] {
  const joiner = harness === "gemini-acp" ? "" : "\n\n";
  const blocks: Block[] = [];

  const hidden = new Set<string>();
  for (const e of events) {
    const d = e.data as Record<string, any> | string | null;
    const last = blocks.at(-1);

    // Gemini narrates its progress through an internal "Update topic" tool.
    // That is bookkeeping, not something the user asked for.
    if ((e.kind === "tool_call" || e.kind === "tool_result") && d && typeof d === "object") {
      if (e.kind === "tool_call" && typeof d.title === "string" && /^Update topic/i.test(d.title)) {
        if (typeof d.id === "string") hidden.add(d.id);
        continue;
      }
      if (e.kind === "tool_result" && typeof d.id === "string" && hidden.has(d.id)) continue;
    }

    if (e.kind === "text" && typeof d === "string") {
      if (last?.t === "text") last.text += joiner + d;
      else blocks.push({ t: "text", text: d });
    } else if (e.kind === "raw" && d && typeof d === "object" && typeof d.thought === "string") {
      if (last?.t === "thought") last.text += d.thought;
      else blocks.push({ t: "thought", text: d.thought });
    } else if (e.kind === "tool_call") {
      const item = { call: describeEvent(e) };
      if (last?.t === "tools") last.items.push(item);
      else blocks.push({ t: "tools", items: [item] });
    } else if (e.kind === "tool_result") {
      const target = [...blocks].reverse().find((b) => b.t === "tools");
      const pending = target?.t === "tools" ? [...target.items].reverse().find((i) => !i.result) : undefined;
      if (pending) pending.result = describeEvent(e).slice(0, 140);
    } else if (e.kind === "error") {
      blocks.push({ t: "error", text: describeEvent(e) });
    }
  }
  return blocks;
}
