import { test, expect } from "bun:test";

import { prisma } from "@repo/db";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { createFixtureRepo } from "./test-helpers";

test("happy path: events inserted, run succeeds with a commit", async () => {
  const fixture = await createFixtureRepo();
  try {
    const inserted = await prisma.run.create({
      data: {
        status: "queued",
        repo: fixture.repoPath,
        baseBranch: "main",
        prompt: "add a file",
        harness: "native-claude",
      },
    });
    const claimed = await claimRun("worker-1");

    async function* stubContainer(ws: { runDir: string }) {
      await Bun.write(`${ws.runDir}/new-file.txt`, "hello from stub\n");
      yield { seq: 0, ts: Date.now(), kind: "status" as const, data: { type: "system" } };
      yield { seq: 1, ts: Date.now(), kind: "text" as const, data: "done!" };
      yield { seq: 2, ts: Date.now(), kind: "done" as const, data: { result: "done!" } };
    }

    await processRun(claimed!, "worker-1", stubContainer);

    const final = await prisma.run.findUniqueOrThrow({ where: { id: inserted.id } });
    expect(final.status).toBe("succeeded");
    expect(final.commitSha).toBeTruthy();

    const events = await prisma.runEvent.findMany({
      where: { runId: inserted.id },
      orderBy: { seq: "asc" },
    });
    expect(events.map((e) => e.kind)).toEqual(["status", "text", "done"]);

    await prisma.run.delete({ where: { id: inserted.id } });
  } finally {
    await fixture.cleanup();
  }
}, 30000);

test("fencing: a worker that lost the lease mid-run must not finalize", async () => {
  const fixture = await createFixtureRepo();
  try {
    const inserted = await prisma.run.create({
      data: {
        status: "queued",
        repo: fixture.repoPath,
        baseBranch: "main",
        prompt: "add a file",
        harness: "native-claude",
      },
    });
    const claimed = await claimRun("worker-A");

    async function* stubContainer() {
      yield { seq: 0, ts: Date.now(), kind: "status" as const, data: { type: "system" } };

      // Simulate a recovery sweep reclaiming this run to another worker
      // while this container run is still in progress.
      await prisma.run.update({
        where: { id: claimed!.id },
        data: { workerId: "worker-B", leaseGen: { increment: 1 } },
      });

      yield { seq: 1, ts: Date.now(), kind: "done" as const, data: { result: "done!" } };
    }

    await processRun(claimed!, "worker-A", stubContainer);

    const final = await prisma.run.findUniqueOrThrow({ where: { id: inserted.id } });
    expect(final.status).toBe("running");
    expect(final.workerId).toBe("worker-B");
    expect(final.commitSha).toBeNull();

    const events = await prisma.runEvent.findMany({ where: { runId: inserted.id } });
    expect(events.length).toBe(2); // events still insert; only finalize is fenced

    await prisma.run.delete({ where: { id: inserted.id } });
  } finally {
    await fixture.cleanup();
  }
}, 30000);

test("cancellation: partial work is still committed, status is cancelled not failed", async () => {
  const fixture = await createFixtureRepo();
  try {
    const inserted = await prisma.run.create({
      data: {
        status: "queued",
        repo: fixture.repoPath,
        baseBranch: "main",
        prompt: "a task",
        harness: "native-claude",
      },
    });
    const claimed = await claimRun("worker-1");

    // Simulates the real observed behavior: both adapters throw on SIGINT
    // abort (confirmed live — "The operation was aborted."), indistinguishable
    // from a genuine crash by error text or exit code alone. processRun must
    // rely on its own knowledge that *it* requested the cancellation.
    async function* stubContainer(ws: { runDir: string }) {
      yield { seq: 0, ts: Date.now(), kind: "status" as const, data: { type: "system" } };
      await Bun.write(`${ws.runDir}/partial-work.txt`, "got this far before cancel\n");

      await prisma.run.update({ where: { id: claimed!.id }, data: { cancelRequested: true } });
      await new Promise((r) => setTimeout(r, 150));

      throw new Error("The operation was aborted.");
    }

    await processRun(claimed!, "worker-1", stubContainer, 50);

    const final = await prisma.run.findUniqueOrThrow({ where: { id: inserted.id } });
    expect(final.status).toBe("cancelled");
    expect(final.commitSha).toBeTruthy();
    expect(final.error).toBeNull();

    await prisma.run.delete({ where: { id: inserted.id } });
  } finally {
    await fixture.cleanup();
  }
}, 30000);

