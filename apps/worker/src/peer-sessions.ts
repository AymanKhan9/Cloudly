import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma, Prisma, authorName } from "@repo/db";
import {
  SESSION_LIMITS, messagePrompt, replyPrompt,
  type OutboxMessage, type PeerScope, type PeerSession, type SessionsIndex,
} from "@repo/shared/sessions";
import type { Run } from "@repo/shared/run";
import { readRegular } from "./repo-files";
import { replyText } from "./transcript";

// The user's other sessions in a run (see @repo/shared/sessions). Before the
// turn, the ones this session may see go in at /sessions; after it, messages
// the agent sent come back from /sessions/outbox.jsonl, read the way the patch
// is (the agent could have left anything there), and become turns in those
// sessions. Every check is made again here: the index the agent saw is a hint,
// not an authority.

export interface SessionsDir {
  dir: string;
  index: SessionsIndex;
}

interface ThreadLike {
  id: string;
  title: string;
  repo: string;
  harness: string;
  peers: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [shortened]` : s);

/** The sessions a session's agent may see, newest first. */
async function visibleThreads(thread: ThreadLike, userId: string) {
  const scope = thread.peers as PeerScope;
  if (scope !== "repo" && scope !== "all") return [];
  return prisma.thread.findMany({
    // Archived sessions are out of reach until the user unarchives them.
    where: { userId, id: { not: thread.id }, archivedAt: null, ...(scope === "repo" ? { repo: thread.repo } : {}) },
    orderBy: { updatedAt: "desc" },
    take: SESSION_LIMITS.listed,
  });
}

/** A session's conversation as the agent reads it. */
function conversation(t: { title: string; repo: string; branch: string; harness: string; prUrl: string | null }, turns: { prompt: string; status: string; createdAt: Date; error: string | null; events: { data: unknown }[] }[]): string {
  const shown = turns.slice(-SESSION_LIMITS.turns);
  return [
    `# ${t.title}`,
    "",
    `Agent: ${authorName(t.harness)} · Repo: ${t.repo} · Branch: ${t.branch}${t.prUrl ? ` · Pull request: ${t.prUrl}` : ""}`,
    turns.length > shown.length ? `\n(${turns.length - shown.length} earlier turns not shown.)` : "",
    ...shown.flatMap((r, i) => {
      const reply = replyText(r.events, t.harness);
      return [
        "",
        `## Turn ${turns.length - shown.length + i + 1} · ${r.status} · ${r.createdAt.toISOString()}`,
        "",
        `User: ${clip(r.prompt, SESSION_LIMITS.promptChars)}`,
        "",
        `Agent: ${reply ? clip(reply, SESSION_LIMITS.replyChars) : r.status === "failed" && r.error ? `(failed: ${clip(r.error, 500)})` : r.status === "queued" || r.status === "running" ? "(not finished yet)" : "(no written reply)"}`,
      ];
    }),
  ].join("\n");
}

