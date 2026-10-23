import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
const repo = "acme/context-api";
let cookie = "";
let userId = "";

beforeAll(async () => {
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `ctx-api-${Date.now()}` } });
  userId = user.id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
  await prisma.contextEntry.deleteMany({ where: { repo } });
  await prisma.repoContext.deleteMany({ where: { repo } });
});

const web = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET") headers.set("origin", "https://cloudly.test");
  return api.fetch(new Request(`http://api.test${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }));
};

const rpc = (token: string | null, body: unknown) =>
  api.fetch(
    new Request("http://api.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  );

test("an editor connects with a token, reads a repo's context and adds to it; Cloudly sees it", async () => {
  const created = await (await web("/settings/tokens", { method: "POST", json: { name: "Cursor on laptop" } })).json();
  const token = created.token as string;
  // Listing never shows the token again.
  expect(await (await web("/settings/tokens")).text()).not.toContain(token);

  expect((await rpc(null, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status).toBe(401);
  // The session cookie isn't enough: editors use a token.
  expect((await api.fetch(new Request("http://api.test/mcp", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }))).status).toBe(401);

  const init = await (await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cursor", version: "1" } } })).json();
  expect(init.result.protocolVersion).toBe("2025-06-18");
  expect((await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  const tools = await (await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  expect(tools.result.tools.map((t: { name: string }) => t.name)).toEqual(["list_repos", "repo_context", "add_note", "record_work"]);

  // Off until the user turns it on for the repo.
  const refused = await (await rpc(token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "add_note", arguments: { repo, title: "x" } } })).json();
  expect(refused.result.isError).toBe(true);
  expect(refused.result.content[0].text).toContain("Shared context is off");

  expect((await web(`/context/${repo}`, { method: "PUT", json: { enabled: true, notes: "- Money is integer cents." } })).status).toBe(200);
  const batch = await (
    await rpc(token, [
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "add_note", arguments: { repo, title: "Use the fetch wrapper", kind: "decision" } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "record_work", arguments: { repo, title: "Refactored checkout", summary: "Split cart.ts in two." } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_repos", arguments: {} } },
    ])
  ).json();
  expect(batch).toHaveLength(3);
  expect(batch[2].result.content[0].text).toContain(repo);

  const read = await (await rpc(token, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "repo_context", arguments: { repo } } })).json();
  const md = read.result.content[0].text as string;
  expect(md).toContain("integer cents");
  expect(md).toContain("**Decision** (from Cursor on laptop)");
  expect(md).toContain("Refactored checkout");

  const view = await (await web(`/context/${repo}`)).json();
  expect(view.enabled).toBe(true);
  expect(view.entries.map((e: { title: string; source: string }) => [e.title, e.source])).toEqual([
    ["Refactored checkout", "mcp"],
    ["Use the fetch wrapper", "mcp"],
  ]);
  const exported = await web(`/context/${repo}/export`);
  expect(exported.headers.get("content-disposition")).toContain("CONTEXT.md");
  expect(await exported.text()).toContain("Refactored checkout");

  await web(`/context/${repo}/entries/${view.entries[0].id}`, { method: "DELETE" });
  expect((await (await web(`/context/${repo}`)).json()).entries).toHaveLength(1);

  // Revoked tokens stop working.
  await web(`/settings/tokens/${created.id}`, { method: "DELETE" });
  expect((await rpc(token, { jsonrpc: "2.0", id: 8, method: "tools/list" })).status).toBe(401);
  expect((await api.fetch(new Request("http://api.test/mcp"))).status).toBe(405);
});

test("Cloudly's own tool names can't be taken by an MCP server", async () => {
  const res = await web("/settings/mcp", { method: "POST", json: { name: "context", url: "https://x.example.com/mcp", auth: "none" } });
  expect(res.status).toBe(400);
});
