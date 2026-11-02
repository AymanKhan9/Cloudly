import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
let cookie = "";
let userId = "";
beforeAll(async () => {
  userId = (await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `plans-api-${Date.now()}` } })).id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
});
const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET") headers.set("origin", "https://cloudly.test");
  return api.fetch(new Request(`http://api.test${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }));
};

test("a plan is planned, looked over and edited, started, and its stuck tasks skipped", async () => {
  expect((await call("/plans", { method: "POST", json: { repo: "acme/app", baseBranch: "main", goal: "Do it", planner: "acp-nope" } })).status).toBe(400);
  const r = await call("/plans", { method: "POST", json: { repo: "acme/app", baseBranch: "main", goal: "Add multi-currency billing", planner: "native-claude", harness: "native-codex" } });
  expect(r.status).toBe(201);
  const id = (await r.json()).id;
  let view = await (await call(`/plans/${id}`)).json();
  expect(view.plan).toMatchObject({ status: "planning", harness: "native-codex", maxParallel: 3, autoMerge: true });
  expect(view.planner).toMatchObject({ status: "queued", harness: "native-claude" });
  expect((await call(`/plans/${id}/start`, { method: "POST", json: {} })).status).toBe(409);

  // The planner's done (the worker would do this).
  await prisma.plan.update({ where: { id }, data: { status: "ready" } });
  const tasks = [{ key: "schema", title: "Schema", prompt: "a" }, { key: "api", title: "API", prompt: "b", dependsOn: ["schema"] }];
  expect((await call(`/plans/${id}/tasks`, { method: "PUT", json: { tasks: [{ key: "a", title: "A", prompt: "a", dependsOn: ["a"] }] } })).status).toBe(400);
  expect((await call(`/plans/${id}/tasks`, { method: "PUT", json: { tasks } })).status).toBe(200);
  view = await (await call(`/plans/${id}`)).json();
  expect(view.tasks.map((t: any) => [t.key, t.dependsOn])).toEqual([["schema", []], ["api", ["schema"]]]);

  expect((await call(`/plans/${id}/start`, { method: "POST", json: { maxParallel: 2, autoMerge: false } })).status).toBe(200);
  expect((await call(`/plans/${id}/tasks`, { method: "PUT", json: { tasks } })).status).toBe(409);
  view = await (await call(`/plans/${id}`)).json();
  expect(view.plan).toMatchObject({ status: "running", maxParallel: 2, autoMerge: false });

  const schema = view.tasks[0].id;
  await prisma.planTask.update({ where: { id: schema }, data: { status: "failed" } });
  expect((await call(`/plans/${id}/tasks/${schema}/skip`, { method: "POST" })).status).toBe(200);
  expect((await call(`/plans/${id}/tasks/${schema}/skip`, { method: "POST" })).status).toBe(409);

  const list = await (await call("/plans")).json();
  expect(list.plans.find((p: any) => p.id === id)).toMatchObject({ total: 2, done: 1, needsYou: 0 });

  expect((await call(`/plans/${id}/cancel`, { method: "POST" })).status).toBe(200);
  view = await (await call(`/plans/${id}`)).json();
  expect(view.plan.status).toBe("cancelled");
  expect(view.tasks[1]).toMatchObject({ status: "skipped", note: "The plan was cancelled." });
});
