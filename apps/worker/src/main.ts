import { hostname } from "node:os";
import { processRun } from "./process-run";
import { runPollLoop } from "./poll";
import { runRecoverySweepLoop } from "./recovery";
import { runSandboxImageLoop } from "./sandbox-image";
import { ensureEgress } from "./egress";

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

// Recreated on start so an upgraded proxy script takes effect.
await ensureEgress(true).catch((err) => console.error("[worker] egress proxy:", err));
console.log(`[worker] ${workerId} up, concurrency ${concurrency}`);
const run = (r: Parameters<typeof processRun>[0]) => processRun(r, workerId);
await Promise.all([
  runPollLoop(workerId, concurrency, run, controller.signal),
  runRecoverySweepLoop(workerId, concurrency, run, controller.signal),
  runSandboxImageLoop(controller.signal),
]);
