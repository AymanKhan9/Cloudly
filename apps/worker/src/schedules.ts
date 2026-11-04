import { prisma, budgetStatus, harnessUsesPlan } from "@repo/db";
import { nextRun, type Frequency } from "@repo/shared/schedule";

import { repoSettings } from "./checks";
import { pause } from "./pause";

// Schedules: a task that runs on its own at set times. Each firing is either a
// new session or the next turn of the schedule's one session; both are ordinary
// queued runs from there. A firing is claimed by moving nextRunAt forward with
// a compare-and-set on its old value, so two workers can't both fire it. A
// worker that was down doesn't catch up: the next run is counted from now.

const ACTIVE = ["queued", "running", "finalizing"];

type ScheduleRow = Awaited<ReturnType<typeof prisma.schedule.findFirstOrThrow>>;

const spec = (s: ScheduleRow) => ({ frequency: s.frequency as Frequency, minuteOfDay: s.minuteOfDay, weekday: s.weekday, timeZone: s.timeZone });

/** What one firing does. Returns a note for the schedule's page, and the session it used. */
async function fire(s: ScheduleRow, firedAt: Date): Promise<{ note: string; threadId?: string }> {
  if (!(await harnessUsesPlan(s.harness)) && (await budgetStatus(s.userId)).state === "storm") {
    return { note: "Skipped: the monthly spend limit is reached." };
  }
  const run = {
    repo: s.repo, baseBranch: s.baseBranch, harness: s.harness, userId: s.userId, status: "queued" as const,
    prompt: s.prompt, kind: s.kind === "audit" ? "audit" : "turn",
    trigger: { type: "schedule", scheduleId: s.id, name: s.name } as never,
    triggerKey: `schedule:${s.id}:${firedAt.toISOString()}`,
  };

  const existing = s.mode === "continue" && s.threadId ? await prisma.thread.findFirst({ where: { id: s.threadId, userId: s.userId } }) : null;
  if (existing) {
    if (await prisma.run.count({ where: { threadId: existing.id, status: { in: ACTIVE as never } } })) {
      return { note: "Skipped: the session was still working on the last run.", threadId: existing.id };
    }
    await prisma.run.create({ data: { ...run, harness: existing.harness, threadId: existing.id } });
    await prisma.thread.update({ where: { id: existing.id }, data: { updatedAt: new Date(), settledAt: null, snoozedUntil: null, archivedAt: null, needsInput: null } });
    return { note: "Started the next turn.", threadId: existing.id };
  }

  const id = crypto.randomUUID();
  const settings = await repoSettings(s.repo);
  const day = firedAt.toISOString().slice(0, 10);
  await prisma.thread.create({
    data: {
      id, userId: s.userId, repo: s.repo, baseBranch: s.baseBranch, harness: s.harness,
      title: s.mode === "continue" ? s.name : `${s.name} (${day})`,
      branch: `agent/thread-${id.slice(0, 8)}`,
      scheduleId: s.id,
      autoMerge: settings.autoMerge,
      runs: { create: run },
    },
  });
  return { note: "Started a new session.", threadId: id };
}

/** Fires every schedule that's due. Returns how many fired. */
export async function fireDueSchedules(now = new Date()): Promise<number> {
  const due = await prisma.schedule.findMany({ where: { enabled: true, nextRunAt: { lte: now } }, orderBy: { nextRunAt: "asc" }, take: 50 });
  let fired = 0;
  for (const s of due) {
    let next: Date;
    try {
      next = nextRun(spec(s), now);
    } catch {
      await prisma.schedule.update({ where: { id: s.id }, data: { enabled: false, lastNote: "Turned off: its time couldn't be worked out." } });
      continue;
    }
    // Claim this firing: only the worker that moves nextRunAt on gets to run it.
    const claimed = await prisma.schedule.updateMany({ where: { id: s.id, nextRunAt: s.nextRunAt, enabled: true }, data: { nextRunAt: next, lastRunAt: now } });
    if (claimed.count === 0) continue;
    try {
      const r = await fire(s, s.nextRunAt);
      await prisma.schedule.update({
        where: { id: s.id },
        data: {
          lastNote: r.note,
          ...(r.threadId ? { lastThreadId: r.threadId } : {}),
          ...(s.mode === "continue" && r.threadId ? { threadId: r.threadId } : {}),
        },
      });
      fired++;
    } catch (err) {
      console.error(`[schedules] ${s.id}:`, err);
      await prisma.schedule.update({ where: { id: s.id }, data: { lastNote: `Failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) } });
    }
  }
  return fired;
}

export async function runScheduleLoop(signal: AbortSignal, intervalMs = 30_000): Promise<void> {
  while (!signal.aborted) {
    await fireDueSchedules().catch((err) => console.error("[schedules] loop:", err));
    await pause(intervalMs, signal);
  }
}
