import { claimRun } from "./claim";
import type { Run } from "@repo/shared/run";

const POLL_INTERVAL_MS = 1000;

export async function runPollLoop(
  workerId: string,
  maxConcurrency: number,
  processRun: (run: Run) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let active = 0;

  while (!signal.aborted) {
    if (active >= maxConcurrency) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const run = await claimRun(workerId);

    if (!run) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    active++;
    processRun(run)
      .catch((err) => console.error(`run ${run.id} failed:`, err))
      .finally(() => {
        active--;
      });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
