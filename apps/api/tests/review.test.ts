import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
const repo = "acme/review-api";
let cookie = "";
let userId = "";

beforeAll(async () => {
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `review-api-${Date.now()}` } });
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

const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n";

test("the Changes tab: the diff, findings to dismiss, and feedback sent as one turn", async () => {
  const thread = await prisma.thread.create({ data: { userId, repo, baseBranch: "main", harness: "native-claude", title: "t", branch: "agent/review-api", diff: DIFF, diffBase: "a".repeat(40), needsInput: "The reviewer still finds…" } });
  const review = await prisma.run.create({ data: { userId, threadId: thread.id, repo, baseBranch: "main", prompt: "Review the changes", harness: "native-codex", status: "succeeded", kind: "review", output: "1 blocking" } });
  const [bug, nit] = await Promise.all([
    prisma.reviewFinding.create({ data: { runId: review.id, threadId: thread.id, file: "a.ts", line: 1, severity: "blocking", title: "Bug", body: "Fix it." } }),
    prisma.reviewFinding.create({ data: { runId: review.id, threadId: thread.id, file: "a.ts", line: 1, severity: "nit", title: "Nit", body: "" } }),
  ]);

  const changes = await (await call(`/threads/${thread.id}/changes`)).json();
  expect(changes.diff).toBe(DIFF);
  expect(changes.findings).toHaveLength(2);
  const view = await (await call(`/threads/${thread.id}`)).json();
  expect(view.turns[0]).toMatchObject({ kind: "review", harness: "native-codex", output: "1 blocking" });

  expect((await call(`/threads/${thread.id}/findings/${nit.id}`, { method: "PATCH", json: { status: "dismissed" } })).status).toBe(200);
  expect((await call(`/threads/${thread.id}/feedback`, { method: "POST", json: {} })).status).toBe(400);
  const sent = await call(`/threads/${thread.id}/feedback`, { method: "POST", json: { findingIds: [bug.id], comments: [{ file: "a.ts", line: 1, body: "Use a constant." }] } });
  expect(sent.status).toBe(201);
  const turn = await prisma.run.findUniqueOrThrow({ where: { id: (await sent.json()).id } });
  expect(turn.harness).toBe("native-claude");
  expect(turn.prompt).toContain("**Bug** (`a.ts:1`)");
  expect(turn.prompt).toContain("`a.ts:1`: Use a constant.");
  const after = await prisma.reviewFinding.findMany({ where: { threadId: thread.id }, orderBy: { severity: "asc" } });
  expect(after.map((f) => f.status)).toEqual(["sent", "dismissed"]);
  expect((await prisma.thread.findUniqueOrThrow({ where: { id: thread.id } })).needsInput).toBeNull();

  // One turn at a time.
  expect((await call(`/threads/${thread.id}/review`, { method: "POST", json: {} })).status).toBe(409);
  await prisma.run.update({ where: { id: turn.id }, data: { status: "succeeded" } });
  const manual = await call(`/threads/${thread.id}/review`, { method: "POST", json: { harness: "gemini-acp" } });
  expect(manual.status).toBe(201);
  expect((await prisma.run.findUniqueOrThrow({ where: { id: (await manual.json()).id } })).kind).toBe("review");

  // Someone else's session isn't reachable.
  const other = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `other-${Date.now()}` } });
  const theirs = await prisma.thread.create({ data: { userId: other.id, repo, baseBranch: "main", harness: "native-claude", title: "t", branch: "agent/x", diff: DIFF } });
  expect((await call(`/threads/${theirs.id}/changes`)).status).toBe(404);
  expect((await call(`/threads/${theirs.id}/findings/${bug.id}`, { method: "PATCH", json: { status: "open" } })).status).toBe(404);
  await prisma.user.delete({ where: { id: other.id } });
});

test("an audit session starts with an audit turn; the reviewer is a repo setting", async () => {
  const r = await call("/threads", { method: "POST", json: { repo, baseBranch: "main", prompt: "Look at error handling", harness: "native-codex", mode: "audit" } });
  expect(r.status).toBe(201);
  const view = await (await call(`/threads/${(await r.json()).id}`)).json();
  expect(view.thread.title).toStartWith("Audit: ");
  expect(view.turns[0].kind).toBe("audit");

  expect((await call(`/settings/repos/${repo}`, { method: "PUT", json: { checks: "auto", fixAttempts: 2, checkTimeoutSec: 600, reviewer: "Not A Harness" } })).status).toBe(400);
  expect((await call(`/settings/repos/${repo}`, { method: "PUT", json: { checks: "auto", fixAttempts: 2, checkTimeoutSec: 600, reviewer: "native-codex", reviewRounds: 1, reviewPostToGitHub: false } })).status).toBe(200);
  // Saving the checks alone keeps the reviewer.
  expect((await call(`/settings/repos/${repo}`, { method: "PUT", json: { checks: "off", fixAttempts: 2, checkTimeoutSec: 600 } })).status).toBe(200);
  const saved = await (await call(`/settings/repos/${repo}`)).json();
  expect(saved.settings).toMatchObject({ checks: "off", reviewer: "native-codex", reviewRounds: 1, reviewPostToGitHub: false });
});
