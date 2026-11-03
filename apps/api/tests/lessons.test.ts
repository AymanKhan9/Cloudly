import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

let cookie = "";
let userId = "";
const repo = `acme/lessons-api-${Date.now()}`;
beforeAll(async () => {
  userId = (await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `lessons-api-${Date.now()}` } })).id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});
afterAll(async () => {
  await prisma.lesson.deleteMany({ where: { repo } });
  await prisma.run.deleteMany({ where: { repo } });
  await prisma.contextEntry.deleteMany({ where: { repo } });
  await prisma.repoContext.deleteMany({ where: { repo } });
  await prisma.repoSettings.deleteMany({ where: { repo } });
  await prisma.user.delete({ where: { id: userId } });
});
const call = (p: string, init: RequestInit = {}) =>
  api.fetch(new Request(`http://api.test${p}`, { ...init, headers: { cookie, "content-type": "application/json", origin: process.env.WEB_ORIGIN ?? "" } }));

test("lessons: look for them, then keep one (edited) in the repo's notes and turn one down", async () => {
  const look = await call("/lessons/run", { method: "POST", body: JSON.stringify({ repo }) });
  expect(look.status).toBe(201);
  expect((await call("/lessons/run", { method: "POST", body: JSON.stringify({ repo }) })).status).toBe(409);
  const run = await prisma.run.findUniqueOrThrow({ where: { id: (await look.json()).id } });
  expect(run).toMatchObject({ kind: "lessons", status: "queued", harness: "native-claude", threadId: null });

  const a = await prisma.lesson.create({ data: { repo, runId: run.id, title: "Generated code", rule: "Never edit src/gen by hand.", evidence: [] } });
  const b = await prisma.lesson.create({ data: { repo, runId: run.id, title: "Tabs", rule: "Use tabs everywhere in the repo.", evidence: [] } });
  await prisma.repoContext.create({ data: { repo, enabled: false, notes: "Use bun." } });

  const kept = await call(`/lessons/${a.id}/accept`, { method: "POST", body: JSON.stringify({ rule: "Never edit src/gen; change the schema and run bun db:generate." }) });
  expect(await kept.json()).toEqual({ ok: true, turnedOnContext: true });
  const ctx = await prisma.repoContext.findUniqueOrThrow({ where: { repo } });
  expect(ctx.enabled).toBe(true);
  expect(ctx.notes).toBe("Use bun.\n\n## Learned from earlier sessions\n\n- **Generated code**: Never edit src/gen; change the schema and run bun db:generate.\n");
  expect(await prisma.contextEntry.count({ where: { repo, kind: "decision" } })).toBe(1);

  expect((await call(`/lessons/${b.id}/dismiss`, { method: "POST" })).status).toBe(200);
  expect((await call(`/lessons/${b.id}/dismiss`, { method: "POST" })).status).toBe(404);
  const view = await (await call(`/lessons?repo=${repo}`)).json();
  expect(view.lessons.map((l: any) => [l.title, l.status])).toEqual([["Generated code", "accepted"], ["Tabs", "dismissed"]]);
  expect(view).toMatchObject({ autoLessons: false, contextOn: true, run: { status: "queued" } });

  await call("/lessons/settings", { method: "PUT", body: JSON.stringify({ repo, autoLessons: true }) });
  expect((await (await call(`/lessons?repo=${repo}`)).json()).autoLessons).toBe(true);
});
