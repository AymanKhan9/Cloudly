import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let dir = "";
let handle: (m: Record<string, any>) => Promise<Record<string, any> | null>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ask-mcp-"));
  process.env.CLOUDLY_ASK_DIR = dir;
  ({ handle } = await import("./ask-mcp"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const call = async (args: Record<string, unknown>) => (await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_user", arguments: args } }))!.result;

test("ask_user leaves the question for the worker and tells the agent to end its turn", async () => {
  const out = await call({ question: "  UTC or local?  " });
  expect(out.isError).toBeUndefined();
  expect(out.content[0].text).toContain("Finish this turn now");
  expect(JSON.parse(await readFile(path.join(dir, "question.json"), "utf8"))).toEqual({ question: "UTC or local?" });
  expect((await call({ question: "" })).isError).toBe(true);
  const tools = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }))!.result.tools;
  expect(tools[0].description).toContain("Never ask for permission");
});