test("a turn that changes nothing succeeds without a commit", async () => {
  const fixture = await createFixtureRepo();
  try {
    const inserted = await prisma.run.create({
      data: { status: "queued", repo: fixture.repoPath, baseBranch: "main", prompt: "just explain", harness: "native-claude" },
    });
    const claimed = await claimRun("worker-quiet");

    async function* talkOnly() {
      yield { seq: 0, ts: Date.now(), kind: "text" as const, data: "Nothing to change." };
      yield { seq: 1, ts: Date.now(), kind: "done" as const, data: { result: "ok" } };
    }

    await processRun(claimed!, "worker-quiet", talkOnly);

    const final = await prisma.run.findUniqueOrThrow({ where: { id: inserted.id } });
    expect(final.status).toBe("succeeded");
    expect(final.commitSha).toBeNull();
    await prisma.run.delete({ where: { id: inserted.id } });
  } finally {
    await fixture.cleanup();
  }
}, 30000);

test("a run's cap is what's left of the month plus the overshoot allowance, and none starts once it's spent", async () => {
  const fixture = await createFixtureRepo();
  const user = await prisma.user.create({
    data: { githubId: Math.floor(Math.random() * 1e9), login: `cap-test-${Date.now()}` },
  });
  try {
    await prisma.budget.create({ data: { userId: user.id, monthlyLimitUsd: 1 } });
    const base = { repo: fixture.repoPath, baseBranch: "main", prompt: "t", harness: "native-claude", userId: user.id };
    await prisma.run.create({ data: { ...base, status: "succeeded", costUsd: 0.3 } });

    let seenCap: number | undefined;
    async function* stubContainer(_ws: unknown, _t: string, _h: string, _id: string, options?: { maxBudgetUsd?: number }) {
      seenCap = options?.maxBudgetUsd;
      yield { seq: 0, ts: Date.now(), kind: "done" as const, data: { totalCostUsd: 0.7 } };
    }

    await prisma.run.create({ data: { ...base, status: "queued" } });
    await processRun((await claimRun("worker-1"))!, "worker-1", stubContainer as any);
    expect(seenCap).toBeCloseTo(0.7 + 0.25);

    // $1.00 of $1 spent: the next run fails before any container starts.
    seenCap = undefined;
    const blocked = await prisma.run.create({ data: { ...base, status: "queued" } });
    await expect(processRun((await claimRun("worker-1"))!, "worker-1", stubContainer as any)).rejects.toThrow("spend limit");
    expect(seenCap).toBeUndefined();
    const final = await prisma.run.findUniqueOrThrow({ where: { id: blocked.id } });
    expect(final.status).toBe("failed");
    expect(final.error).toContain("spend limit");
  } finally {
    await prisma.run.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
  }
}, 30000);

test("a turn stopped at the spend ceiling keeps the work it finished", async () => {
  const fixture = await createFixtureRepo();
  try {
    const inserted = await prisma.run.create({
      data: { status: "queued", repo: fixture.repoPath, baseBranch: "main", prompt: "big task", harness: "native-claude" },
    });

    // What the runner does at the ceiling: the error result, then a non-zero exit.
    async function* stubContainer(ws: { runDir: string }) {
      await Bun.write(`${ws.runDir}/half-done.txt`, "finished part\n");
      yield { seq: 0, ts: Date.now(), kind: "error" as const, data: { subtype: "error_max_budget_usd", totalCostUsd: 1.25 } };
      throw new Error("Run container exited with code 1");
    }

    await processRun((await claimRun("worker-1"))!, "worker-1", stubContainer);

    const final = await prisma.run.findUniqueOrThrow({ where: { id: inserted.id } });
    expect(final.status).toBe("cancelled");
    expect(final.commitSha).toBeTruthy();
    expect(final.error).toContain("spend-limit ceiling");
    expect(final.costUsd?.toNumber()).toBeCloseTo(1.25);

    await prisma.run.delete({ where: { id: inserted.id } });
  } finally {
    await fixture.cleanup();
  }
}, 30000);
