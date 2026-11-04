import { claimRun } from "./claim";
import type { Run } from "@repo/shared/run";
import { pause } from "./pause";

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
      await pause(POLL_INTERVAL_MS, signal);
      continue;
    }

    const run = await claimRun(workerId);

    if (!run) {
      await pause(POLL_INTERVAL_MS, signal);
      continue;
    }

    active++;
    processRun(run)
      .catch((err) => console.error(`run ${run.id} failed:`, err))
      .finally(() => {
        active--;
      });
  }
  // Stopping: the turns already running finish first.
  while (active > 0) await Bun.sleep(500);
}
