import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionsIndex } from "@repo/shared/sessions";

const S1 = "11111111-aaaa-4aaa-8aaa-000000000001";
const S2 = "22222222-bbbb-4bbb-8bbb-000000000002";
const S3 = "22222299-cccc-4ccc-8ccc-000000000003";
let dir = "";
let handle: (m: Record<string, any>) => Promise<Record<string, any> | null>;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const out = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { text: out!.result.content[0].text as string, error: Boolean(out!.result.isError) };
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sessions-mcp-"));
  process.env.CLOUDLY_SESSIONS_DIR = dir;
  const index: SessionsIndex = {
    self: { id: "99999999-dddd-4ddd-8ddd-000000000009", title: "Add the invoices API" },
    scope: "repo",
    canSend: 2,
    sessions: [S1, S2, S3].map((id, i) => ({
      id, title: `Session ${i + 1}`, repo: "acme/app", branch: `agent/thread-${i}`, agent: "Codex", status: "succeeded",
      prUrl: i === 0 ? "https://github.com/acme/app/pull/7" : null, updatedAt: "2026-11-01T00:00:00.000Z", turns: 2,
    })),
  };
  await writeFile(path.join(dir, "index.json"), JSON.stringify(index));
  await writeFile(path.join(dir, `${S1}.md`), "# Session 1\n\nUser: build it\n\nAgent: built");
  await writeFile(path.join(dir, "outbox.jsonl"), "");
  ({ handle } = await import("./sessions-mcp"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("lists the sessions it was given and reads one's conversation", async () => {
  const list = await call("list_sessions");
  expect(list.text).toContain(`You are in "Add the invoices API"`);
  expect(list.text).toContain(`- ${S1}: "Session 1" · Codex · acme/app on agent/thread-0 · succeeded · https://github.com/acme/app/pull/7`);
  expect((await call("read_session", { id: S1 })).text).toContain("Agent: built");
  // Only ids from the list: never a path.
  expect(await call("read_session", { id: "../index" })).toMatchObject({ error: true });
});

test("sends one message per session, within the turn's allowance, to the outbox", async () => {
  const first = await call("send_to_session", { id: S1, message: "Does it handle time zones?", reply: true });
  expect(first.error).toBe(false);
  expect(first.text).toContain("comes back to this session");
  expect((await call("send_to_session", { id: S1, message: "again" })).text).toContain("already sent");
  expect((await call("send_to_session", { id: S2, message: "FYI" })).error).toBe(false);
  // canSend was 2.
  expect((await call("send_to_session", { id: S3, message: "one too many" })).text).toContain("as many messages as one turn may send");
  expect((await call("send_to_session", { id: "nope", message: "x" })).error).toBe(true);

  const lines = (await readFile(path.join(dir, "outbox.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toEqual([
    { to: S1, message: "Does it handle time zones?", replyWanted: true },
    { to: S2, message: "FYI", replyWanted: false },
  ]);
});

test("a session can be named by its link, a copied reference, the start of its id, or its title", async () => {
  const { findSession } = await import("./sessions-mcp");
  const idx = JSON.parse(await Bun.file(path.join(dir, "index.json")).text());
  expect(findSession(idx, `https://cloudly.example/app/s/${S1}`).session?.id).toBe(S1);
  expect(findSession(idx, `Cloudly session "Session 1" (id ${S1}) on acme/app, branch agent/thread-0`).session?.id).toBe(S1);
  expect(findSession(idx, "11111111").session?.id).toBe(S1);
  expect(findSession(idx, "session 2").session?.id).toBe(S2);
  // Too short a prefix to be sure, and one that fits two sessions.
  expect(findSession(idx, "2222").problem).toContain("No session matching");
  expect(findSession(idx, "222222").problem).toContain("matches 2 sessions");
  expect(findSession(idx, "99999999-dddd-4ddd-8ddd-000000000009").problem).toBe("That's this session.");
  // Not one it can see: says how the user can widen what it sees.
  expect(findSession(idx, "https://cloudly.example/app/s/44444444-eeee-4eee-8eee-000000000004").problem).toContain("All your sessions");
});
