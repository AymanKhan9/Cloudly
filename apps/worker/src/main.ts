import { hostname } from "node:os";
import { processRun } from "./process-run";
import { runPollLoop } from "./poll";
import { runRecoverySweepLoop } from "./recovery";

const workerId = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;
// ponytail: poll and recovery each cap at this, so the true ceiling is 2x; share one counter if that matters.
const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1));

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[worker] ${signal}: no new runs will be claimed`);
    controller.abort();
  });
}

console.log(`[worker] ${workerId} up, concurrency ${concurrency}`);
const run = (r: Parameters<typeof processRun>[0]) => processRun(r, workerId);
await Promise.all([
  runPollLoop(workerId, concurrency, run, controller.signal),
  runRecoverySweepLoop(workerId, concurrency, run, controller.signal),
]);
