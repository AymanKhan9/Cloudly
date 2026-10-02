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
