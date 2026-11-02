import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
let cookie = "";
let userId = "";

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `cp-api-${Date.now()}` } })).id;
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

test("rewind and fork: what's allowed, and what a fork starts with", async () => {
  const thread = await prisma.thread.create({ data: { userId, repo: "acme/cp", baseBranch: "main", harness: "native-claude", title: "Billing", branch: "agent/cp", model: "claude-opus-5-5" } });
  const at = (s: number) => new Date(Date.now() - 60_000 + s * 1000);
  const [t1, t2] = await Promise.all([
    prisma.run.create({ data: { userId, threadId: thread.id, repo: "acme/cp", baseBranch: "main", harness: "native-claude", prompt: "one", status: "succeeded", commitSha: "a".repeat(40), createdAt: at(1) } }),
    prisma.run.create({ data: { userId, threadId: thread.id, repo: "acme/cp", baseBranch: "main", harness: "native-claude", prompt: "two", status: "succeeded", commitSha: "b".repeat(40), createdAt: at(2) } }),
  ]);
  const rewind = (runId: string) => call(`/threads/${thread.id}/rewind`, { method: "POST", json: { runId } });

  expect((await (await rewind(t2.id)).json()).message).toContain("latest turn");
  const busy = await prisma.run.create({ data: { userId, threadId: thread.id, repo: "acme/cp", baseBranch: "main", harness: "native-claude", prompt: "three", status: "running", createdAt: at(3) } });
  expect((await (await rewind(t1.id)).json()).message).toContain("Wait for the current turn");
  await prisma.run.update({ where: { id: busy.id }, data: { status: "succeeded" } });

  const ok = await rewind(t1.id);
  expect(ok.status).toBe(201);
  const queued = await prisma.run.findUniqueOrThrow({ where: { id: (await ok.json()).id } });
  expect(queued).toMatchObject({ kind: "rewind", targetRunId: t1.id, prompt: "Rewind to after turn 1", status: "queued" });

  // A fork with another agent and a first message: the fork turn, then the message.
  const forked = await call(`/threads/${thread.id}/fork`, { method: "POST", json: { runId: t2.id, harness: "native-codex", prompt: "Try it with Stripe instead" } });
  expect(forked.status).toBe(201);
  const forkId = (await forked.json()).id;
  const view = await (await call(`/threads/${forkId}`)).json();
  expect(view.thread).toMatchObject({ harness: "native-codex", model: null, title: "Billing (fork at turn 2)", forkOf: { threadId: thread.id, title: "Billing", turn: 2 } });
  expect(view.turns.map((t: any) => [t.kind, t.prompt])).toEqual([["fork", 'Fork of "Billing" after turn 2'], ["turn", "Try it with Stripe instead"]]);

  // Once merged, the branch stays: rewinding is refused, forking still works.
  await prisma.run.updateMany({ where: { threadId: thread.id }, data: { status: "succeeded" } });
  await prisma.thread.update({ where: { id: thread.id }, data: { mergedAt: new Date() } });
  expect((await (await rewind(t1.id)).json()).message).toContain("merged");
  expect((await call(`/threads/${thread.id}/fork`, { method: "POST", json: { runId: t1.id } })).status).toBe(201);
  // Not someone else's.
  expect((await call(`/threads/00000000-0000-0000-0000-000000000000/fork`, { method: "POST", json: { runId: t1.id } })).status).toBe(404);
});
