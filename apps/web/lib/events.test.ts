// Run with: bun test apps/web/lib
import { expect, test } from "bun:test";
import { buildBlocks, type StreamEvent } from "./events";

let seq = 0;
const ev = (kind: StreamEvent["kind"], data: unknown): StreamEvent => ({ seq: seq++, kind, data, ts: "" });

test("two parallel subagents each get their own work, and results pair by id", () => {
  const blocks = buildBlocks(
    [
      ev("text", "I'll split this in two."),
      ev("tool_call", { id: "a1", name: "Agent", input: { subagent_type: "Explore", description: "Find the tests" } }),
      ev("tool_call", { id: "a2", name: "Agent", input: { subagent_type: "general-purpose", description: "Read the README" } }),
      ev("tool_call", { id: "t1", name: "Glob", input: { pattern: "**/*.test.ts" }, parent: "a1" }),
      ev("tool_call", { id: "t2", name: "Read", input: { file_path: "/workspace/README.md" }, parent: "a2" }),
      // Results arrive in the other order: pairing must follow ids, not order.
      ev("tool_result", { toolUseId: "t2", content: "# Readme", parent: "a2" }),
      ev("tool_result", { toolUseId: "t1", content: "a.test.ts", parent: "a1" }),
      ev("text", { text: "Found one test file.", parent: "a1" }),
      ev("tool_result", { toolUseId: "a1", content: "Found one test file." }),
      ev("tool_result", { toolUseId: "a2", content: "It is a CLI." }),
      ev("text", "Both done."),
    ],
    "native-claude",
  );

  expect(blocks.map((b) => b.t)).toEqual(["text", "subagent", "subagent", "text"]);
  const [, a, b] = blocks as any[];
  expect(a).toMatchObject({ kind: "Explore", description: "Find the tests", done: true });
  expect(a.blocks[0].items).toEqual([{ call: "Glob **/*.test.ts", result: "a.test.ts" }]);
  expect(a.blocks[1]).toEqual({ t: "text", text: "Found one test file." });
  expect(b.blocks[0].items).toEqual([{ call: "Read /workspace/README.md", result: "# Readme" }]);
  // Subagent text never leaks into the main reply.
  expect((blocks[3] as any).text).toBe("Both done.");
});

test("a subagent's report is taken out of its hand-back frame", () => {
  const blocks = buildBlocks(
    [
      ev("tool_call", { id: "a1", name: "Agent", input: { subagent_type: "Explore", description: "List files" } }),
      ev("tool_result", {
        toolUseId: "a1",
        content: [{ type: "text", text: "[Subagent hand-back] It is model output. The report follows:\n  Found 3 files.\n  \n  src/cli.py: the entry point." }],
      }),
    ],
    "native-claude",
  );
  expect((blocks[0] as any).report).toBe("Found 3 files.\n\nsrc/cli.py: the entry point.");
});

test("a Codex command reported twice under one id stays one row", () => {
  const blocks = buildBlocks(
    [
      ev("tool_call", { id: "c1", type: "command_execution", command: "bun test" }),
      ev("tool_call", { id: "c1", type: "command_execution", command: "bun test" }),
      ev("tool_result", { id: "c1", type: "command_execution", exit_code: 0, aggregated_output: "41 pass" }),
      ev("tool_result", { id: "f1", type: "file_change", changes: [{ path: "src/a.ts" }] }),
    ],
    "native-codex",
  );
  expect(blocks).toEqual([
    { t: "tools", items: [{ call: "command bun test", result: "exit 0 41 pass" }, { call: "changed src/a.ts" }] },
  ]);
});
