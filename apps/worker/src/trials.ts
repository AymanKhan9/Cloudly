import { prisma, installTrialUpdate, Prisma } from "@repo/db";
import type { Run } from "@repo/shared/run";
import { trialInstall, type AgentLaunch } from "@repo/shared/providers";

import { createWorkspace, destroyWorkspace, type Workspace } from "./workspace";
import { resolveCloneSource } from "./github";
import { createRunContainer, cancelRun, type ContainerOptions } from "./docker";
import { insertEvents } from "./events";
import { heartbeat } from "./heartbeat";
import { costFromDoneEvent } from "./cost";
import { exportPatch } from "./finalize";
import { patchStats } from "./patch";
import { patchFiles } from "./screenshots";
import { repoSettings, checkCommandFor, runChecks } from "./checks";
import { sandboxImage } from "./sandbox-image";
import { withPreamble } from "./preamble";
import { pause } from "./pause";

// Trying an added agent's update before switching to it (Settings > Agents,
// "Test updates first"). The update check opens an AgentTrial instead of
// installing; this takes a few of the agent's sessions whose pull requests were
// merged, and replays each one's first message from the commit it started on,
// once with the version installed now and once with the new one (installed in
// that run's sandbox only). Then it compares: did each change something, did
// the repo's checks pass, how close did it come to the files that were merged,
// and what did it cost. The new version is installed only if it isn't worse.

const TASKS = 3;
const BACKSTOP_USD = 3;

export interface TrialSide {
  status: string;
  checks: string | null;
  costUsd: number | null;
  files: string[];
}
export interface TrialTask {
  threadId: string;
  title: string;
  merged: string[];
  current: string;
  candidate: string;
}

/** How much two sets of changed files agree: 1 is the same files. */
export function overlap(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const A = new Set(a);
  const both = b.filter((f) => A.has(f)).length;
  return both / new Set([...a, ...b]).size;
}

/**
 * The verdict, from both versions' results on the same tasks. The new version
 * passes if it finishes as many tasks, passes the checks as often, comes about as
 * close to what was merged, and doesn't cost much more.
 */
export function judgeTrial(tasks: { merged: string[]; current: TrialSide; candidate: TrialSide }[]): { passed: boolean; reason: string; summary: Record<string, number | null> } {
  const score = (side: "current" | "candidate") => {
    const done = tasks.filter((t) => t[side].status === "succeeded" && t[side].files.length).length;
    const checked = tasks.filter((t) => t[side].checks === "passed").length;
    const close = tasks.reduce((s, t) => s + overlap(t[side].files, t.merged), 0) / tasks.length;
    const costs = tasks.map((t) => t[side].costUsd).filter((c): c is number => c !== null);
    return { done, checked, close, cost: costs.length === tasks.length ? costs.reduce((a, b) => a + b, 0) : null };
  };
  const cur = score("current");
  const cand = score("candidate");
  const problems: string[] = [];
  if (cand.done < cur.done) problems.push(`it finished ${cand.done} of ${tasks.length} tasks to the current version's ${cur.done}`);
  if (cand.checked < cur.checked) problems.push(`the checks passed on ${cand.checked} of ${tasks.length} tasks, to the current version's ${cur.checked}`);
  if (cand.close < cur.close - 0.15) problems.push(`its changes were further from what was merged (${Math.round(cand.close * 100)}% of the same files, to ${Math.round(cur.close * 100)}%)`);
  if (cand.cost !== null && cur.cost !== null && cand.cost > cur.cost * 1.5 + 0.1) problems.push(`it cost $${cand.cost.toFixed(2)} to $${cur.cost.toFixed(2)}`);
  const summary = {
    tasks: tasks.length, currentDone: cur.done, candidateDone: cand.done, currentChecks: cur.checked, candidateChecks: cand.checked,
    currentClose: Math.round(cur.close * 100) / 100, candidateClose: Math.round(cand.close * 100) / 100, currentCost: cur.cost, candidateCost: cand.cost,
  };
  // Nothing finished on either side (the trial couldn't run them, or the tasks no
  // longer work): that shows nothing about the new version, so it isn't a pass.
  if (cur.done === 0 && cand.done === 0) {
    return { passed: false, reason: `Neither version finished any of the ${tasks.length} past task${tasks.length === 1 ? "" : "s"}, so the trial shows nothing either way.`, summary };
  }
  if (problems.length) return { passed: false, reason: `Worse on ${tasks.length} past task${tasks.length === 1 ? "" : "s"}: ${problems.join("; ")}.`, summary };
  return {
    passed: true,
    reason: `As good on ${tasks.length} past task${tasks.length === 1 ? "" : "s"}: finished ${cand.done} (current ${cur.done}), checks passed on ${cand.checked} (current ${cur.checked}), ${Math.round(cand.close * 100)}% the same files as merged (current ${Math.round(cur.close * 100)}%)${cand.cost !== null && cur.cost !== null ? `, $${cand.cost.toFixed(2)} (current $${cur.cost.toFixed(2)})` : ""}.`,
    summary,
  };
}

