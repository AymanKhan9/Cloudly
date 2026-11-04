import { test, expect } from "bun:test";
import { pause } from "../src/pause";
import { runPollLoop } from "../src/poll";

test("a loop's wait ends as soon as the worker is stopping", async () => {
  const stop = new AbortController();
  const started = Date.now();
  setTimeout(() => stop.abort(), 50);
  await pause(3_600_000, stop.signal);
  expect(Date.now() - started).toBeLessThan(1000);
  // Already stopping: no wait at all.
  const t = Date.now();
  await pause(60_000, stop.signal);
  expect(Date.now() - t).toBeLessThan(50);
});

test("stopping the poll loop returns promptly when nothing is running", async () => {
  const stop = new AbortController();
  const started = Date.now();
  const loop = runPollLoop("pause-test-worker", 0, async () => {}, stop.signal);
  setTimeout(() => stop.abort(), 100);
  await loop;
  expect(Date.now() - started).toBeLessThan(2000);
});
