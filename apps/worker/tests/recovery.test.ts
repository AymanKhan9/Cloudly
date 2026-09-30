import { test, expect } from "bun:test";

import { prisma } from "@repo/db";
import { reclaimExpiredRun, failExhaustedRuns, runRecoverySweepLoop } from "../src/recovery";

test("reclaimExpiredRun only picks up expired, under-limit running/finalizing rows", async () => {
  const expired = await prisma.run.create({
    data: {
      status: "running", repo: "test/repo", baseBranch: "main", prompt: "t1", harness: "native-claude",
      workerId: "dead-worker", leaseUntil: new Date(Date.now() - 60_000), leaseGen: 1, attempts: 0,
    },
  });
  const fresh = await prisma.run.create({
    data: {
      status: "running", repo: "test/repo", baseBranch: "main", prompt: "t2", harness: "native-claude",
      workerId: "alive-worker", leaseUntil: new Date(Date.now() + 60_000), leaseGen: 1, attempts: 0,
    },
  });
  const queued = await prisma.run.create({
    data: { status: "queued", repo: "test/repo", baseBranch: "main", prompt: "t3", harness: "native-claude" },
  });
  const exhausted = await prisma.run.create({
    data: {
      status: "running", repo: "test/repo", baseBranch: "main", prompt: "t4", harness: "native-claude",
      workerId: "dead-worker", leaseUntil: new Date(Date.now() - 60_000), leaseGen: 1, attempts: 3,
    },
  });

  try {
    const reclaimed = await reclaimExpiredRun("recovery-worker");
    expect(reclaimed?.id).toBe(expired.id);
    expect(reclaimed?.leaseGen).toBe(2);
    expect(reclaimed?.attempts).toBe(1);
    expect(reclaimed?.workerId).toBe("recovery-worker");

    const nothingElse = await reclaimExpiredRun("recovery-worker-2");
    expect(nothingElse).toBeNull();

    const failedCount = await failExhaustedRuns();
    expect(failedCount).toBe(1);

    const exhaustedFinal = await prisma.run.findUniqueOrThrow({ where: { id: exhausted.id } });
    expect(exhaustedFinal.status).toBe("failed");

    const freshFinal = await prisma.run.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(freshFinal.status).toBe("running");
    expect(freshFinal.workerId).toBe("alive-worker");
  } finally {
    await prisma.run.deleteMany({ where: { id: { in: [expired.id, fresh.id, queued.id, exhausted.id] } } });
  }
});

test("recovery sweep clears stale events and redoes the run with bumped fencing tokens", async () => {
  const crashed = await prisma.run.create({
    data: {
      status: "running", repo: "test/repo", baseBranch: "main", prompt: "task", harness: "native-claude",
      workerId: "dead-worker", leaseUntil: new Date(Date.now() - 60_000), leaseGen: 1, attempts: 0,
    },
  });

  await prisma.runEvent.createMany({
    data: [
      { runId: crashed.id, seq: 0, kind: "status", data: { note: "stale, from dead attempt" } },
      { runId: crashed.id, seq: 1, kind: "text", data: "partial output before crash" },
    ],
  });

  try {
    let processedRun: { id: string; attempts: number; leaseGen: number } | null = null;
    const stubProcessRun = async (run: typeof processedRun) => {
      processedRun = run;
    };

    const controller = new AbortController();
    const loopPromise = runRecoverySweepLoop(
      "recovery-worker",
      2,
      stubProcessRun as any,
      controller.signal,
      200,
    );

    await new Promise((r) => setTimeout(r, 1000));
    controller.abort();
    await loopPromise.catch(() => {});

    expect(processedRun).not.toBeNull();
    expect((processedRun as any)?.attempts).toBe(1);
    expect((processedRun as any)?.leaseGen).toBe(2);

    const remainingEvents = await prisma.runEvent.findMany({ where: { runId: crashed.id } });
    expect(remainingEvents.length).toBe(0);
  } finally {
    await prisma.run.delete({ where: { id: crashed.id } });
  }
}, 10000);
