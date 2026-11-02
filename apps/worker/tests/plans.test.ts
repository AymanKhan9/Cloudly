import { test, expect, afterAll } from "bun:test";
import { symlink } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@repo/db";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { advancePlan, PLAN_DIR } from "../src/plans";
import { createFixtureRepo } from "./test-helpers";

const users: string[] = [];
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});
async function newUser() {
  const u = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `plan-${Date.now()}-${users.length}` } });
  users.push(u.id);
  return u;
}

type Opts = { mounts?: [string, string][] };
async function planTurn(write: (dir: string) => Promise<void>) {
  const fixture = await createFixtureRepo();
  const user = await newUser();
  const plan = await prisma.plan.create({ data: { userId: user.id, repo: fixture.repoPath, baseBranch: "main", goal: "Add multi-currency billing", planner: "native-claude", harness: "native-codex" } });
  await prisma.run.create({ data: { userId: user.id, planId: plan.id, repo: fixture.repoPath, baseBranch: "main", harness: "native-claude", kind: "plan", status: "queued", prompt: "Plan: Add multi-currency billing" } });
  const tasks: string[] = [];
  async function* stub(_ws: unknown, task: string, _h: string, _id: string, o: Opts = {}) {
    tasks.push(task);
    const dir = o.mounts!.find(([, inside]) => inside === PLAN_DIR)![0];
    expect(await Bun.file(path.join(dir, "goal.md")).text()).toBe("Add multi-currency billing");
    await write(dir);
    yield { seq: 0, ts: Date.now(), kind: "text" as const, data: "Planned." };
    yield { seq: 1, ts: Date.now(), kind: "done" as const, data: { result: "ok" } };
  }
  await processRun((await claimRun("worker-plan"))!, "worker-plan", stub as never);
  await fixture.cleanup();
  return { plan: await prisma.plan.findUniqueOrThrow({ where: { id: plan.id }, include: { tasks: { orderBy: { position: "asc" } } } }), tasks };
}

test("the planner reads the repo and writes the tasks, which wait for the user to start them", async () => {
  const { plan, tasks } = await planTurn((dir) =>
    Bun.write(path.join(dir, "plan.json"), JSON.stringify({
      summary: "Schema first, then the API and the UI.",
      tasks: [
        { key: "schema", title: "Currency column", prompt: "Add it", dependsOn: [] },
        { key: "api", title: "API", prompt: "Convert", dependsOn: ["schema"] },
        { key: "ui", title: "UI", prompt: "Show it", dependsOn: ["api"] },
      ],
    })).then(() => {}),
  );
  expect(tasks[0]).toStartWith("Plan this work");
  expect(plan).toMatchObject({ status: "ready", summary: "Schema first, then the API and the UI." });
  expect(plan.tasks.map((t) => [t.key, t.dependsOn, t.status])).toEqual([["schema", [], "pending"], ["api", ["schema"], "pending"], ["ui", ["api"], "pending"]]);
  const run = await prisma.run.findFirstOrThrow({ where: { planId: plan.id } });
  expect(run.output).toContain("2. API (after schema)");
});

test("a plan that can't run, or a planner that wrote nothing readable, fails with why", async () => {
  const cycle = await planTurn((dir) =>
    Bun.write(path.join(dir, "plan.json"), JSON.stringify({ tasks: [{ key: "a", title: "A", prompt: "a", dependsOn: ["b"] }, { key: "b", title: "B", prompt: "b", dependsOn: ["a"] }] })).then(() => {}),
  );
  expect(cycle.plan).toMatchObject({ status: "failed" });
  expect(cycle.plan.error).toContain("circle");
  const linked = await planTurn((dir) => symlink("/etc/hostname", path.join(dir, "plan.json")));
  expect(linked.plan).toMatchObject({ status: "failed", error: "The planner didn't write a plan." });
});

