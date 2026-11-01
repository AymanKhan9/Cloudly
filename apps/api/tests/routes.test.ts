import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
const ORIGIN = "https://cloudly.test";
let cookie = "";
let userId = "";

beforeAll(async () => {
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `api-test-${Date.now()}` } });
  userId = user.id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
  await prisma.envSecret.deleteMany({ where: { name: { startsWith: "API_T_" } } });
  await prisma.repoFile.deleteMany({ where: { repo: "acme/api-test" } });
  await prisma.mcpServer.deleteMany({ where: { name: { startsWith: "api-t-" } } });
});

function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
  return api.fetch(new Request(`http://api.test${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }));
}

test("writes from another origin (a preview's port, say) are refused", async () => {
  const res = await call("/runs/x/cancel", { method: "POST", headers: { origin: "https://cloudly.test:8443" } });
  expect(res.status).toBe(403);
  expect((await call("/budget")).status).toBe(200);
});

test("an arena makes one session per agent, none opening a PR until one is picked", async () => {
  const res = await call("/arenas", {
    method: "POST",
    json: { repo: "acme/arena", baseBranch: "main", prompt: "Fix the bug", harnesses: ["native-claude", "gemini-acp"] },
  });
  expect(res.status).toBe(201);
  const { id } = await res.json();
  const view = await (await call(`/arenas/${id}`)).json();
  expect(view.entries).toHaveLength(2);
  expect(view.entries.map((e: { thread: { harness: string; autoPr: boolean } }) => [e.thread.harness, e.thread.autoPr])).toEqual([
    ["native-claude", false],
    ["gemini-acp", false],
  ]);
  expect(view.entries[0].result.status).toBe("queued");

  // Nothing pushed yet: nothing to pick.
  const pick = await call(`/arenas/${id}/pick`, { method: "POST", json: { threadId: view.entries[0].thread.id } });
  expect(pick.status).toBe(409);
  expect((await call("/arenas", { method: "POST", json: { repo: "acme/arena", baseBranch: "main", prompt: "x", harnesses: ["gemini-acp", "gemini-acp"] } })).status).toBe(400);
});

test("secrets: no reserved names, and a hidden one needs hosts", async () => {
  expect((await call("/settings/env", { method: "PUT", json: { name: "HTTPS_PROXY", repo: "*", value: "x", hosts: "a.com" } })).status).toBe(400);
  expect((await call("/settings/env", { method: "PUT", json: { name: "API_T_TOKEN", repo: "*", value: "x" } })).status).toBe(400);
  const ok = await call("/settings/env", { method: "PUT", json: { name: "API_T_TOKEN", repo: "*", value: "secret-value-1234", hosts: "api.example.com" } });
  expect(ok.status).toBe(200);
  const body = await ok.text();
  expect(body).not.toContain("secret-value");
  expect(body).toContain("…1234");
});

test("files: upload, list, download as an attachment, delete; no paths outside the folder", async () => {
  const up = await call("/files/acme/api-test?path=data/x.html", { method: "PUT", body: "<script>alert(1)</script>" });
  expect(up.status).toBe(200);
  expect((await up.json()).files.map((f: { path: string }) => f.path)).toEqual(["data/x.html"]);
  const dl = await call("/files/acme/api-test/content?path=data/x.html");
  expect(dl.headers.get("content-type")).toBe("application/octet-stream");
  expect(dl.headers.get("content-disposition")).toStartWith("attachment");
  expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await dl.text()).toBe("<script>alert(1)</script>");
  expect((await call("/files/acme/api-test?path=../../etc/passwd", { method: "PUT", body: "x" })).status).toBe(400);
  const del = await call("/files/acme/api-test?path=data", { method: "DELETE" });
  expect((await del.json()).files).toEqual([]);
});

test("MCP servers: a token server is connected at once, and its token never comes back", async () => {
  const add = await call("/settings/mcp", { method: "POST", json: { name: "api-t-tools", url: "https://tools.example.com/mcp", auth: "bearer", token: "tok-secret-value" } });
  expect(add.status).toBe(201);
  const list = await call("/settings/mcp");
  const text = await list.text();
  expect(text).not.toContain("tok-secret-value");
  expect(JSON.parse(text).servers.find((s: { name: string }) => s.name === "api-t-tools").status).toBe("connected");
  expect((await call("/settings/mcp", { method: "POST", json: { name: "Bad Name", url: "https://x.com", auth: "none" } })).status).toBe(400);
  expect((await call("/settings/mcp", { method: "POST", json: { name: "api-t-tools", url: "https://x.com", auth: "none" } })).status).toBe(409);
});

test("desktop and previews hand out relay links only for the owner's live containers", async () => {
  const thread = await prisma.thread.create({ data: { userId, repo: "acme/live", baseBranch: "main", harness: "native-claude", title: "t", branch: "agent/live", desktop: true } });
  expect((await call(`/threads/${thread.id}/desktop`)).status).toBe(404);
  const run = await prisma.run.create({
    data: { userId, threadId: thread.id, repo: "acme/live", baseBranch: "main", prompt: "x", harness: "native-claude", status: "running", desktopPassword: "pw123456" },
  });
  const desktop = await (await call(`/threads/${thread.id}/desktop`)).json();
  expect(desktop.password).toBe("pw123456");
  expect(desktop.url).toStartWith("/relay/desktop?t=");
  // The thread view says a desktop is there, without the password.
  const view = await (await call(`/threads/${thread.id}`)).text();
  expect(view).toContain('"desktop":true');
  expect(view).not.toContain("pw123456");

  delete process.env.PREVIEW_ORIGIN;
  const noOrigin = await call(`/threads/${thread.id}/previews`, { method: "POST", json: { command: "npm run dev", port: 3000 } });
  expect(noOrigin.status).toBe(400);
  process.env.PREVIEW_ORIGIN = "https://cloudly.test:8443";
  await prisma.preview.updateMany({ where: { status: { in: ["requested", "starting", "running", "stopping"] } }, data: { status: "stopped" } });
  const started = await call(`/threads/${thread.id}/previews`, { method: "POST", json: { command: "npm run dev", port: 3000 } });
  expect(started.status).toBe(201);
  const { preview } = await started.json();
  expect((await call(`/threads/${thread.id}/previews`, { method: "POST", json: { command: "x", port: 3000 } })).status).toBe(409);
  expect((await call(`/previews/${preview.id}/link`)).status).toBe(409);
  await prisma.preview.update({ where: { id: preview.id }, data: { status: "running", expiresAt: new Date(Date.now() + 600_000) } });
  const link = await (await call(`/previews/${preview.id}/link`)).json();
  expect(link.url).toStartWith("https://cloudly.test:8443/__cloudly/enter?t=");
  await call(`/previews/${preview.id}/stop`, { method: "POST" });
  expect((await prisma.preview.findUniqueOrThrow({ where: { id: preview.id } })).status).toBe("stopping");
  await prisma.run.delete({ where: { id: run.id } });
});

test("a session's scope for other sessions can be changed, and a turn shows the session it came from", async () => {
  const mk = (title: string) =>
    prisma.thread.create({ data: { userId, repo: "acme/peers", baseBranch: "main", harness: "native-claude", title, branch: `b-${title}` } });
  const asker = await mk("Asker");
  const target = await mk("Target");
  await prisma.run.create({
    data: { status: "queued", repo: "acme/peers", baseBranch: "main", prompt: "A message from another session", harness: "native-claude", userId, threadId: target.id, fromThreadId: asker.id, hops: 1, replyToThreadId: asker.id },
  });

  const view = await (await call(`/threads/${target.id}`)).json();
  expect(view.thread.peers).toBe("repo");
  expect(view.turns[0]).toMatchObject({ from: { threadId: asker.id, title: "Asker" }, replyToThreadId: asker.id, hops: 1 });

  expect((await call(`/threads/${target.id}`, { method: "PATCH", json: { peers: "all" } })).status).toBe(200);
  expect((await prisma.thread.findUnique({ where: { id: target.id } }))!.peers).toBe("all");
  expect((await call(`/threads/${target.id}`, { method: "PATCH", json: { peers: "everyone" } })).status).toBe(400);
});

test("sidebar state: pin, settle, snooze, archive, rename, read and unread, and delete", async () => {
  const t = await prisma.thread.create({ data: { userId, repo: "acme/sidebar", baseBranch: "main", harness: "native-claude", title: "Sidebar", branch: "b-sidebar" } });
  const row = async () => ((await (await call("/threads")).json()).threads as any[]).find((x) => x.id === t.id);

  // A turn that ended after the user last looked is unread; looking reads it.
  const run = await prisma.run.create({ data: { status: "succeeded", repo: t.repo, baseBranch: "main", prompt: "x", harness: t.harness, userId, threadId: t.id } });
  expect(await row()).toMatchObject({ unread: true, lastStatus: "succeeded" });
  await call(`/threads/${t.id}`, { method: "PATCH", json: { seen: true } });
  expect((await row()).unread).toBe(false);
  await call(`/threads/${t.id}`, { method: "PATCH", json: { seen: false } });
  expect((await row()).unread).toBe(true);

  await call(`/threads/${t.id}`, { method: "PATCH", json: { pinned: true, settled: true, title: "Renamed", seen: true } });
  expect(await row()).toMatchObject({ title: "Renamed", unread: false });
  expect((await row()).pinnedAt).not.toBeNull();
  expect((await row()).settledAt).not.toBeNull();

  // Snoozed until later: hidden; once the time passes, back as unread.
  const later = new Date(Date.now() + 3_600_000).toISOString();
  await call(`/threads/${t.id}`, { method: "PATCH", json: { snoozeUntil: later } });
  expect(await row()).toMatchObject({ snoozed: true, unread: false });
  await prisma.thread.update({ where: { id: t.id }, data: { snoozedUntil: new Date(Date.now() - 1000), seenAt: new Date(Date.now() - 5000) } });
  expect(await row()).toMatchObject({ snoozed: false, unread: true });

  // A new message brings it back from settled, snoozed and archived, and answers the agent's question.
  await call(`/threads/${t.id}`, { method: "PATCH", json: { archived: true, snoozeUntil: later } });
  await prisma.thread.update({ where: { id: t.id }, data: { needsInput: "Which date format?" } });
  expect((await call(`/threads/${t.id}/messages`, { method: "POST", json: { prompt: "ISO 8601" } })).status).toBe(201);
  const after = await prisma.thread.findUnique({ where: { id: t.id } });
  expect(after).toMatchObject({ settledAt: null, snoozedUntil: null, archivedAt: null, needsInput: null });

  // Not while a turn runs; then gone, turns and all.
  expect((await call(`/threads/${t.id}`, { method: "DELETE" })).status).toBe(409);
  await prisma.run.updateMany({ where: { threadId: t.id }, data: { status: "cancelled" } });
  expect((await call(`/threads/${t.id}`, { method: "DELETE" })).status).toBe(204);
  expect(await prisma.run.findUnique({ where: { id: run.id } })).toBeNull();
  expect((await call(`/threads/${t.id}`, { method: "DELETE" })).status).toBe(404);
});
