import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma } from "@repo/db";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { createFixtureRepo } from "./test-helpers";

type Seen = { task: string; resume?: string; fallbackTask?: string };
type Report = { sessionId: string; resumed: boolean; sessionUsd?: number; turnUsd?: number };

/** A session on an added agent, whose stand-in reports what each turn says to. */
async function session(harness: string) {
  process.env.CLOUDLY_DATA_DIR = await mkdtemp(path.join(tmpdir(), "added-agent-"));
  const fixture = await createFixtureRepo();
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `added-${Date.now()}` } });
  const thread = await prisma.thread.create({ data: { userId: user.id, repo: fixture.repoPath, baseBranch: "main", harness, title: "t", branch: `agent/${harness}-${Date.now()}` } });
  const seen: Seen[] = [];
  const turn = async (prompt: string, report: (s: Seen) => Report) => {
    async function* stub(_ws: unknown, task: string, _h: string, _id: string, o?: { resume?: string; fallbackTask?: string }) {
      const s = { task, resume: o?.resume, fallbackTask: o?.fallbackTask };
      seen.push(s);
      const r = report(s);
      yield { seq: 0, ts: Date.now(), kind: "status" as const, data: { type: "acp.session", sessionId: r.sessionId, resumed: r.resumed } };
      yield { seq: 1, ts: Date.now(), kind: "text" as const, data: `reply to ${prompt}` };
      if (r.sessionUsd !== undefined) yield { seq: 2, ts: Date.now(), kind: "status" as const, data: { type: "acp.cost", sessionUsd: r.sessionUsd } };
      if (r.turnUsd !== undefined) yield { seq: 3, ts: Date.now(), kind: "status" as const, data: { type: "acp.cost", turnUsd: r.turnUsd } };
      yield { seq: 4, ts: Date.now(), kind: "done" as const, data: { stopReason: "end_turn" } };
    }
    const run = await prisma.run.create({ data: { status: "queued", repo: fixture.repoPath, baseBranch: "main", prompt, harness, userId: user.id, threadId: thread.id } });
    await processRun((await claimRun("worker-added"))!, "worker-added", stub as never);
    return prisma.run.findUniqueOrThrow({ where: { id: run.id } });
  };
  const cleanup = async () => {
    delete process.env.CLOUDLY_DATA_DIR;
    await prisma.run.deleteMany({ where: { threadId: thread.id } });
    await prisma.thread.delete({ where: { id: thread.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
  };
  return { thread, seen, turn, cleanup };
}

test("OpenCode resumes its own session, and each turn costs the change in its session total", async () => {
  const s = await session("acp-opencode");
  try {
    const first = await s.turn("first", () => ({ sessionId: "oc-1", resumed: false, sessionUsd: 0.4 }));
    expect(s.seen[0]!.resume).toBeUndefined();
    expect(first.costUsd?.toNumber()).toBeCloseTo(0.4);
    expect(await prisma.thread.findUniqueOrThrow({ where: { id: s.thread.id } })).toMatchObject({ agentSessionId: "oc-1", agentSessionCost: 0.4 });

    // Resumed: only the new message, with the history kept as a fallback; cost is 1.0 - 0.4.
    const second = await s.turn("second", (seen) => ({ sessionId: "oc-1", resumed: seen.resume === "oc-1", sessionUsd: 1.0 }));
    expect(s.seen[1]!.resume).toBe("oc-1");
    expect(s.seen[1]!.task).not.toContain("Earlier in this conversation");
    expect(s.seen[1]!.task).toContain("second");
    expect(s.seen[1]!.fallbackTask).toContain("Earlier in this conversation");
    expect(s.seen[1]!.fallbackTask).toContain("reply to first");
    expect(second.costUsd?.toNumber()).toBeCloseTo(0.6);

    // The session couldn't be loaded: a new one, whose whole total is this turn's.
    const third = await s.turn("third", () => ({ sessionId: "oc-2", resumed: false, sessionUsd: 0.3 }));
    expect(third.costUsd?.toNumber()).toBeCloseTo(0.3);
    expect((await prisma.thread.findUniqueOrThrow({ where: { id: s.thread.id } })).agentSessionId).toBe("oc-2");
  } finally {
    await s.cleanup();
  }
}, 120000);

test("Pi's turn cost comes from its session file, and a turn that reports nothing records nothing", async () => {
  const s = await session("acp-pi");
  try {
    const first = await s.turn("first", () => ({ sessionId: "pi-1", resumed: false, turnUsd: 0.12 }));
    expect(first.costUsd?.toNumber()).toBeCloseTo(0.12);
    const second = await s.turn("second", () => ({ sessionId: "pi-1", resumed: true }));
    expect(s.seen[1]!.resume).toBe("pi-1");
    expect(second.costUsd?.toNumber()).toBe(0);
  } finally {
    await s.cleanup();
  }
}, 120000);

test("an added agent without native resume still gets the conversation in its prompt", async () => {
  const s = await session("acp-cursor");
  try {
    await s.turn("first", () => ({ sessionId: "c-1", resumed: false }));
    await s.turn("second", () => ({ sessionId: "c-2", resumed: false }));
    expect(s.seen[1]!.resume).toBeUndefined();
    expect(s.seen[1]!.fallbackTask).toBeUndefined();
    expect(s.seen[1]!.task).toContain("Earlier in this conversation");
  } finally {
    await s.cleanup();
  }
}, 120000);
