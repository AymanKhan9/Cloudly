import { test, expect } from "bun:test";
import { modelCommand } from "../src/model-command";

test("/model <name> sets, /model default clears, anything else isn't a model choice", () => {
  expect(modelCommand("/model sonnet")).toBe("sonnet");
  expect(modelCommand("  /model opus[1m] ")).toBe("opus[1m]");
  expect(modelCommand("/model default")).toBeNull();
  expect(modelCommand("/model")).toBeUndefined();
  expect(modelCommand("/model sonnet and fix the bug")).toBeUndefined();
  expect(modelCommand("use the sonnet model")).toBeUndefined();
});
