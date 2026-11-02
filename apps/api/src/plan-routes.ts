import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma, budgetStatus, harnessUsesPlan, harnessAvailable } from "@repo/db";
import { checkPlan, PlanTaskSchema, MAX_TASKS } from "@repo/shared/plan";
import type { AuthEnv } from "./middleware/auth_middleware";
import { HARNESSES } from "./harnesses";

// Plans: a big task broken into sessions. The planner turn and the coordinator
// that starts each task run in the worker (apps/worker/src/plans.ts); this is
// creating, looking over and editing a plan, and starting it.

export const plans = new Hono<AuthEnv>();

const HARNESS = z.string().regex(/^[a-z0-9-]{1,80}$/);
const builtin = HARNESSES.map((h) => h.id);

async function ownPlan(c: { req: { param: (k: string) => string }; get: (k: "user") => { id: string } }) {
  return prisma.plan.findFirst({ where: { id: c.req.param("id"), userId: c.get("user").id } });
}

/** Queues the planner's turn for a plan. */
async function queuePlanner(plan: { id: string; userId: string; repo: string; baseBranch: string; planner: string; goal: string }) {
  await prisma.run.create({
    data: {
      userId: plan.userId, planId: plan.id, repo: plan.repo, baseBranch: plan.baseBranch, harness: plan.planner,
      kind: "plan", status: "queued", prompt: `Plan: ${plan.goal.split("\n")[0]!.slice(0, 200)}`,
    },
  });
}

const CreateSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  baseBranch: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(8000),
  /** The agent that plans; each task's sessions use `harness`, the same one if left out. */
  planner: HARNESS,
  harness: HARNESS.optional(),
  maxParallel: z.number().int().min(1).max(6).optional(),
  autoMerge: z.boolean().optional(),
});

plans.post("/", zValidator("json", CreateSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const harness = body.harness ?? body.planner;
  for (const h of [body.planner, harness]) {
    if (!(await harnessAvailable(h, builtin))) return c.json({ message: `The agent "${h}" isn't available here.` }, 400);
  }
  if ((await budgetStatus(user.id)).state === "storm" && !(await harnessUsesPlan(body.planner))) {
    return c.json({ message: "Monthly spend limit reached. Raise it in Settings to start a plan." }, 402);
  }
  const plan = await prisma.plan.create({
    data: { userId: user.id, repo: body.repo, baseBranch: body.baseBranch, goal: body.goal, planner: body.planner, harness, maxParallel: body.maxParallel ?? 3, autoMerge: body.autoMerge ?? true },
  });
  await queuePlanner(plan);
  return c.json({ id: plan.id }, 201);
});

plans.get("/", async (c) => {
  const rows = await prisma.plan.findMany({
    where: { userId: c.get("user").id },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { tasks: { select: { status: true } } },
  });
  return c.json({
    plans: rows.map(({ tasks, ...p }) => ({ ...p, total: tasks.length, done: tasks.filter((t) => t.status === "done" || t.status === "skipped").length, needsYou: tasks.filter((t) => t.status === "failed" || t.status === "needs_you").length })),
  });
});

plans.get("/:id", async (c) => {
  const plan = await ownPlan(c);
  if (!plan) return c.json({ message: "Plan not found" }, 404);
  const tasks = await prisma.planTask.findMany({ where: { planId: plan.id }, orderBy: { position: "asc" } });
  const threads = await prisma.thread.findMany({
    where: { id: { in: tasks.map((t) => t.threadId).filter((x): x is string => Boolean(x)) } },
    select: { id: true, title: true, prUrl: true, mergedAt: true, harness: true },
  });
  const planner = await prisma.run.findFirst({ where: { planId: plan.id }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, error: true, output: true, costUsd: true, harness: true, createdAt: true } });
  return c.json({
    plan,
    tasks: tasks.map((t) => ({ ...t, session: threads.find((x) => x.id === t.threadId) ?? null })),
    planner: planner ? { ...planner, costUsd: planner.costUsd?.toNumber() ?? null } : null,
  });
});

