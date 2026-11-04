import { z } from "zod";

export const RunEventKindSchema = z.enum([
    "status",
    "text",
    "tool_call",
    "tool_result",
    "raw",
    "error",
    "done",
])

export const RunEventSchema = z.object({
    seq: z.number(),
    ts: z.number(),
    kind: RunEventKindSchema,
    data: z.unknown(),
})

export type RunEvent = z.infer<typeof RunEventSchema>

/**
 * Follows a turn's events and keeps the agent's latest reply. Claude and Codex
 * send each message whole; ACP agents (Gemini, OpenCode, Pi and the other added
 * ones) stream it in fragments, so their reply is the fragments since the last
 * tool call, tool result or thought. Status events (cost, context) can fall
 * between fragments and don't end a reply, as in the chat view.
 */
export function lastReply(acp: boolean) {
  let text = "";
  let inReply = false;
  return {
    push(e: { kind: string; data: unknown }) {
      if (e.kind === "text") {
        if (typeof e.data !== "string") return;
        if (acp) {
          text = inReply ? text + e.data : e.data;
          inReply = true;
        } else if (e.data.trim()) text = e.data;
      } else if (e.kind !== "status") inReply = false;
    },
    get text(): string | undefined {
      return text.trim() ? text : undefined;
    },
  };
}