/** Null when the session doesn't let its agent see other sessions. */
export async function prepareSessions(run: Pick<Run, "hops" | "userId">, thread: ThreadLike): Promise<SessionsDir | null> {
  if (!run.userId || (thread.peers !== "repo" && thread.peers !== "all")) return null;
  const threads = await visibleThreads(thread, run.userId);
  const dir = await mkdtemp(path.join(tmpdir(), "run-sessions-"));
  const sessions: PeerSession[] = [];
  for (const t of threads) {
    const turns = await prisma.run.findMany({
      where: { threadId: t.id },
      orderBy: { createdAt: "asc" },
      select: { prompt: true, status: true, createdAt: true, error: true, events: { where: { kind: "text" }, orderBy: { seq: "asc" }, select: { data: true } } },
    });
    sessions.push({
      id: t.id,
      title: t.title,
      repo: t.repo,
      branch: t.branch,
      agent: authorName(t.harness),
      status: turns.at(-1)?.status ?? "queued",
      prUrl: t.prUrl,
      updatedAt: t.updatedAt.toISOString(),
      turns: turns.length,
    });
    await writeFile(path.join(dir, `${t.id}.md`), conversation(t, turns));
  }
  const index: SessionsIndex = {
    self: { id: thread.id, title: thread.title },
    scope: thread.peers as PeerScope,
    canSend: (run.hops ?? 0) < SESSION_LIMITS.hops ? SESSION_LIMITS.sendsPerTurn : 0,
    sessions,
  };
  await writeFile(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
  await writeFile(path.join(dir, "outbox.jsonl"), "");
  return { dir, index };
}

/** What the agent sent this turn: well-formed, to a session it was shown, one each, within the limits. */
export async function collectOutbox(s: SessionsDir): Promise<OutboxMessage[]> {
  const bytes = await readRegular(path.join(s.dir, "outbox.jsonl"), 64 * 1024);
  if (!bytes) return [];
  const shown = new Set(s.index.sessions.map((x) => x.id));
  const out: OutboxMessage[] = [];
  for (const line of new TextDecoder().decode(bytes).split("\n")) {
    if (!line.trim() || out.length >= Math.min(s.index.canSend, SESSION_LIMITS.sendsPerTurn)) continue;
    try {
      const m = JSON.parse(line);
      if (typeof m?.to !== "string" || !shown.has(m.to) || out.some((o) => o.to === m.to)) continue;
      if (typeof m.message !== "string" || !m.message.trim()) continue;
      out.push({ to: m.to, message: m.message.slice(0, SESSION_LIMITS.messageChars), replyWanted: m.replyWanted === true });
    } catch {}
  }
  return out;
}

const isDuplicate = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Queues each message as a turn in its session, checking again that the session
 * is the same user's and in the sender's scope. A retried turn sends nothing
 * twice: (fromRunId, threadId) is unique.
 */
export async function deliverMessages(
  run: Pick<Run, "id" | "userId" | "hops">,
  from: ThreadLike,
  messages: OutboxMessage[],
): Promise<{ id: string; title: string; replyWanted: boolean }[]> {
  if (!run.userId || !messages.length) return [];
  const allowed = new Map((await visibleThreads(from, run.userId)).map((t) => [t.id, t]));
  const delivered: { id: string; title: string; replyWanted: boolean }[] = [];
  for (const m of messages) {
    const target = allowed.get(m.to);
    if (!target) continue;
    try {
      await prisma.run.create({
        data: {
          repo: target.repo, baseBranch: target.baseBranch, harness: target.harness, status: "queued", userId: run.userId,
          threadId: target.id,
          prompt: messagePrompt({ title: from.title, agent: authorName(from.harness) }, m.message, m.replyWanted),
          fromThreadId: from.id, fromRunId: run.id, hops: (run.hops ?? 0) + 1,
          replyToThreadId: m.replyWanted ? from.id : null,
        },
      });
      // New work there: back in the sidebar's main list.
      await prisma.thread.update({ where: { id: target.id }, data: { updatedAt: new Date(), settledAt: null, snoozedUntil: null } });
    } catch (err) {
      if (!isDuplicate(err)) throw err;
    }
    delivered.push({ id: target.id, title: target.title, replyWanted: m.replyWanted });
  }
  return delivered;
}

/**
 * A turn that answered a message with a reply asked for: its answer goes back to
 * the session that asked, as a turn there. Once, whatever happens to the turn.
 */
export async function sendReply(runId: string): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true, status: true, error: true, userId: true, hops: true, replyToThreadId: true, harness: true, threadId: true,
      thread: { select: { title: true } },
      events: { where: { kind: "text" }, orderBy: { seq: "asc" }, select: { data: true } },
    },
  });
  if (!run?.replyToThreadId || !run.thread || !["succeeded", "failed", "cancelled"].includes(run.status)) return;
  const asker = await prisma.thread.findFirst({ where: { id: run.replyToThreadId, userId: run.userId ?? undefined } });
  if (!asker) return;
  const reply = replyText(run.events, run.harness) || (run.status === "succeeded" ? "" : `(The turn ${run.status}${run.error ? `: ${run.error.slice(0, 500)}` : ""}.)`);
  try {
    await prisma.run.create({
      data: {
        repo: asker.repo, baseBranch: asker.baseBranch, harness: asker.harness, status: "queued", userId: run.userId,
        threadId: asker.id,
        prompt: replyPrompt({ title: run.thread.title, agent: authorName(run.harness) }, reply),
        fromThreadId: run.threadId, fromRunId: run.id, hops: run.hops + 1,
      },
    });
    // The answer the user's session was waiting for: bring it back wherever it was put away.
    await prisma.thread.update({ where: { id: asker.id }, data: { updatedAt: new Date(), settledAt: null, snoozedUntil: null, archivedAt: null } });
  } catch (err) {
    if (!isDuplicate(err)) throw err;
  }
}

export async function destroySessions(s: SessionsDir): Promise<void> {
  await rm(s.dir, { recursive: true, force: true });
}
