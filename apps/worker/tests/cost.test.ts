import { test, expect } from "bun:test";
import { costFromDoneEvent } from "../src/cost";

test("claude reports exact usd", () => {
  expect(costFromDoneEvent("native-claude", { kind: "done", data: { totalCostUsd: 0.42 } })).toEqual({
    usd: 0.42,
    estimated: false,
  });
});

test("codex estimates from token usage", () => {
  const cost = costFromDoneEvent("native-codex", {
    kind: "done",
    data: { type: "turn.completed", usage: { input_tokens: 1_000_000, output_tokens: 100_000 } },
  });
  expect(cost?.estimated).toBe(true);
  expect(cost?.usd).toBeCloseTo(1.25 + 1.0);
});

test("gemini estimates from acp quota meta", () => {
  const cost = costFromDoneEvent("gemini-acp", {
    kind: "done",
    data: { stopReason: "end_turn", _meta: { quota: { token_count: { input_tokens: 10431, output_tokens: 1 } } } },
  });
  expect(cost?.estimated).toBe(true);
  expect(cost!.usd).toBeGreaterThan(0);
});

test("non-done events and unknown harnesses cost nothing", () => {
  expect(costFromDoneEvent("native-claude", { kind: "text", data: "hi" })).toBeNull();
  expect(costFromDoneEvent("mystery", { kind: "done", data: {} })).toBeNull();
});
