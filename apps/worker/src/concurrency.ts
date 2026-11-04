import { totalmem } from "node:os";

/** Memory kept for Postgres, the API, the worker and the web app, in MB. */
const RESERVED_MB = 768;
/** What one turn's sandbox gets to work comfortably, in MB. */
const PER_TURN_MB = 1536;

/**
 * How many turns run at once: WORKER_CONCURRENCY when it's a number, else
 * ("auto", or unset) as many as the machine's memory fits, up to 4, so a
 * council's members and other sessions don't wait in line.
 */
export function workerConcurrency(env = process.env.WORKER_CONCURRENCY, memMb = Math.floor(totalmem() / 1048576)): number {
  const n = Number(env);
  if (env && env !== "auto" && Number.isFinite(n)) return Math.max(1, Math.floor(n));
  return Math.max(1, Math.min(4, Math.floor((memMb - RESERVED_MB) / PER_TURN_MB)));
}

/** Each sandbox's memory cap: an equal share of what's left, so turns at once don't oversubscribe RAM. */
export function sandboxMemory(env = process.env.SANDBOX_MEMORY, memMb = Math.floor(totalmem() / 1048576), turns = workerConcurrency(undefined, memMb)): string {
  if (env) return env;
  return `${Math.max(512, Math.floor((memMb - RESERVED_MB) / Math.max(1, turns)))}m`;
}
