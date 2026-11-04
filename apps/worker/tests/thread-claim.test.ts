import { test, expect } from "bun:test";
import { prisma } from "@repo/db";
import { claimRun } from "../src/claim";

test("a thread's second turn waits until the first finishes", async () => {
  const user = await prisma.user.create({
    data: { githubId: Math.floor(Math.random() * 1e9), login: `thread-test-${Date.now()}` },
  });
  try {
    const thread = await prisma.thread.create({
      data: { userId: user.id, repo: "o/r", baseBranch: "main", harness: "native-claude", title: "t", branch: "agent/thread-x" },
    });
    const base = { repo: "o/r", baseBranch: "main", harness: "native-claude", userId: user.id, threadId: thread.id, status: "queued" as const };
    const first = await prisma.run.create({ data: { ...base, prompt: "one", createdAt: new Date(Date.now() - 2000) } });
    const second = await prisma.run.create({ data: { ...base, prompt: "two", createdAt: new Date(Date.now() - 1000) } });

    const a = await claimRun("w1");
    expect(a?.id).toBe(first.id);

    // Turn two is queued but must not be claimed while turn one runs.
    const blocked = await claimRun("w2");
    expect(blocked?.threadId === thread.id).toBe(false);

    await prisma.run.update({ where: { id: first.id }, data: { status: "succeeded" } });
    const b = await claimRun("w2");
    expect(b?.id).toBe(second.id);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("concurrent claims start at most one queued turn from a thread", async () => {
  const user = await prisma.user.create({
    data: { githubId: Math.floor(Math.random() * 1e9), login: `thread-race-${Date.now()}` },
  });
  try {
    const thread = await prisma.thread.create({
      data: { userId: user.id, repo: "o/r", baseBranch: "main", harness: "native-claude", title: "t", branch: "agent/thread-race" },
    });
    const base = { repo: "o/r", baseBranch: "main", harness: "native-claude", userId: user.id, threadId: thread.id, status: "queued" as const };
    const runs = await Promise.all([
      prisma.run.create({ data: { ...base, prompt: "one" } }),
      prisma.run.create({ data: { ...base, prompt: "two" } }),
    ]);

    const claims = await Promise.all([claimRun("race-1"), claimRun("race-2")]);
    const threadClaims = claims.filter((run) => run?.threadId === thread.id);

    expect(threadClaims).toHaveLength(1);
    const stored = await prisma.run.findMany({ where: { id: { in: runs.map((run) => run.id) } } });
    expect(stored.filter((run) => run.status === "running")).toHaveLength(1);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