// Edits the tasks before the plan starts: the whole list, checked like the planner's.
plans.put("/:id/tasks", zValidator("json", z.object({ tasks: z.array(PlanTaskSchema).min(1).max(MAX_TASKS) })), async (c) => {
  const plan = await ownPlan(c);
  if (!plan) return c.json({ message: "Plan not found" }, 404);
  if (plan.status !== "ready") return c.json({ message: "Tasks can only be changed before the plan starts." }, 409);
  const checked = checkPlan({ tasks: c.req.valid("json").tasks });
  if (!checked.ok) return c.json({ message: checked.error }, 400);
  await prisma.$transaction([
    prisma.planTask.deleteMany({ where: { planId: plan.id } }),
    prisma.planTask.createMany({ data: checked.tasks.map((t, i) => ({ planId: plan.id, key: t.key, title: t.title, prompt: t.prompt, dependsOn: t.dependsOn, position: i })) }),
  ]);
  return c.json({ ok: true });
});

plans.post(
  "/:id/start",
  zValidator("json", z.object({ maxParallel: z.number().int().min(1).max(6).optional(), autoMerge: z.boolean().optional(), harness: HARNESS.optional() })),
  async (c) => {
    const plan = await ownPlan(c);
    if (!plan) return c.json({ message: "Plan not found" }, 404);
    if (plan.status !== "ready") return c.json({ message: plan.status === "planning" ? "The planner is still working." : "This plan has started already." }, 409);
    const { maxParallel, autoMerge, harness } = c.req.valid("json");
    if (harness && !(await harnessAvailable(harness, builtin))) return c.json({ message: "That agent isn't available here." }, 400);
    await prisma.plan.update({
      where: { id: plan.id },
      data: { status: "running", ...(maxParallel ? { maxParallel } : {}), ...(autoMerge !== undefined ? { autoMerge } : {}), ...(harness ? { harness } : {}) },
    });
    return c.json({ ok: true });
  },
);

// Plans again, with the same goal or a changed one, before it starts or after the planner failed.
plans.post("/:id/replan", zValidator("json", z.object({ goal: z.string().trim().min(1).max(8000).optional() })), async (c) => {
  const plan = await ownPlan(c);
  if (!plan) return c.json({ message: "Plan not found" }, 404);
  if (plan.status !== "ready" && plan.status !== "failed") return c.json({ message: "Only a plan that hasn't started can be planned again." }, 409);
  const goal = c.req.valid("json").goal ?? plan.goal;
  const updated = await prisma.plan.update({ where: { id: plan.id }, data: { goal, status: "planning", error: null } });
  await queuePlanner(updated);
  return c.json({ ok: true });
});

// Stops starting tasks. Sessions already working carry on; the rest are skipped.
plans.post("/:id/cancel", async (c) => {
  const plan = await ownPlan(c);
  if (!plan) return c.json({ message: "Plan not found" }, 404);
  await prisma.$transaction([
    prisma.plan.update({ where: { id: plan.id }, data: { status: "cancelled" } }),
    prisma.planTask.updateMany({ where: { planId: plan.id, threadId: null }, data: { status: "skipped", note: "The plan was cancelled." } }),
    prisma.run.updateMany({ where: { planId: plan.id, status: "queued" }, data: { status: "cancelled", cancelRequested: true } }),
  ]);
  return c.json({ ok: true });
});

// A task that failed or needs you can be skipped: the ones after it go ahead without it.
plans.post("/:id/tasks/:taskId/skip", async (c) => {
  const plan = await ownPlan(c);
  if (!plan) return c.json({ message: "Plan not found" }, 404);
  const r = await prisma.planTask.updateMany({
    where: { id: c.req.param("taskId"), planId: plan.id, status: { in: ["pending", "failed", "needs_you", "review"] } },
    data: { status: "skipped", note: "Skipped." },
  });
  if (r.count === 0) return c.json({ message: "That task can't be skipped now." }, 409);
  return c.json({ ok: true });
});