/** Starts a pending trial: its tasks, two runs each. Without past tasks the update installs as usual. */
async function startTrial(trial: { id: string; providerId: string; toVersion: string }): Promise<void> {
  const threads = await prisma.thread.findMany({
    where: { harness: trial.providerId, mergedAt: { not: null }, diffBase: { not: null } },
    orderBy: { mergedAt: "desc" },
    take: TASKS,
    select: { id: true, title: true, repo: true, baseBranch: true, userId: true, diffBase: true, diff: true },
  });
  const tasks: TrialTask[] = [];
  for (const t of threads) {
    const first = await prisma.run.findFirst({ where: { threadId: t.id, kind: "turn" }, orderBy: { createdAt: "asc" }, select: { prompt: true } });
    if (!first) continue;
    const make = (side: "current" | "candidate") =>
      prisma.run.create({
        data: {
          repo: t.repo, baseBranch: t.baseBranch, harness: trial.providerId, userId: t.userId, status: "queued", kind: "trial", prompt: first.prompt,
          trigger: { type: "trial", trialId: trial.id, side, base: t.diffBase, threadId: t.id },
        },
      });
    const [current, candidate] = [await make("current"), await make("candidate")];
    tasks.push({ threadId: t.id, title: t.title, merged: patchFiles(t.diff ?? ""), current: current.id, candidate: candidate.id });
  }
  if (!tasks.length) {
    await prisma.agentTrial.update({ where: { id: trial.id }, data: { status: "passed", verdict: "No merged sessions to try it on yet, so it's installed as usual." } });
    await installTrialUpdate(trial.id, `Updated to ${trial.toVersion}: no merged sessions to try it on first.`);
    return;
  }
  await prisma.agentTrial.update({ where: { id: trial.id }, data: { status: "running", results: { tasks } as never } });
}

/** A running trial whose runs are all done: judged, then installed or not. */
async function finishTrial(trial: { id: string; providerId: string; toVersion: string; fromVersion: string | null; results: unknown; launch: unknown }): Promise<boolean> {
  const tasks = ((trial.results as { tasks?: TrialTask[] } | null)?.tasks ?? []);
  const ids = tasks.flatMap((t) => [t.current, t.candidate]);
  const runs = await prisma.run.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, checkStatus: true, costUsd: true, output: true, error: true } });
  if (runs.length < ids.length || runs.some((r) => ["queued", "running", "finalizing"].includes(r.status))) return false;
  const side = (id: string): TrialSide => {
    const r = runs.find((x) => x.id === id)!;
    let files: string[] = [];
    try {
      files = (JSON.parse(r.output ?? "{}") as { files?: string[] }).files ?? [];
    } catch {}
    return { status: r.status, checks: r.checkStatus, costUsd: r.costUsd ? Number(r.costUsd) : null, files };
  };
  const judged = tasks.map((t) => ({ title: t.title, threadId: t.threadId, merged: t.merged, current: side(t.current), candidate: side(t.candidate) }));
  // The new version never installed in the sandbox: say that, not how its (empty) runs compared.
  const installErrors = tasks.map((t) => runs.find((r) => r.id === t.candidate)?.error ?? "").filter((e) => e.startsWith("The new version of "));
  const verdict = installErrors.length === tasks.length
    ? { passed: false, reason: installErrors[0]!.slice(0, 500), summary: judgeTrial(judged).summary }
    : judgeTrial(judged);
  await prisma.agentTrial.update({ where: { id: trial.id }, data: { status: verdict.passed ? "passed" : "failed", verdict: verdict.reason, results: { tasks, judged, summary: verdict.summary } as never } });
  if (verdict.passed) {
    await installTrialUpdate(trial.id, `Updated to ${trial.toVersion} after trying it: ${verdict.reason}`);
  } else {
    // Stays on the version it has; the user can still choose the new one.
    await prisma.provider.update({
      where: { id: trial.providerId },
      data: {
        updateState: "failed", skipVersion: trial.toVersion,
        updateNote: `Kept ${trial.fromVersion ?? "the current version"}: ${trial.toVersion} was tried first. ${verdict.reason}`,
        availableVersion: trial.toVersion, availableLaunch: trial.launch as Prisma.InputJsonValue,
      },
    });
  }
  return true;
}

