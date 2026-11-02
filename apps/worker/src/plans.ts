import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma, budgetStatus, harnessUsesPlan } from "@repo/db";
import type { Run } from "@repo/shared/run";
import type { RunEvent } from "@repo/shared/run-event";
import { checkPlan, taskPrompt, type PlanTaskInput } from "@repo/shared/plan";

import { createRunContainer, cancelRun, type ContainerOptions } from "./docker";
import { createWorkspace, destroyWorkspace, type Workspace } from "./workspace";
import { resolveCloneSource } from "./github";
import { insertEvents } from "./events";
import { heartbeat } from "./heartbeat";
import { costFromDoneEvent } from "./cost";
import { enforceBudget } from "./budget";
import { readRegular } from "./repo-files";
import { sandboxImage } from "./sandbox-image";
import { notify } from "./notify";

// Plans: a big task broken into smaller ones, each its own session and pull
// request. The planner agent reads the repo (changing nothing) and writes the
// tasks with the order between them; the user can edit them, then starts the
// plan. From then on the coordinator below starts each task's session once the
// tasks it waits for are merged (plan sessions merge when ready), a few at a
// time, and keeps each task's status in step with its session.

export const PLAN_DIR = "/workspace/.cloudly-plan";
const PLAN_MAX = 256 * 1024;
const BACKSTOP_USD = 20;
const OVERSHOOT_RATIO = 0.25;
const ACTIVE = ["queued", "running", "finalizing"];

type RunContainer = (ws: Workspace, task: string, harness: string, runId: string, options?: ContainerOptions) => AsyncIterable<RunEvent>;

export const PLANNER_PROMPT = [
  "Plan this work",
  "",
  `Break the goal in ${PLAN_DIR}/goal.md into tasks that other agents will each do in their own session and pull request. Read the repo first, so the tasks fit how it's built. Don't change any files: nothing you change is kept.`,
  "",
  `Write the plan to ${PLAN_DIR}/plan.json:`,
  "",
  "```json",
  '{ "summary": "Two or three sentences: the approach, and the order.",',
  '  "tasks": [ { "key": "schema", "title": "Add a currency column to invoices", "prompt": "What to do, where, and how to know it is done.", "dependsOn": [] } ] }',
  "```",
  "",
  "- Two to eight tasks is usually right, twelve at most. A goal small enough for one session is one task.",
  "- Each task is one pull request a reviewer can take in at once: coherent, tested, and working on its own.",
  "- dependsOn lists the keys of tasks that must be merged first because this one builds on their code. Leave it empty when a task can start right away, so tasks run side by side.",
  "- Each prompt says what to do, which files or areas it touches, and how to check it (tests to add or run). The agent doing it sees only its prompt and the repo.",
].join("\n");

