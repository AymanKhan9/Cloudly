import { test, expect, beforeAll } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "context-mcp-"));
  process.env.CLOUDLY_CONTEXT_DIR = dir;
  await writeFile(path.join(dir, "context.md"), "# Shared context for acme/x\n\n- use cents");
});

test("an agent reads the shared context and adds notes, up to a limit", async () => {
  const { handle } = await import("./context-mcp");
  const call = (name: string, args: object) => handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  expect((await call("repo_context", {}))?.result.content[0].text).toContain("use cents");
  expect((await call("add_note", { title: "" }))?.result.isError).toBe(true);
  expect((await call("add_note", { title: "Tests need TZ=UTC", text: "Dates break otherwise.", kind: "decision" }))?.result.isError).toBeUndefined();
  const lines = (await readFile(path.join(dir, "new-notes.jsonl"), "utf8")).trim().split("\n");
  expect(JSON.parse(lines[0]!)).toEqual({ kind: "decision", title: "Tests need TZ=UTC", text: "Dates break otherwise." });
  for (let i = 0; i < 25; i++) await call("add_note", { title: `n${i}` });
  expect((await readFile(path.join(dir, "new-notes.jsonl"), "utf8")).trim().split("\n")).toHaveLength(20);
  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect(list?.result.tools.map((t: { name: string }) => t.name)).toEqual(["repo_context", "add_note"]);
});
