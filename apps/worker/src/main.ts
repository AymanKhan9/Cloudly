import { hostname } from "node:os";
import { processRun } from "./process-run";
import { runPollLoop } from "./poll";
import { runRecoverySweepLoop } from "./recovery";
import { runSandboxImageLoop } from "./sandbox-image";
import { ensureEgress, runMcpRefreshLoop } from "./egress";
import { ensureRelay, runPreviewLoop } from "./previews";
import { runCouncilLoop } from "./council";
import { runWebhookLoop } from "./webhooks";
import { runMergeLoop } from "./merge";
import { runScheduleLoop } from "./schedules";
import { runNotifyLoop } from "./notify";
import { runAgentUpdateLoop } from "./agent-updates";
import { runPlanLoop } from "./plans";
import { runHandoffLoop } from "./handoff";
import { runLessonsLoop } from "./lessons";
import { runTrialLoop } from "./trials";
import { workerConcurrency } from "./concurrency";

const workerId = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;
// ponytail: poll and recovery each cap at this, so the true ceiling is 2x; share one counter if that matters.
const concurrency = workerConcurrency();

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[worker] ${signal}: no new runs will be claimed`);
    controller.abort();
  });
}

// Recreated on start so an upgraded proxy script takes effect.
await ensureEgress(true).catch((err) => console.error("[worker] egress proxy:", err));
// Recreated on start too: the relay is how desktops and previews are reached.
await ensureRelay(true).catch((err) => console.error("[worker] relay:", err));
console.log(`[worker] ${workerId} up, concurrency ${concurrency}`);
const run = (r: Parameters<typeof processRun>[0]) => processRun(r, workerId);
await Promise.all([
  runPollLoop(workerId, concurrency, run, controller.signal),
  runRecoverySweepLoop(workerId, concurrency, run, controller.signal),
  runSandboxImageLoop(controller.signal),
  runMcpRefreshLoop(controller.signal),
  runPreviewLoop(workerId, controller.signal),
  runCouncilLoop(controller.signal),
  runWebhookLoop(controller.signal),
  runMergeLoop(controller.signal),
  runScheduleLoop(controller.signal),
  runNotifyLoop(controller.signal),
  runAgentUpdateLoop(controller.signal),
  runPlanLoop(controller.signal),
  runHandoffLoop(controller.signal),
  runLessonsLoop(controller.signal),
  runTrialLoop(controller.signal),
]);
// Every loop has stopped and the turns that were running have finished.
console.log("[worker] stopped");
process.exit(0);