/** The planner's turn: reads the repo, writes plan.json, and the plan's tasks are saved for the user to look over. */
export async function processPlanTurn(run: Run, workerId: string, runContainer: RunContainer = createRunContainer, heartbeatIntervalMs = 20_000): Promise<void> {
  let cancelled = false;
  let leaseLost = false;
  const timer = setInterval(() => {
    heartbeat(run.id, workerId).then((ok) => {
      if (!ok) leaseLost = true;
    });
    prisma.run.findUnique({ where: { id: run.id }, select: { cancelRequested: true } }).then((r) => {
      if (r?.cancelRequested && !cancelled) {
        cancelled = true;
        cancelRun(run.id).catch(() => {});
      }
    });
  }, heartbeatIntervalMs);
  const fenced = { id: run.id, workerId, leaseGen: run.leaseGen };
  let ws: Workspace | undefined;
  let dir: string | undefined;
  let agentError: string | undefined;
  const fail = async (message: string) => {
    await prisma.run.updateMany({ where: fenced, data: { status: cancelled ? "cancelled" : "failed", error: message } });
    await prisma.plan.update({ where: { id: run.planId! }, data: { status: "failed", error: message } });
  };
  try {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: run.planId! } });
    ws = await createWorkspace(await resolveCloneSource(plan.repo), { baseBranch: plan.baseBranch });
    dir = await mkdtemp(path.join(tmpdir(), "plan-"));
    await writeFile(path.join(dir, "goal.md"), plan.goal);

    const onPlan = await harnessUsesPlan(run.harness);
    if (onPlan) await prisma.run.updateMany({ where: fenced, data: { onPlan: true } });
    const options: ContainerOptions = { image: await sandboxImage(), mounts: [[dir, PLAN_DIR]] };
    if (!onPlan) {
      const budget = run.userId ? await budgetStatus(run.userId) : null;
      if (budget?.limitUsd != null) {
        const left = budget.limitUsd - budget.spentUsd;
        if (left <= 0) throw new Error("Monthly spend limit reached");
        options.maxBudgetUsd = Math.min(BACKSTOP_USD, left + budget.limitUsd * OVERSHOOT_RATIO);
      } else {
        options.maxBudgetUsd = BACKSTOP_USD;
      }
    }

    let lastText: string | undefined;
    try {
      for await (const event of runContainer(ws, PLANNER_PROMPT, run.harness, run.id, options)) {
        await insertEvents(run.id, [event]);
        if (event.kind === "text" && typeof event.data === "string" && event.data.trim()) lastText = event.data;
        if (event.kind === "error") {
          const d = event.data as { message?: unknown } | string | null;
          agentError = typeof d === "string" ? d : typeof d?.message === "string" ? d.message : agentError;
        }
        const cost = onPlan ? null : costFromDoneEvent(run.harness, event);
        if (cost) {
          await prisma.run.updateMany({ where: fenced, data: { costUsd: cost.usd } });
          if (run.userId) await enforceBudget(run.userId);
        }
      }
    } catch (err) {
      if (!cancelled) throw err;
    }
    if (leaseLost) return;
    if (cancelled) return void (await fail("Planning was cancelled."));

    // plan.json, read the way any file the agent wrote is (no symlinks, size capped),
    // or a JSON block in its last reply.
    const bytes = await readRegular(path.join(dir, "plan.json"), PLAN_MAX);
    const candidates = [bytes ? new TextDecoder().decode(bytes) : null, lastText?.match(/```(?:json)?\s*\n([\s\S]*?)```/)?.[1] ?? null];
    let checked: ReturnType<typeof checkPlan> = { ok: false, error: "The planner didn't write a plan." };
    for (const text of candidates) {
      if (!text) continue;
      try {
        checked = checkPlan(JSON.parse(text));
        break;
      } catch {
        checked = { ok: false, error: "The plan wasn't valid JSON." };
      }
    }
    if (!checked.ok) return void (await fail(agentError ?? checked.error));

    const tasks = checked.tasks;
    const listing = tasks.map((t, i) => `${i + 1}. ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`).join("\n");
    await prisma.$transaction(async (tx) => {
      const moved = await tx.run.updateMany({ where: fenced, data: { status: "succeeded", output: [checked.summary, listing].filter(Boolean).join("\n\n") } });
      if (moved.count === 0) return;
      await tx.planTask.deleteMany({ where: { planId: plan.id } });
      await tx.planTask.createMany({ data: tasks.map((t, i) => ({ planId: plan.id, key: t.key, title: t.title, prompt: t.prompt, dependsOn: t.dependsOn, position: i })) });
      await tx.plan.update({ where: { id: plan.id }, data: { status: "ready", summary: checked.summary, error: null } });
    });
  } catch (err) {
    await fail(agentError ?? (err instanceof Error ? err.message : String(err)));
  } finally {
    clearInterval(timer);
    if (ws) await destroyWorkspace(ws);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

type TaskRow = Awaited<ReturnType<typeof prisma.planTask.findMany>>[number];

/** Where a started task is, from its session. */
async function sessionState(task: TaskRow): Promise<{ status: string; note: string | null }> {
  const thread = task.threadId ? await prisma.thread.findUnique({ where: { id: task.threadId } }) : null;
  if (!thread) return { status: "failed", note: "Its session was deleted." };
  if (thread.mergedAt) return { status: "done", note: null };
  const runs = await prisma.run.findMany({ where: { threadId: thread.id, rewoundAt: null, kind: { notIn: ["rewind", "fork"] } }, orderBy: { createdAt: "desc" }, take: 20 });
  if (runs.some((r) => ACTIVE.includes(r.status))) return { status: "running", note: null };
  if (thread.needsInput) return { status: "needs_you", note: thread.needsInput };
  const last = runs[0];
  if (last?.status === "failed") return { status: "failed", note: last.error ?? "Its last turn failed." };
  if (last?.status === "cancelled") return { status: "needs_you", note: "Its turn was cancelled." };
  if (!runs.some((r) => r.commitSha)) return { status: "needs_you", note: "The agent didn't change anything." };
  // A pull request waiting to merge (merge-when-ready says why, if it's on).
  if (thread.prUrl) return { status: "review", note: thread.autoMerge ? thread.mergeStatus ?? "Waiting to merge" : "Waiting for you to merge it" };
  // A repo with no GitHub remote: committed is as done as it gets.
  return { status: "done", note: null };
}

/** Starts a task's session. Claimed first, so two workers can't both start it. */
async function startTask(plan: Awaited<ReturnType<typeof prisma.plan.findUniqueOrThrow>>, task: TaskRow, all: TaskRow[]): Promise<boolean> {
  const claimed = await prisma.planTask.updateMany({ where: { id: task.id, status: "pending", threadId: null }, data: { status: "running", note: null } });
  if (claimed.count === 0) return false;
  const id = crypto.randomUUID();
  const asInput = (t: TaskRow): PlanTaskInput => ({ key: t.key, title: t.title, prompt: t.prompt, dependsOn: t.dependsOn });
  try {
    await prisma.thread.create({
      data: {
        id, userId: plan.userId, repo: plan.repo, baseBranch: plan.baseBranch, harness: plan.harness,
        title: task.title, branch: `agent/plan-${plan.id.slice(0, 6)}-${task.key}`.slice(0, 90),
        autoMerge: plan.autoMerge, planId: plan.id,
        runs: {
          create: {
            repo: plan.repo, baseBranch: plan.baseBranch, harness: plan.harness, userId: plan.userId, status: "queued",
            prompt: taskPrompt(plan.goal, asInput(task), all.map(asInput)),
            trigger: { type: "plan", planId: plan.id, name: plan.goal.split("\n")[0]!.slice(0, 120) } as never,
          },
        },
      },
    });
    await prisma.planTask.update({ where: { id: task.id }, data: { threadId: id } });
    return true;
  } catch (err) {
    await prisma.planTask.update({ where: { id: task.id }, data: { status: "pending", note: `Couldn't start: ${(err as Error).message}`.slice(0, 300) } });
    throw err;
  }
}

/** One pass over a running plan: task statuses from their sessions, and the tasks that can start now. */
export async function advancePlan(planId: string): Promise<void> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
  if (plan.status !== "running") return;
  const tasks = await prisma.planTask.findMany({ where: { planId }, orderBy: { position: "asc" } });

  for (const t of tasks) {
    if (!t.threadId || t.status === "skipped") continue;
    const s = await sessionState(t);
    if (s.status !== t.status || s.note !== t.note) {
      await prisma.planTask.update({ where: { id: t.id }, data: s });
      Object.assign(t, s);
    }
  }

  const finished = (key: string) => tasks.some((x) => x.key === key && (x.status === "done" || x.status === "skipped"));
  if (tasks.every((t) => t.status === "done" || t.status === "skipped")) {
    await prisma.plan.update({ where: { id: planId }, data: { status: "done" } });
    await notify({ userId: plan.userId, kind: "done", title: `Plan: ${plan.goal.split("\n")[0]!.slice(0, 100)}`, body: `All ${tasks.length} tasks are done.`, key: `plan:${planId}:done` });
    return;
  }

  let working = tasks.filter((t) => t.status === "running").length;
  for (const t of tasks) {
    if (t.status !== "pending" || t.threadId) continue;
    const waitingFor = t.dependsOn.filter((d) => !finished(d));
    if (waitingFor.length) {
      const stuck = waitingFor.filter((d) => tasks.some((x) => x.key === d && (x.status === "failed" || x.status === "needs_you")));
      const note = stuck.length ? `Waiting on ${stuck.join(", ")}, which needs you.` : `Waiting for ${waitingFor.join(", ")} to be merged.`;
      if (note !== t.note) await prisma.planTask.update({ where: { id: t.id }, data: { note } });
      continue;
    }
    if (working >= plan.maxParallel) {
      const note = `Starts when a running task finishes (${plan.maxParallel} at a time).`;
      if (note !== t.note) await prisma.planTask.update({ where: { id: t.id }, data: { note } });
      continue;
    }
    if (!(await harnessUsesPlan(plan.harness)) && (await budgetStatus(plan.userId)).state === "storm") {
      await prisma.planTask.update({ where: { id: t.id }, data: { note: "Waiting: the monthly spend limit is reached." } });
      continue;
    }
    if (await startTask(plan, t, tasks)) working++;
  }
}

export async function advancePlans(): Promise<void> {
  for (const p of await prisma.plan.findMany({ where: { status: "running" }, select: { id: true } })) {
    await advancePlan(p.id).catch((err) => console.error(`[plans] ${p.id}:`, err));
  }
}

export async function runPlanLoop(signal: AbortSignal, intervalMs = 5000): Promise<void> {
  while (!signal.aborted) {
    await advancePlans().catch((err) => console.error("[plans] loop:", err));
    await Bun.sleep(intervalMs);
  }
}
