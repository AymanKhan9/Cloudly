import { test, expect } from "bun:test";
import { prisma, currentMonth } from "@repo/db";
import { enforceBudget } from "../src/budget";

test("warns once at 80%, then stops at 100%: queued runs cancelled, a running turn left to finish", async () => {
  const user = await prisma.user.create({
    data: { githubId: Math.floor(Math.random() * 1e9), login: `budget-test-${Date.now()}` },
  });
  try {
    await prisma.budget.create({ data: { userId: user.id, monthlyLimitUsd: 10 } });
    const base = { repo: "test/repo", baseBranch: "main", prompt: "t", harness: "native-claude", userId: user.id };

    await prisma.run.create({ data: { ...base, status: "succeeded", costUsd: 8.5 } });
    expect((await enforceBudget(user.id)).state).toBe("change");
    expect((await prisma.budget.findUniqueOrThrow({ where: { userId: user.id } })).warnedMonth).toBe(currentMonth());

    const queued = await prisma.run.create({ data: { ...base, status: "queued" } });
    expect((await enforceBudget(user.id)).state).toBe("change");
    expect((await prisma.run.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe("queued");

    const running = await prisma.run.create({ data: { ...base, status: "running" } });
    await prisma.run.create({ data: { ...base, status: "succeeded", costUsd: 2 } });
    expect((await enforceBudget(user.id)).state).toBe("storm");
    const after = await prisma.run.findUniqueOrThrow({ where: { id: queued.id } });
    expect(after.status).toBe("cancelled");
    const stillRunning = await prisma.run.findUniqueOrThrow({ where: { id: running.id } });
    expect(stillRunning.cancelRequested).toBe(false);
    expect(stillRunning.status).toBe("running");
    expect((await prisma.budget.findUniqueOrThrow({ where: { userId: user.id } })).stoppedMonth).toBe(currentMonth());
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
