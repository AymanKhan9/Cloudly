import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

let cookie = "";
let userId = "";
beforeAll(async () => {
  userId = (await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `steer-api-${Date.now()}` } })).id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
});

test("a message while a turn runs goes to its agent; after it, or a /command, waits its turn", async () => {
  const thread = await prisma.thread.create({ data: { userId, repo: "acme/s", baseBranch: "main", harness: "native-codex", title: "t", branch: "b" } });
  const send = (body: object) =>
    api.fetch(new Request(`http://api.test/threads/${thread.id}/messages`, { method: "POST", body: JSON.stringify(body), headers: { cookie, "content-type": "application/json", origin: process.env.WEB_ORIGIN ?? "" } }));
  const running = await prisma.run.create({ data: { userId, threadId: thread.id, repo: "acme/s", baseBranch: "main", harness: "native-codex", prompt: "go", status: "running" } });

  const now = await send({ prompt: "use tabs" });
  expect(now.status).toBe(202);
  expect(await now.json()).toMatchObject({ steered: true, runId: running.id });
  expect(await prisma.runSteer.findMany({ where: { runId: running.id } })).toHaveLength(1);

  const later = await send({ prompt: "then write docs", after: true });
  expect(later.status).toBe(201);
  const cmd = await send({ prompt: "/compact" });
  expect(cmd.status).toBe(201);
  expect((await prisma.run.findMany({ where: { threadId: thread.id, status: "queued" }, orderBy: { createdAt: "asc" } })).map((r) => r.prompt)).toEqual(["then write docs", "/compact"]);

  // Nothing running: an ordinary next turn.
  await prisma.run.updateMany({ where: { threadId: thread.id }, data: { status: "succeeded" } });
  expect((await send({ prompt: "next" })).status).toBe(201);
});
