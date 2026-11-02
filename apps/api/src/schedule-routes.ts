import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "@repo/db";
import { nextRun, describeSchedule, FREQUENCIES, validTimeZone, type Frequency } from "@repo/shared/schedule";
import type { AuthEnv } from "./middleware/auth_middleware";

// Schedules: tasks that run on their own. The API only stores them and their
// next run time; the worker fires them (apps/worker/src/schedules.ts).

export const schedules = new Hono<AuthEnv>();

const Fields = z.object({
  name: z.string().trim().min(1).max(80),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  baseBranch: z.string().trim().min(1).max(200),
  harness: z.string().regex(/^[a-z0-9-]{1,80}$/),
  prompt: z.string().trim().min(1).max(8000),
  kind: z.enum(["turn", "audit"]).default("turn"),
  mode: z.enum(["new", "continue"]).default("new"),
  frequency: z.enum(FREQUENCIES),
  minuteOfDay: z.number().int().min(0).max(1439),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  timeZone: z.string().min(1).max(64).refine(validTimeZone, "Unknown time zone"),
  enabled: z.boolean().default(true),
});
const weeklyNeedsDay = (s: { frequency?: string; weekday?: number | null }) => s.frequency !== "weekly" || typeof s.weekday === "number";

const view = (s: Awaited<ReturnType<typeof prisma.schedule.findFirstOrThrow>>) => ({
  ...s,
  description: describeSchedule({ frequency: s.frequency as Frequency, minuteOfDay: s.minuteOfDay, weekday: s.weekday }),
});

schedules.get("/", async (c) => {
  const rows = await prisma.schedule.findMany({ where: { userId: c.get("user").id }, orderBy: { createdAt: "asc" } });
  const ids = [...new Set(rows.map((r) => r.lastThreadId).filter((x): x is string => Boolean(x)))];
  const titles = new Map((await prisma.thread.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } })).map((t) => [t.id, t.title]));
  return c.json({ schedules: rows.map((r) => ({ ...view(r), lastThreadTitle: r.lastThreadId ? titles.get(r.lastThreadId) ?? null : null })) });
});

schedules.post("/", zValidator("json", Fields.refine(weeklyNeedsDay, { message: "Pick a day of the week.", path: ["weekday"] })), async (c) => {
  const body = c.req.valid("json");
  const s = await prisma.schedule.create({
    data: { ...body, weekday: body.frequency === "weekly" ? body.weekday : null, userId: c.get("user").id, nextRunAt: nextRun({ ...body, frequency: body.frequency }, new Date()) },
  });
  return c.json(view(s), 201);
});

schedules.patch("/:id", zValidator("json", Fields.partial()), async (c) => {
  const s = await prisma.schedule.findFirst({ where: { id: c.req.param("id"), userId: c.get("user").id } });
  if (!s) return c.json({ message: "Schedule not found" }, 404);
  const body = c.req.valid("json");
  const merged = { ...s, ...body };
  if (!weeklyNeedsDay(merged)) return c.json({ message: "Pick a day of the week." }, 400);
  // A new time, or turning it back on, counts the next run from now.
  const timing = ["frequency", "minuteOfDay", "weekday", "timeZone"].some((k) => k in body) || (body.enabled === true && !s.enabled);
  const updated = await prisma.schedule.update({
    where: { id: s.id },
    data: {
      ...body,
      ...(merged.frequency !== "weekly" ? { weekday: null } : {}),
      // A different repo or a fresh start: no session to continue.
      ...(body.repo && body.repo !== s.repo ? { threadId: null } : {}),
      ...(timing ? { nextRunAt: nextRun({ frequency: merged.frequency as Frequency, minuteOfDay: merged.minuteOfDay, weekday: merged.weekday, timeZone: merged.timeZone }, new Date()) } : {}),
    },
  });
  return c.json(view(updated));
});

schedules.delete("/:id", async (c) => {
  const r = await prisma.schedule.deleteMany({ where: { id: c.req.param("id"), userId: c.get("user").id } });
  if (r.count === 0) return c.json({ message: "Schedule not found" }, 404);
  return c.body(null, 204);
});

// Run now: due immediately; the worker fires it within half a minute.
schedules.post("/:id/run", async (c) => {
  const r = await prisma.schedule.updateMany({ where: { id: c.req.param("id"), userId: c.get("user").id, enabled: true }, data: { nextRunAt: new Date() } });
  if (r.count === 0) return c.json({ message: "Schedule not found, or it's paused." }, 404);
  return c.json({ ok: true });
});
