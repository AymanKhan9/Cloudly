import { test, expect, beforeAll, afterAll } from "bun:test";
import { gzipSync } from "node:zlib";
import { prisma, createAccessToken, unseal } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
let cookie = "";
let userId = "";

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `imp-api-${Date.now()}` } })).id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
});

const call = (path: string, init: RequestInit & { json?: unknown; bearer?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  else headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return api.fetch(new Request(`http://api.test${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }));
};

const claudeFile = [
  { type: "user", uuid: "u1", parentUuid: null, sessionId: "11111111-2222-4333-8444-555555555555", cwd: "/Users/me/shop", gitBranch: "cart", message: { role: "user", content: "Add a cart page" } },
  { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: "11111111-2222-4333-8444-555555555555", cwd: "/Users/me/shop", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Write", input: { file_path: "/Users/me/shop/cart.tsx" } }, { type: "text", text: "Added the cart page." }] } },
  { type: "user", uuid: "u2", parentUuid: "a1", sessionId: "11111111-2222-4333-8444-555555555555", cwd: "/Users/me/shop", message: { role: "user", content: "Now the checkout button" } },
].map((l) => JSON.stringify(l)).join("\n");

test("import: preview, then a session whose first turns are the conversation", async () => {
  const file = { name: "1111.jsonl", content: claudeFile };
  const preview = await (await call("/imports", { method: "POST", json: { file, preview: true } })).json();
  expect(preview.preview).toMatchObject({ source: "claude-code", sourceName: "Claude Code", sourceHarness: "native-claude", turns: 2, canResume: true, gitBranch: "cart", cwd: "/Users/me/shop", toolCalls: 1 });

  // No repo in a Claude file: it has to be chosen.
  expect((await (await call("/imports", { method: "POST", json: { file } })).json()).message).toContain("Which repository");

  const res = await call("/imports", { method: "POST", json: { file: { name: file.name, gzip: gzipSync(claudeFile).toString("base64") }, repo: "acme/shop", baseBranch: "main", startFrom: "cart", prompt: "Carry on" } });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body).toMatchObject({ harness: "native-claude", branch: `agent/import-${body.id.slice(0, 8)}` });

  const view = await (await call(`/threads/${body.id}`)).json();
  expect(view.thread).toMatchObject({ title: "Add a cart page", harness: "native-claude", imported: { source: "claude-code", turns: 2, dropped: 0, resumed: false, startFrom: "cart" } });
  expect(view.turns.map((t: any) => [t.kind, t.status, t.prompt])).toEqual([
    ["import_turn", "succeeded", "Add a cart page"],
    ["import_turn", "succeeded", "Now the checkout button"],
    ["import", "queued", "Import from Claude Code"],
    ["turn", "queued", "Carry on"],
  ]);
  const events = await prisma.runEvent.findMany({ where: { runId: view.turns[0].id }, orderBy: { seq: "asc" } });
  expect(events.map((e) => [e.kind, e.data])).toEqual([["tool_call", { title: "Write /Users/me/shop/cart.tsx", imported: true }], ["text", "Added the cart page."]]);
  // The original file is kept, sealed, for Claude Code to resume.
  const imp = await prisma.sessionImport.findUniqueOrThrow({ where: { threadId: body.id } });
  expect(imp.file).not.toContain("cart");
  expect(imp.sessionId).toBe("11111111-2222-4333-8444-555555555555");
  expect(await unseal(imp.file!)).toBeTruthy();

  // Rewinding to an imported turn before the last isn't possible: there's no code for it.
  await prisma.run.updateMany({ where: { threadId: body.id }, data: { status: "succeeded" } });
  const early = await call(`/threads/${body.id}/rewind`, { method: "POST", json: { runId: view.turns[0].id } });
  expect((await early.json()).message).toContain("last imported turn");
});

test("import with a personal token (the import command), and the command itself", async () => {
  const { token } = await createAccessToken(userId, "laptop");
  const chat = JSON.stringify({ messages: [{ role: "user", content: "Explain the queue" }, { role: "assistant", content: "It uses SKIP LOCKED." }] });
  const res = await call("/imports", { method: "POST", bearer: token, json: { file: { name: "chat.json", content: chat }, repo: "acme/q", harness: "native-codex" } });
  expect(res.status).toBe(201);
  const { id, harness } = await res.json();
  expect(harness).toBe("native-codex");
  const thread = await prisma.thread.findUniqueOrThrow({ where: { id }, include: { imported: true } });
  expect(thread.userId).toBe(userId);
  expect(thread.imported).toMatchObject({ source: "chat", file: null });

  expect((await call("/imports", { method: "POST", bearer: "cly_wrong", json: { file: { name: "c.json", content: chat }, repo: "acme/q" } })).status).toBe(401);
  expect((await call("/imports", { method: "POST", json: { file: { name: "x.jsonl", content: '{"a":1}\n{"b":2}' }, repo: "acme/q" } })).status).toBe(400);

  const script = await (await api.fetch(new Request("http://api.test/import.mjs"))).text();
  expect(script).toContain('const BAKED_URL = "https://cloudly.test"');
  expect(script).toContain("cloudly/import-");
});
