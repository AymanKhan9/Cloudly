import { test, expect, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import { fireDueSchedules } from "../src/schedules";

const stamp = Date.now();
const repo = `acme/sched-${stamp}`;
let userId = "";
afterAll(async () => {
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.repoSettings.deleteMany({ where: { repo } });
});

async function schedule(data: Partial<Parameters<typeof prisma.schedule.create>[0]["data"]> = {}) {
  if (!userId) userId = (await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `sched-${stamp}` } })).id;
  return prisma.schedule.create({
    data: {
      userId, name: "Nightly deps", repo, baseBranch: "main", harness: "native-codex", prompt: "Update dependencies and fix what breaks",
      frequency: "daily", minuteOfDay: 120, timeZone: "UTC", nextRunAt: new Date("2026-11-02T02:00:00Z"), ...data,
    } as never,
  });
}

test("a due schedule starts a session once, and moves on to its next time", async () => {
  await prisma.repoSettings.create({ data: { repo, autoMerge: true } });
  const s = await schedule();
  const now = new Date("2026-11-02T02:00:30Z");
  // Two workers at once: only one fires it.
  const [a, b] = await Promise.all([fireDueSchedules(now), fireDueSchedules(now)]);
  expect(a + b).toBe(1);
  const after = await prisma.schedule.findUniqueOrThrow({ where: { id: s.id } });
  expect(after.nextRunAt.toISOString()).toBe("2026-11-03T02:00:00.000Z");
  expect(after.lastNote).toBe("Started a new session.");
  const thread = await prisma.thread.findUniqueOrThrow({ where: { id: after.lastThreadId! }, include: { runs: true } });
  expect(thread).toMatchObject({ title: "Nightly deps (2026-11-02)", harness: "native-codex", scheduleId: s.id, autoMerge: true });
  expect(thread.runs[0]).toMatchObject({ prompt: "Update dependencies and fix what breaks", kind: "turn", status: "queued" });
  expect(thread.runs[0]!.trigger).toMatchObject({ type: "schedule", name: "Nightly deps" });
  // Not due again until tomorrow.
  expect(await fireDueSchedules(new Date("2026-11-02T12:00:00Z"))).toBe(0);
});

test("a continuing schedule reuses its session, and skips while it's busy; paused ones and the spend limit stop it", async () => {
  const s = await schedule({ name: "Weekly audit", kind: "audit", mode: "continue", frequency: "weekly", weekday: 1, nextRunAt: new Date("2026-11-02T02:00:00Z") });
  await fireDueSchedules(new Date("2026-11-02T02:01:00Z"));
  const first = await prisma.schedule.findUniqueOrThrow({ where: { id: s.id } });
  expect(first.threadId).toBeTruthy();
  expect(first.nextRunAt.toISOString()).toBe("2026-11-09T02:00:00.000Z");
  const run1 = await prisma.run.findFirstOrThrow({ where: { threadId: first.threadId! } });
  expect(run1.kind).toBe("audit");

  // Still queued at the next firing: skipped, same session.
  await fireDueSchedules(new Date("2026-11-09T02:00:10Z"));
  expect((await prisma.schedule.findUniqueOrThrow({ where: { id: s.id } })).lastNote).toBe("Skipped: the session was still working on the last run.");
  expect(await prisma.run.count({ where: { threadId: first.threadId! } })).toBe(1);

  // Done by the one after: the next turn in the same session.
  await prisma.run.update({ where: { id: run1.id }, data: { status: "succeeded" } });
  await fireDueSchedules(new Date("2026-11-16T02:00:10Z"));
  expect(await prisma.run.count({ where: { threadId: first.threadId! } })).toBe(2);
  expect(await prisma.thread.count({ where: { scheduleId: s.id } })).toBe(1);

  // Paused: nothing.
  const paused = await prisma.schedule.update({ where: { id: s.id }, data: { enabled: false, nextRunAt: new Date("2026-11-23T02:00:00Z") } });
  await fireDueSchedules(new Date("2026-11-23T02:00:10Z"));
  expect((await prisma.schedule.findUniqueOrThrow({ where: { id: s.id } })).lastRunAt).toEqual(paused.lastRunAt);
  expect(await prisma.run.count({ where: { threadId: first.threadId! } })).toBe(2);

  // The spend limit reached: the firing is skipped and says so.
  await prisma.budget.create({ data: { userId, monthlyLimitUsd: 1 } });
  await prisma.run.create({ data: { userId, repo, baseBranch: "main", harness: "native-codex", prompt: "spend", status: "succeeded", costUsd: 5 } });
  const capped = await schedule({ name: "Capped", nextRunAt: new Date("2026-11-02T02:00:00Z") });
  await fireDueSchedules(new Date("2026-11-02T02:00:30Z"));
  const c = await prisma.schedule.findUniqueOrThrow({ where: { id: capped.id } });
  expect(c.lastNote).toBe("Skipped: the monthly spend limit is reached.");
  expect(c.lastThreadId).toBeNull();
});
