import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexContext, findCodexRollout, findGeminiChat, geminiContext } from "../src/context-usage";

test("Codex's context fill comes from the latest token count in its session log", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-ctx-"));
  const dir = path.join(home, "sessions", "2026", "10", "14");
  await mkdir(dir, { recursive: true });
  const lines = [
    { type: "session_meta", payload: { id: "019-x" } },
    { type: "turn_context", payload: { model: "gpt-6-luna" } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 1000 }, model_context_window: 258400 } } },
    { type: "event_msg", payload: { type: "token_count", info: null } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 64600 }, model_context_window: 258400 } } },
  ];
  await writeFile(path.join(dir, "rollout-2026-10-14T04-39-35-019-x.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const rollout = findCodexRollout(["/nonexistent", home], "019-x");
  expect(rollout).toBeTruthy();
  expect(codexContext(rollout!)).toEqual({ model: "gpt-6-luna", tokens: 64600, max: 258400, percentage: 25 });
  expect(findCodexRollout([home], "other")).toBeNull();
});

test("Gemini's context fill comes from its latest reply's prompt size", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "gemini-ctx-"));
  const chats = path.join(home, ".gemini", "tmp", "abc123", "chats");
  await mkdir(chats, { recursive: true });
  const records = [
    { id: "1", type: "user", content: "hi" },
    { id: "2", type: "gemini", content: "", model: "gemini-3-flash-preview" },
    { id: "2", type: "gemini", content: "hello", model: "gemini-3-flash-preview", tokens: { input: 9000, output: 5, total: 9005 } },
    { id: "3", type: "gemini", content: "done", model: "gemini-3-flash-preview", tokens: { input: 104858, output: 40, total: 104898 } },
  ];
  await writeFile(path.join(chats, "session-2026-10-14T13-50-6e2ffac4.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const chat = findGeminiChat(home, "6e2ffac4-c890-4da0-9a40-3dff16c546b0");
  expect(chat).toBeTruthy();
  expect(geminiContext(chat!)).toEqual({ model: "gemini-3-flash-preview", tokens: 104858, max: 1048576, percentage: 10 });
  expect(findGeminiChat(home, "ffffffff-0000")).toBeNull();
});
