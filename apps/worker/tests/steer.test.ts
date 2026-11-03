import { test, expect } from "bun:test";
import { prisma } from "@repo/db";
import { takeSteers, steerDelivered, requeueSteers } from "../src/steer";

test("messages mid-turn: passed on once, marked when the agent takes them, the rest become the next turn", async () => {
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `steer-${Date.now()}` } });
  const thread = await prisma.thread.create({ data: { userId: user.id, repo: "acme/s", baseBranch: "main", harness: "native-claude", title: "t", branch: "b" } });
  const run = await prisma.run.create({ data: { userId: user.id, threadId: thread.id, repo: "acme/s", baseBranch: "main", harness: "native-claude", prompt: "go", status: "running" } });
  try {
    const a = await prisma.runSteer.create({ data: { runId: run.id, text: "use tabs" } });
    const b = await prisma.runSteer.create({ data: { runId: run.id, text: "and skip the docs", createdAt: new Date(Date.now() + 10) } });
    expect((await takeSteers(run.id)).map((m) => m.text)).toEqual(["use tabs", "and skip the docs"]);
    expect(await takeSteers(run.id)).toEqual([]);
    await steerDelivered({ kind: "status", data: { type: "steer", id: a.id, text: "use tabs" } });
    await steerDelivered({ kind: "status", data: { type: "steer.late", id: b.id } });
    const c = await prisma.runSteer.create({ data: { runId: run.id, text: "one more thing", createdAt: new Date(Date.now() + 20) } });
    const next = await requeueSteers({ ...run, harness: "native-claude" });
    expect(next).not.toBeNull();
    const queued = await prisma.run.findUniqueOrThrow({ where: { id: next! } });
    expect(queued).toMatchObject({ status: "queued", threadId: thread.id, prompt: "and skip the docs\n\none more thing" });
    const states = await prisma.runSteer.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
    expect(states.map((s) => s.status)).toEqual(["delivered", "requeued", "requeued"]);
    expect(c.id).toBeTruthy();
    expect(await requeueSteers({ ...run, harness: "native-claude" })).toBeNull();
  } finally {
    await prisma.thread.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});
