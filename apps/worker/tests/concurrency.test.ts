import { test, expect } from "bun:test";
import { sandboxMemory, workerConcurrency } from "../src/concurrency";

test("turns at once follow the machine's memory unless set; sandboxes split what's left", () => {
  // Auto (unset, or "auto"): about 1.5 GB a turn after Cloudly's own share, 1 to 4.
  expect(workerConcurrency(undefined, 1024)).toBe(1);
  expect(workerConcurrency("auto", 4096)).toBe(2);
  expect(workerConcurrency(undefined, 8192)).toBe(4);
  expect(workerConcurrency(undefined, 65536)).toBe(4);
  // A number is used as given.
  expect(workerConcurrency("1", 65536)).toBe(1);
  expect(workerConcurrency("6", 4096)).toBe(6);
  // Each sandbox gets an equal share, at least 512 MB; SANDBOX_MEMORY wins.
  expect(sandboxMemory(undefined, 4096, 2)).toBe("1664m");
  expect(sandboxMemory(undefined, 1024, 1)).toBe("512m");
  expect(sandboxMemory("3g", 4096, 2)).toBe("3g");
});
