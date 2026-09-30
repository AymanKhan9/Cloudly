import { prisma } from "@repo/db";
import { RunSchema, type Run } from "@repo/shared/run";
import { removeContainer } from "./docker";

export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Reclaims one running/finalizing run whose lease has expired and hasn't
 * exhausted its attempts — the recovery-sweep equivalent of claimRun.
 * Bumps leaseGen (fencing) and attempts (retry budget) atomically.
 */
export async function reclaimExpiredRun(
  workerId: string,
  leaseSeconds = 60,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<Run | null> {
  const rows = await prisma.$queryRaw<unknown[]>`
    UPDATE "Run"
    SET status = 'running',
        "workerId" = ${workerId},
        "leaseUntil" = now() + make_interval(secs => ${leaseSeconds}),
        "leaseGen" = "leaseGen" + 1,
        "attempts" = "attempts" + 1
    WHERE id = (
      SELECT id FROM "Run"
      WHERE status IN ('running', 'finalizing')
        AND "leaseUntil" < now()
        AND attempts < ${maxAttempts}
      ORDER BY "createdAt"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `;

  if (rows.length === 0) return null;
  return RunSchema.parse(rows[0]);
}

/**
 * Permanently fails runs that have exhausted their retry budget — otherwise
 * a run that reliably crashes its worker would requeue forever.
 */
export async function failExhaustedRuns(
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<number> {
  const result = await prisma.run.updateMany({
    where: {
      status: { in: ["running", "finalizing"] },
      leaseUntil: { lt: new Date() },
      attempts: { gte: maxAttempts },
    },
    data: {
      status: "failed",
      error: "exceeded max recovery attempts after repeated lease expiry",
    },
  });
  return result.count;
}

/**
 * Cleans up before a reclaimed run is redone from scratch: removes any
 * leftover container and clears the dead attempt's partial event log, so
 * the retry produces a clean, contiguous seq sequence instead of colliding
 * with stale rows from the crashed attempt.
 */
export async function prepareReclaimedRun(run: Run): Promise<void> {
  await removeContainer(run.id);
  await prisma.runEvent.deleteMany({ where: { runId: run.id } });
}

const RECOVERY_INTERVAL_MS = 30_000;

export async function runRecoverySweepLoop(
  workerId: string,
  maxConcurrency: number,
  processRun: (run: Run) => Promise<void>,
  signal: AbortSignal,
  intervalMs = RECOVERY_INTERVAL_MS,
): Promise<void> {
  let active = 0;

  while (!signal.aborted) {
    await failExhaustedRuns();

    if (active >= maxConcurrency) {
      await sleep(intervalMs);
      continue;
    }

    const run = await reclaimExpiredRun(workerId);

    if (!run) {
      await sleep(intervalMs);
      continue;
    }

    await prepareReclaimedRun(run);

    active++;
    processRun(run)
      .catch((err) => console.error(`recovery: run ${run.id} failed:`, err))
      .finally(() => {
        active--;
      });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
