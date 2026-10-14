import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ContextUsage {
  model?: string;
  tokens: number;
  max: number;
  percentage: number;
}

/** Codex keeps each session at <codex home>/sessions/<date>/rollout-<time>-<id>.jsonl. */
export function findCodexRollout(codexHomes: string[], sessionId: string): string | null {
  for (const home of codexHomes) {
    const dir = path.join(home, "sessions");
    try {
      const hit = readdirSync(dir, { recursive: true }).find((f) => String(f).endsWith(`-${sessionId}.jsonl`));
      if (hit) return path.join(dir, String(hit));
    } catch {}
  }
  return null;
}

/**
 * How full Codex's context window is, from the latest token count in its own
 * session log: what the Codex CLI shows as "context left". Codex doesn't put
 * this in the event stream the SDK hands back.
 */
export function codexContext(rolloutPath: string): ContextUsage | null {
  let model: string | undefined;
  let usage: ContextUsage | null = null;
  for (const line of readFileSync(rolloutPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const p = entry.payload ?? {};
    if (entry.type === "turn_context" && typeof p.model === "string") model = p.model;
    const info = p.type === "token_count" ? p.info : null;
    const tokens = info?.last_token_usage?.total_tokens;
    const max = info?.model_context_window;
    if (typeof tokens === "number" && typeof max === "number" && max > 0) {
      usage = { tokens, max, percentage: Math.round((tokens / max) * 100) };
    }
  }
  return usage ? { ...usage, model } : null;
}

/** Every current Gemini model's window, from the Gemini CLI's own tokenLimit(). */
const GEMINI_CONTEXT_WINDOW = 1_048_576;

/** Gemini CLI keeps each chat at ~/.gemini/tmp/<project>/chats/session-<time>-<first 8 of id>.jsonl. */
export function findGeminiChat(home: string, sessionId: string): string | null {
  const dir = path.join(home, ".gemini", "tmp");
  const suffix = `-${sessionId.slice(0, 8)}.jsonl`;
  try {
    const hit = readdirSync(dir, { recursive: true }).find((f) => {
      const name = String(f);
      return name.includes(`${path.sep}chats${path.sep}`) && name.endsWith(suffix);
    });
    return hit ? path.join(dir, String(hit)) : null;
  } catch {
    return null;
  }
}

/**
 * Gemini's context fill: the prompt size of its latest reply, as the Gemini CLI
 * computes "context left". Its per-turn token count in the ACP response adds up
 * every request in the turn, so it overstates the context.
 */
export function geminiContext(chatPath: string): ContextUsage | null {
  let usage: ContextUsage | null = null;
  for (const line of readFileSync(chatPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const tokens = rec?.type === "gemini" ? rec.tokens?.input : undefined;
    if (typeof tokens === "number" && tokens > 0) {
      usage = {
        model: typeof rec.model === "string" ? rec.model : undefined,
        tokens,
        max: GEMINI_CONTEXT_WINDOW,
        percentage: Math.round((tokens / GEMINI_CONTEXT_WINDOW) * 100),
      };
    }
  }
  return usage;
}
