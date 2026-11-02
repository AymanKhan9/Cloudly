import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
const repo = "acme/checks-api";
let cookie = "";
let userId = "";

beforeAll(async () => {
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `checks-api-${Date.now()}` } });
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

test("a repo's checks: defaults until set, a custom command needs one, limits are enforced", async () => {
  const fresh = await (await call(`/settings/repos/${repo}`)).json();
  expect(fresh.settings).toEqual({ checks: "auto", checkCommand: null, fixAttempts: 2, checkTimeoutSec: 600, reviewer: null, reviewRounds: 2, reviewPostToGitHub: true });
  expect(fresh.last).toBeNull();

  expect((await call(`/settings/repos/${repo}`, { method: "PUT", json: { checks: "custom", checkCommand: "", fixAttempts: 2, checkTimeoutSec: 600 } })).status).toBe(400);
  expect((await call(`/settings/repos/${repo}`, { method: "PUT", json: { checks: "auto", fixAttempts: 9, checkTimeoutSec: 600 } })).status).toBe(400);
  expect((await call(`/settings/repos/${repo}`, { method: "PUT", json: { checks: "custom", checkCommand: "bun test", fixAttempts: 3, checkTimeoutSec: 300 } })).status).toBe(200);
  const saved = await (await call(`/settings/repos/${repo}`)).json();
  expect(saved.settings).toEqual({ checks: "custom", checkCommand: "bun test", fixAttempts: 3, checkTimeoutSec: 300, reviewer: null, reviewRounds: 2, reviewPostToGitHub: true });
});

test("a session's turns carry their checks and whether Cloudly started them", async () => {
  const thread = await prisma.thread.create({ data: { userId, repo, baseBranch: "main", harness: "native-claude", title: "t", branch: "agent/checks-api" } });
  await prisma.run.create({
    data: { userId, threadId: thread.id, repo, baseBranch: "main", prompt: "Add it", harness: "native-claude", status: "succeeded", checkStatus: "failed", checkCommand: "bun test", checkOutput: "1 fail", checkMs: 1200 },
  });
  await prisma.run.create({ data: { userId, threadId: thread.id, repo, baseBranch: "main", prompt: "Fix the failing checks (attempt 1 of 2)", harness: "native-claude", status: "queued", kind: "fix" } });
  const view = await (await call(`/threads/${thread.id}`)).json();
  expect(view.turns.map((t: { kind: string; checkStatus: string | null }) => [t.kind, t.checkStatus])).toEqual([
    ["turn", "failed"],
    ["fix", null],
  ]);
  expect(view.turns[0]).toMatchObject({ checkCommand: "bun test", checkOutput: "1 fail", checkMs: 1200 });
  const last = await (await call(`/settings/repos/${repo}`)).json();
  expect(last.last).toMatchObject({ checkCommand: "bun test", checkStatus: "failed" });
});
