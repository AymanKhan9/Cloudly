import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
const repo = `acme/sched-api-${Date.now()}`;
let cookie = "";
let userId = "";

beforeAll(async () => {
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `sched-api-${Date.now()}` } });
  userId = user.id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
  await prisma.repoSettings.deleteMany({ where: { repo } });
});

const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET") headers.set("origin", "https://cloudly.test");
  return api.fetch(new Request(`http://api.test${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }));
};

const base = { name: "Morning triage", repo, baseBranch: "main", harness: "native-claude", prompt: "Triage new issues", frequency: "weekdays", minuteOfDay: 540, timeZone: "Europe/London" };

test("schedules are created with their next run, checked, changed, run now, and deleted", async () => {
  expect((await call("/schedules", { method: "POST", json: { ...base, frequency: "weekly" } })).status).toBe(400);
  expect((await call("/schedules", { method: "POST", json: { ...base, timeZone: "Nowhere/Land" } })).status).toBe(400);
  const created = await call("/schedules", { method: "POST", json: base });
  expect(created.status).toBe(201);
  const s = await created.json();
  expect(s).toMatchObject({ description: "Weekdays at 09:00", mode: "new", kind: "turn", enabled: true });
  expect(new Date(s.nextRunAt).getTime()).toBeGreaterThan(Date.now());

  const listed = await (await call("/schedules")).json();
  expect(listed.schedules.map((x: { id: string }) => x.id)).toEqual([s.id]);

  // A new time recomputes the next run; a weekly one needs its day.
  expect((await call(`/schedules/${s.id}`, { method: "PATCH", json: { frequency: "weekly" } })).status).toBe(400);
  const changed = await (await call(`/schedules/${s.id}`, { method: "PATCH", json: { frequency: "weekly", weekday: 5, minuteOfDay: 1020 } })).json();
  expect(changed.description).toBe("Fridays at 17:00");
  expect(new Date(changed.nextRunAt).getUTCDay()).toBe(5);

  expect((await call(`/schedules/${s.id}/run`, { method: "POST" })).status).toBe(200);
  expect((await prisma.schedule.findUniqueOrThrow({ where: { id: s.id } })).nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
  await call(`/schedules/${s.id}`, { method: "PATCH", json: { enabled: false } });
  expect((await call(`/schedules/${s.id}/run`, { method: "POST" })).status).toBe(404);

  // Someone else's isn't reachable.
  const other = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `other-${Date.now()}` } });
  const theirs = await prisma.schedule.create({ data: { ...base, userId: other.id, nextRunAt: new Date() } });
  expect((await call(`/schedules/${theirs.id}`, { method: "PATCH", json: { enabled: false } })).status).toBe(404);
  expect((await call(`/schedules/${theirs.id}`, { method: "DELETE" })).status).toBe(404);
  await prisma.user.delete({ where: { id: other.id } });

  expect((await call(`/schedules/${s.id}`, { method: "DELETE" })).status).toBe(204);
  expect((await (await call("/schedules")).json()).schedules).toEqual([]);
});

test("merge when ready: the repo's default for new sessions, and a switch on each session", async () => {
  expect((await call(`/settings/repos/${repo}`, { method: "PUT", json: { autoMerge: true, mergeMethod: "rebase" } })).status).toBe(200);
  expect((await call(`/settings/repos/${repo}`, { method: "PUT", json: { mergeMethod: "fast-forward" } })).status).toBe(400);
  const r = await call("/threads", { method: "POST", json: { repo, baseBranch: "main", prompt: "Do it", harness: "native-claude" } });
  const id = (await r.json()).id;
  let view = await (await call(`/threads/${id}`)).json();
  expect(view.thread.autoMerge).toBe(true);

  await call(`/threads/${id}`, { method: "PATCH", json: { autoMerge: false } });
  view = await (await call(`/threads/${id}`)).json();
  expect(view.thread).toMatchObject({ autoMerge: false, mergeStatus: null });
  await call(`/threads/${id}`, { method: "PATCH", json: { autoMerge: true } });
  view = await (await call(`/threads/${id}`)).json();
  expect(view.thread).toMatchObject({ autoMerge: true, mergeStatus: "Checking" });

  const off = await call("/threads", { method: "POST", json: { repo, baseBranch: "main", prompt: "Do it", harness: "native-claude", autoMerge: false } });
  expect((await (await call(`/threads/${(await off.json()).id}`)).json()).thread.autoMerge).toBe(false);
});
