import { prisma } from "@repo/db";
import type { Run } from "@repo/shared/run";
import type { RunEvent } from "@repo/shared/run-event";

import { createWorkspace, destroyWorkspace, type Workspace } from "./workspace";
import { createRunContainer, cancelRun } from "./docker";
import {
  exportPatch,
  publishCommit,
  destroyPublish,
  pushBranch,
  openPullRequest,
  type CommitInfo,
  type PublishResult,
} from "./finalize";
import { insertEvents } from "./events";
import { heartbeat } from "./heartbeat";
import { resolveCloneSource, isRepoSlug } from "./github";

const HEARTBEAT_INTERVAL_MS = 20_000;

export async function processRun(
  run: Run,
  workerId: string,
  runContainer: (
    ws: Workspace,
    task: string,
    harness: string,
    runId: string,
  ) => AsyncIterable<RunEvent> = createRunContainer,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
): Promise<void> {
  let leaseLost = false;
  let cancelled = false;

  const heartbeatTimer = setInterval(() => {
    heartbeat(run.id, workerId).then((ok) => {
      if (!ok) {
        leaseLost = true;
        console.error(`run ${run.id}: lease lost, another worker took over`);
      }
    });

    prisma.run
      .findUnique({ where: { id: run.id }, select: { cancelRequested: true } })
      .then((current) => {
        if (current?.cancelRequested) {
          cancelled = true;
          cancelRun(run.id).catch((err) =>
            console.error(`run ${run.id}: failed to send SIGINT:`, err),
          );
        }
      });
  }, heartbeatIntervalMs);

  let ws: Workspace | undefined;
  let publishResult: PublishResult | undefined;

  try {
    ws = await createWorkspace(await resolveCloneSource(run.repo));

    try {
      for await (const event of runContainer(ws, run.prompt, run.harness, run.id)) {
        await insertEvents(run.id, [event]);
      }
    } catch (err) {
      // A SIGINT-triggered abort throws the same way a genuine crash does —
      // the SDKs give no way to tell them apart from the thrown error alone.
      // We already know locally whether *we* requested the cancellation, so
      // that's the signal we trust, not the error's text or the exit code.
      if (!cancelled) throw err;
      console.error(`run ${run.id}: container exited via cancellation:`, err);
    }

    if (leaseLost) return;

    // Fenced transition: only the worker that still holds this exact
    // (workerId, leaseGen) pair may move the run into finalizing.
    const toFinalizing = await prisma.run.updateMany({
      where: { id: run.id, workerId, leaseGen: run.leaseGen },
      data: { status: "finalizing" },
    });
    if (toFinalizing.count === 0) return;

    // Cancelled or not, still export/commit whatever the agent produced —
    // only the (not-yet-built) PR step is what cancellation actually skips.
    const patch = await exportPatch(ws);

    const commitInfo: CommitInfo = {
      runId: run.id,
      task: run.prompt,
      createdAt: run.createdAt,
    };
    publishResult = await publishCommit(ws, patch, commitInfo);

    if (leaseLost) return;

    // Only GitHub-slug repos have a real remote to push to — every worker
    // test fixture uses a local path, same gate `resolveCloneSource` uses.
    if (isRepoSlug(run.repo)) {
      await pushBranch(publishResult, run.repo);

      // Cancelled or not, the push above still lands — only PR creation is
      // what cancellation skips (see the comment above `exportPatch`).
      if (!cancelled) {
        await openPullRequest({
          repoSlug: run.repo,
          baseBranch: run.baseBranch,
          branch: publishResult.branch,
          title: `Agent run: ${run.prompt}`,
          body: `Opened by Cloud Agents for run \`${run.id}\`.`,
        });
      }
    }

    if (leaseLost) return;

    await prisma.run.updateMany({
      where: { id: run.id, workerId, leaseGen: run.leaseGen },
      data: {
        status: cancelled ? "cancelled" : "succeeded",
        commitSha: publishResult.commitSha,
      },
    });
  } catch (err) {
    await prisma.run.updateMany({
      where: { id: run.id, workerId, leaseGen: run.leaseGen },
      data: {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  } finally {
    clearInterval(heartbeatTimer);
    if (ws) await destroyWorkspace(ws);
    if (publishResult) await destroyPublish(publishResult);
  }
}
