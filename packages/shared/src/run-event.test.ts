import { expect, test } from "bun:test";
import { lastReply } from "./run-event";

const ev = (kind: string, data: unknown) => ({ kind, data });

test("an ACP agent's reply is its fragments since the last tool call, across status events", () => {
  const r = lastReply(true);
  for (const e of [
    ev("text", "Looking."),
    ev("tool_call", { name: "shell" }),
    ev("raw", { thought: "Done." }),
    ev("text", "Added `median` to "),
    ev("status", { type: "acp.cost" }),
    ev("text", "`src/app.js`."),
    ev("done", {}),
  ])
    r.push(e);
  expect(r.text).toBe("Added `median` to `src/app.js`.");
});

test("Claude and Codex send whole messages: the last non-blank one is the reply", () => {
  const r = lastReply(false);
  for (const e of [ev("text", "First message."), ev("text", "Second message."), ev("text", "  ")]) r.push(e);
  expect(r.text).toBe("Second message.");
});

test("no reply at all", () => {
  const r = lastReply(true);
  r.push(ev("tool_call", {}));
  expect(r.text).toBeUndefined();
});