test("tasks start as the ones they wait for are merged, a few at a time, and the plan finishes when all are done", async () => {
  const user = await newUser();
  const repo = `acme/plan-${Date.now()}`;
  const plan = await prisma.plan.create({ data: { userId: user.id, repo, baseBranch: "main", goal: "Add multi-currency billing", planner: "native-claude", harness: "native-codex", status: "running", maxParallel: 2 } });
  const task = (key: string, position: number, dependsOn: string[] = []) => ({ planId: plan.id, key, title: `Task ${key}`, prompt: `Do ${key}`, dependsOn, position });
  await prisma.planTask.createMany({ data: [task("a", 0), task("b", 1), task("c", 2), task("d", 3, ["a", "b"]), task("e", 4, ["d"])] });
  const tasks = async () => Object.fromEntries((await prisma.planTask.findMany({ where: { planId: plan.id } })).map((t) => [t.key, t]));
  /** The task's session's latest turn ends; it changed code and opened a PR, or not. */
  const settle = async (key: string, data: object) => {
    const t = (await tasks())[key]!;
    await prisma.run.updateMany({ where: { threadId: t.threadId! }, data });
  };

  await advancePlan(plan.id);
  let t = await tasks();
  // Two at a time: a and b start, c waits for a slot, d for a and b.
  expect([t.a!.status, t.b!.status, t.c!.status, t.d!.status]).toEqual(["running", "running", "pending", "pending"]);
  expect(t.c!.note).toContain("2 at a time");
  expect(t.d!.note).toBe("Waiting for a, b to be merged.");
  const session = await prisma.thread.findUniqueOrThrow({ where: { id: t.a!.threadId! }, include: { runs: true } });
  expect(session).toMatchObject({ harness: "native-codex", autoMerge: true, planId: plan.id, title: "Task a" });
  expect(session.runs[0]!.prompt).toStartWith("Do a");
  expect(session.runs[0]!.prompt).toContain("one task of a larger plan: Add multi-currency billing");

  // a opens its PR (waiting to merge); b fails. c gets b's slot.
  await prisma.thread.update({ where: { id: t.a!.threadId! }, data: { prUrl: "https://github.com/acme/x/pull/1", mergeStatus: "Waiting for CI: test" } });
  await settle("a", { status: "succeeded", commitSha: "a".repeat(40) });
  await settle("b", { status: "failed", error: "Tests failed" });
  await advancePlan(plan.id);
  t = await tasks();
  expect([t.a!.status, t.a!.note, t.b!.status, t.c!.status]).toEqual(["review", "Waiting for CI: test", "failed", "running"]);
  expect(t.d!.note).toBe("Waiting on b, which needs you.");

  // a merges, b is skipped by the user, c merges: d starts, then e, then the plan is done.
  await prisma.thread.update({ where: { id: t.a!.threadId! }, data: { mergedAt: new Date() } });
  await prisma.planTask.update({ where: { id: t.b!.id }, data: { status: "skipped" } });
  await settle("c", { status: "succeeded", commitSha: "c".repeat(40) });
  await prisma.thread.update({ where: { id: t.c!.threadId! }, data: { mergedAt: new Date() } });
  await advancePlan(plan.id);
  t = await tasks();
  expect([t.a!.status, t.b!.status, t.c!.status, t.d!.status, t.e!.status]).toEqual(["done", "skipped", "done", "running", "pending"]);
  await prisma.thread.update({ where: { id: t.d!.threadId! }, data: { mergedAt: new Date() } });
  await advancePlan(plan.id);
  t = await tasks();
  expect(t.e!.status).toBe("running");
  await prisma.thread.update({ where: { id: t.e!.threadId! }, data: { mergedAt: new Date() } });
  await advancePlan(plan.id);
  expect((await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe("done");
  expect(await prisma.notification.count({ where: { key: `plan:${plan.id}:done` } })).toBe(1);
  // One session per task that started (b too, before it failed), never two.
  expect(await prisma.thread.count({ where: { planId: plan.id } })).toBe(5);
  // Passes at the same time don't start a task twice.
  const p2 = await prisma.plan.create({ data: { userId: user.id, repo, baseBranch: "main", goal: "Twice", planner: "native-claude", harness: "native-codex", status: "running" } });
  await prisma.planTask.create({ data: { planId: p2.id, key: "only", title: "Only", prompt: "x", position: 0 } });
  await Promise.all([advancePlan(p2.id), advancePlan(p2.id), advancePlan(p2.id)]);
  expect(await prisma.thread.count({ where: { planId: p2.id } })).toBe(1);
});