export async function advanceTrials(): Promise<void> {
  for (const t of await prisma.agentTrial.findMany({ where: { status: "pending" }, take: 5 })) {
    const claimed = await prisma.agentTrial.updateMany({ where: { id: t.id, status: "pending" }, data: { status: "starting" } });
    if (claimed.count) await startTrial(t).catch(async (err) => {
      await prisma.agentTrial.update({ where: { id: t.id }, data: { status: "failed", verdict: `Couldn't start: ${err instanceof Error ? err.message : err}` } });
      await prisma.provider.update({ where: { id: t.providerId }, data: { updateState: "failed", updateNote: `Couldn't try ${t.toVersion}; staying on the current version.` } }).catch(() => {});
    });
  }
  for (const t of await prisma.agentTrial.findMany({ where: { status: "running" }, take: 10 })) {
    await finishTrial(t).catch((err) => console.error(`trial ${t.id}:`, err));
  }
}

export async function runTrialLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await advanceTrials().catch((err) => console.error("trials:", err));
    await pause(15_000, signal);
  }
}

/** One side of one trial task: the agent on the task from its starting commit; nothing is pushed. */
export async function processTrialRun(run: Run, workerId: string, heartbeatIntervalMs = 20_000): Promise<void> {
  let cancelled = false;
  let leaseLost = false;
  const fenced = { id: run.id, workerId, leaseGen: run.leaseGen };
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
  let ws: Workspace | undefined;
  let agentError: string | undefined;
  try {
    const row = await prisma.run.findUnique({ where: { id: run.id }, select: { trigger: true } });
    const t = row?.trigger as { trialId?: string; side?: string; base?: string } | null;
    const trial = t?.trialId ? await prisma.agentTrial.findUnique({ where: { id: t.trialId } }) : null;
    if (!trial || !t?.base) throw new Error("Not a trial run.");
    // At the commit the task started from. (Not a checkout afterwards: the run clone's
    // history is only readable inside the sandbox.)
    ws = await createWorkspace(await resolveCloneSource(run.repo), { baseBranch: run.baseBranch, commit: t.base });

    const options: ContainerOptions = { image: await sandboxImage(), maxBudgetUsd: BACKSTOP_USD };
    if (t.side === "candidate") options.trialLaunch = trialInstall(trial.providerId, trial.launch as unknown as AgentLaunch);
    let cost: number | null = null;
    try {
      for await (const event of createRunContainer(ws, withPreamble(run.prompt), run.harness, run.id, options)) {
        await insertEvents(run.id, [event]);
        if (event.kind === "error") {
          const d = event.data as { message?: unknown } | string | null;
          agentError = typeof d === "string" ? d : typeof d?.message === "string" ? d.message : agentError;
        }
        const c = costFromDoneEvent(run.harness, event);
        if (c) cost = c.usd;
        if (event.kind === "status") {
          const d = event.data as { type?: string; turnUsd?: unknown; sessionUsd?: unknown } | null;
          if (d?.type === "acp.cost" && typeof d.turnUsd === "number") cost = d.turnUsd;
          else if (d?.type === "acp.cost" && typeof d.sessionUsd === "number" && cost === null) cost = d.sessionUsd;
        }
      }
    } catch (err) {
      if (!cancelled) throw err;
    }
    if (leaseLost) return;
    const patch = await exportPatch(ws);
    const stats = patchStats(patch);
    let check: { status: string; command: string | null } | null = null;
    if (patch.trim()) {
      const settings = await repoSettings(run.repo);
      const command = await checkCommandFor(settings, ws.runDir);
      if (command) check = await runChecks({ runId: run.id, runDir: ws.runDir, objectsDir: ws.objectsDir, command, image: options.image!, timeoutSec: settings.checkTimeoutSec });
    }
    await prisma.run.updateMany({
      where: fenced,
      data: {
        status: cancelled ? "cancelled" : "succeeded", costUsd: cost, error: agentError ?? null,
        checkStatus: check?.status ?? null, checkCommand: check?.command ?? null,
        ...stats, output: JSON.stringify({ files: patchFiles(patch) }),
      },
    });
  } catch (err) {
    await prisma.run.updateMany({ where: fenced, data: { status: "failed", error: agentError ?? (err instanceof Error ? err.message : String(err)) } });
  } finally {
    clearInterval(timer);
    if (ws) await destroyWorkspace(ws);
  }
}
