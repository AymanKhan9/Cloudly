import { prisma } from "@repo/db";

export interface PriorTurn {
  prompt: string;
  reply: string;
}

const MAX_TURNS = 8;
const MAX_REPLY_CHARS = 3000;
const MAX_PROMPT_CHARS = 2000;

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}… [shortened]` : s;
}

/**
 * Agents differ in whether their own session storage can carry a conversation
 * across containers, so a follow-up turn starts a clean session and gets the
 * earlier conversation written into its prompt. The code itself carries over
 * through the thread's git branch, not through this text.
 */
export function formatTranscript(prior: PriorTurn[], prompt: string): string {
  if (prior.length === 0) return prompt;
  const recent = prior.slice(-MAX_TURNS);
  const body = recent
    .map((t) => `User: ${clip(t.prompt, MAX_PROMPT_CHARS)}\nYou: ${t.reply ? clip(t.reply, MAX_REPLY_CHARS) : "(no written reply)"}`)
    .join("\n\n");
  return [
    "You are continuing a conversation about this repository. The files in the working directory already contain everything done in the earlier turns.",
    "",
    "Earlier in this conversation:",
    body,
    "",
    "The user's new message (answer this one):",
    prompt,
  ].join("\n");
}

export async function promptWithHistory(
  threadId: string,
  currentRunId: string,
  harness: string,
  prompt: string,
): Promise<string> {
  const runs = await prisma.run.findMany({
    where: { threadId, id: { not: currentRunId }, status: { in: ["succeeded", "failed", "cancelled"] } },
    orderBy: { createdAt: "asc" },
    select: { prompt: true, events: { where: { kind: "text" }, orderBy: { seq: "asc" }, select: { data: true } } },
  });

  // Gemini streams a reply in fragments that join with nothing between them.
  const joiner = harness === "gemini-acp" ? "" : "\n\n";
  const prior = runs.map((r) => ({
    prompt: r.prompt,
    reply: r.events.map((e) => (typeof e.data === "string" ? e.data : "")).join(joiner).trim(),
  }));
  return formatTranscript(prior, prompt);
}
