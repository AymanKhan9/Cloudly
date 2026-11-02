import { prisma } from "@repo/db";
import { isAcpHarness } from "@repo/shared/providers";

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
  const turns = (where: object) =>
    prisma.run.findMany({
      // Rewound turns were undone; rewinds and forks are Cloudly's own bookkeeping.
      where: { ...where, id: { not: currentRunId }, rewoundAt: null, kind: { notIn: ["rewind", "fork"] }, status: { in: ["succeeded", "failed", "cancelled"] } },
      orderBy: { createdAt: "asc" },
      select: { prompt: true, kind: true, output: true, harness: true, events: { where: { kind: "text" }, orderBy: { seq: "asc" }, select: { data: true } } },
    });

  // A fork starts with the conversation of the session it came from, up to the
  // turn it was forked after (and that one's, if it was a fork too).
  const runs: Awaited<ReturnType<typeof turns>> = [];
  const chain: { threadId: string; until?: Date }[] = [];
  let current = await prisma.thread.findUnique({ where: { id: threadId }, select: { forkOfThreadId: true, forkAtRunId: true } });
  chain.push({ threadId });
  for (let depth = 0; current?.forkOfThreadId && depth < 5; depth++) {
    const at = current.forkAtRunId ? await prisma.run.findUnique({ where: { id: current.forkAtRunId }, select: { createdAt: true } }) : null;
    chain.unshift({ threadId: current.forkOfThreadId, until: at?.createdAt });
    current = await prisma.thread.findUnique({ where: { id: current.forkOfThreadId }, select: { forkOfThreadId: true, forkAtRunId: true } });
  }
  for (const link of chain) {
    runs.push(...(await turns({ threadId: link.threadId, ...(link.until ? { createdAt: { lte: link.until } } : {}) })));
  }

  // A review or audit turn's reply is its findings, not the reviewer's working notes.
  const prior = runs.map((r) => ({
    prompt: r.prompt,
    reply: (r.kind === "review" || r.kind === "audit") && r.output ? r.output : replyText(r.events, r.harness ?? harness),
  }));
  return formatTranscript(prior, prompt);
}

/** A turn's written reply, from its text events. */
export function replyText(events: { data: unknown }[], harness: string): string {
  // ACP agents (Gemini and the added ones) stream a reply in fragments that join with nothing between them.
  const joiner = isAcpHarness(harness) ? "" : "\n\n";
  return events.map((e) => (typeof e.data === "string" ? e.data : "")).join(joiner).trim();
}
