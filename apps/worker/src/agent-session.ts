import type { RunEvent } from "@repo/shared/run-event";

/**
 * The id each harness needs to resume a conversation, read from the events it
 * already emits: Claude puts it on the result, Codex on thread.started, and
 * the ACP adapter emits an explicit session event.
 */
export function agentSessionIdFromEvent(
  harness: string,
  event: Pick<RunEvent, "kind" | "data">,
): string | null {
  const data = event.data as Record<string, any> | null;
  if (!data || typeof data !== "object") return null;

  switch (harness) {
    case "native-claude":
      return event.kind === "done" && typeof data.sessionId === "string" ? data.sessionId : null;
    case "native-codex":
      return event.kind === "status" && data.type === "thread.started" && typeof data.thread_id === "string"
        ? data.thread_id
        : null;
    case "gemini-acp":
      return event.kind === "status" && data.type === "acp.session" && typeof data.sessionId === "string"
        ? data.sessionId
        : null;
    default:
      return null;
  }
}
