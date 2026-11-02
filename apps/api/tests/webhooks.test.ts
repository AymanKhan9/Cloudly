import { test, expect, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import { prisma } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";
import { buildManifest } from "../src/setup";

process.env.WEB_ORIGIN = "https://cloudly.test";
const SECRET = "test-webhook-secret";
const stamp = Date.now();
const saved = process.env.GITHUB_WEBHOOK_SECRET;
let cookie = "";
let userId = "";

beforeAll(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `hooks-api-${stamp}` } });
  userId = user.id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});
afterAll(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = saved;
  await prisma.user.delete({ where: { id: userId } });
  await prisma.webhookDelivery.deleteMany({ where: { id: { startsWith: `api-${stamp}` } } });
  await prisma.repoSettings.deleteMany({ where: { repo: "acme/hooks-api" } });
});

const post = (event: string, id: string, body: string, signature?: string) =>
  api.fetch(
    new Request("http://api.test/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": id,
        "x-hub-signature-256": signature ?? `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
      },
      body,
    }),
  );

test("deliveries are stored only with GitHub's signature, once each, and only for events Cloudly handles", async () => {
  const body = JSON.stringify({ action: "labeled", repository: { full_name: "acme/x" } });
  expect((await post("issues", `api-${stamp}-1`, body, "sha256=" + "0".repeat(64))).status).toBe(401);
  expect((await post("issues", `api-${stamp}-1`, body, "")).status).toBe(401);
  // Signed for a different body.
  expect((await post("issues", `api-${stamp}-1`, body.replace("acme", "evil"), `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`)).status).toBe(401);

  expect((await post("issues", `api-${stamp}-1`, body)).status).toBe(202);
  const again = await post("issues", `api-${stamp}-1`, body);
  expect(await again.json()).toMatchObject({ duplicate: true });
  expect((await post("ping", `api-${stamp}-2`, "{}")).status).toBe(200);
  expect(await (await post("star", `api-${stamp}-3`, "{}")).json()).toMatchObject({ ignored: "star" });

  const rows = await prisma.webhookDelivery.findMany({ where: { id: { startsWith: `api-${stamp}` } } });
  expect(rows.map((r) => [r.event, r.action, r.status])).toEqual([["issues", "labeled", "pending"]]);

  // Without a secret, nothing is accepted.
  delete process.env.GITHUB_WEBHOOK_SECRET;
  expect((await post("issues", `api-${stamp}-4`, body)).status).toBe(503);
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
});

const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET") headers.set("origin", "https://cloudly.test");
  return api.fetch(new Request(`http://api.test${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }));
};

test("settings show where to point GitHub and what arrived; triggers are per repo", async () => {
  expect((await api.fetch(new Request("http://api.test/settings/webhooks"))).status).toBe(401);
  const view = await (await call("/settings/webhooks")).json();
  expect(view.url).toBe("https://cloudly.test/api/webhooks/github");
  expect(view.secretSet).toBe(true);
  expect(view.deliveries.some((d: { event: string }) => d.event === "issues")).toBe(true);

  const repo = "acme/hooks-api";
  const fresh = await (await call(`/settings/repos/${repo}`)).json();
  expect(fresh.settings).toMatchObject({ issueLabel: "cloudly", onIssueLabel: true, onMention: true, onPrReview: true, fixCi: true, ciFixAttempts: 2, triggerHarness: null });
  // Saving the triggers alone keeps the checks.
  expect((await call(`/settings/repos/${repo}`, { method: "PUT", json: { checks: "custom", checkCommand: "make test", fixAttempts: 1, checkTimeoutSec: 600 } })).status).toBe(200);
  expect((await call(`/settings/repos/${repo}`, { method: "PUT", json: { issueLabel: "ai", fixCi: false, triggerHarness: "native-codex" } })).status).toBe(200);
  expect((await call(`/settings/repos/${repo}`, { method: "PUT", json: { ciFixAttempts: 9 } })).status).toBe(400);
  const saved = await (await call(`/settings/repos/${repo}`)).json();
  expect(saved.settings).toMatchObject({ checks: "custom", checkCommand: "make test", fixAttempts: 1, issueLabel: "ai", fixCi: false, triggerHarness: "native-codex" });
});

test("a new GitHub App is created with the webhook, its events and the permissions they need", () => {
  const m = buildManifest("abc");
  expect(m.hook_attributes).toEqual({ url: "https://cloudly.test/api/webhooks/github", active: true });
  expect(m.default_events).toEqual(["issues", "issue_comment", "pull_request_review", "check_suite"]);
  expect(m.default_permissions).toMatchObject({ issues: "write", checks: "read", actions: "read", contents: "write", pull_requests: "write" });
});
