import { test, expect } from "bun:test";

import { prisma } from "@repo/db";
import { claimRun } from "../src/claim";

test("claims a queued run: sets status, workerId, bumps leaseGen", async () => {
  const inserted = await prisma.run.create({
    data: { status: "queued", repo: "test/repo", baseBranch: "main", prompt: "test task", harness: "native-claude" },
  });

  try {
    const claimed = await claimRun("worker-1");

    expect(claimed?.id).toBe(inserted.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.workerId).toBe("worker-1");
    expect(claimed?.leaseGen).toBe(1);
    expect(claimed?.leaseUntil).toBeInstanceOf(Date);
  } finally {
    await prisma.run.delete({ where: { id: inserted.id } });
  }
});

test("returns null when nothing is queued", async () => {
  const claimed = await claimRun("worker-1");
  expect(claimed).toBeNull();
});

test("never claims a run with cancelRequested set, even while still queued", async () => {
  const cancelled = await prisma.run.create({
    data: {
      status: "queued", repo: "test/repo", baseBranch: "main", prompt: "should never start",
      harness: "native-claude", cancelRequested: true,
    },
  });
  const normal = await prisma.run.create({
    data: { status: "queued", repo: "test/repo", baseBranch: "main", prompt: "should be claimed", harness: "native-claude" },
  });

  try {
    const first = await claimRun("worker-1");
    expect(first?.id).toBe(normal.id);

    const second = await claimRun("worker-1");
    expect(second).toBeNull(); // the cancelled run must never be claimed
  } finally {
    await prisma.run.deleteMany({ where: { id: { in: [cancelled.id, normal.id] } } });
  }
});

test("concurrent claims never double-claim the same run (SKIP LOCKED)", async () => {
  const N = 10;
  const runs = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      prisma.run.create({
        data: { status: "queued", repo: "test/repo", baseBranch: "main", prompt: `task ${i}`, harness: "native-claude" },
      }),
    ),
  );

  try {
    // Fire more concurrent claim attempts than there are runs to claim.
    const attempts = Array.from({ length: N * 2 }, (_, i) => claimRun(`worker-${i}`));
    const results = await Promise.all(attempts);

    const claimed = results.filter((r) => r !== null);
    const uniqueIds = new Set(claimed.map((r) => r!.id));

    expect(claimed.length).toBe(N);
    expect(uniqueIds.size).toBe(N);
  } finally {
    await prisma.run.deleteMany({ where: { id: { in: runs.map((r) => r.id) } } });
  }
});
