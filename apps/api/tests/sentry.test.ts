import { test, expect, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import { prisma, setSetting, deleteSetting } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";
import { sentrySignatureValid } from "../src/sentry-routes";

let cookie = "";
let userId = "";
const SECRET = "s3cr3t-sentry-client-secret-0123";
beforeAll(async () => {
  userId = (await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `sentry-api-${Date.now()}` } })).id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});
afterAll(async () => {
  await deleteSetting("SENTRY_CLIENT_SECRET");
  await prisma.webhookDelivery.deleteMany({ where: { id: { startsWith: "sentry-test-" } } });
  await prisma.sentryProject.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

const post = (body: string, headers: Record<string, string>) =>
  api.fetch(new Request("http://api.test/webhooks/sentry", { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));
const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");

test("Sentry's webhook: signed with the client secret, stored for the worker, once", async () => {
  const body = JSON.stringify({ action: "created", data: { issue: { id: "42", title: "TypeError", project: { slug: "web" } } } });
  expect((await post(body, { "sentry-hook-resource": "issue", "sentry-hook-signature": sign(body) })).status).toBe(503);
  await setSetting("SENTRY_CLIENT_SECRET", SECRET);
  expect((await post(body, { "sentry-hook-resource": "issue", "sentry-hook-signature": "0".repeat(64) })).status).toBe(401);
  expect((await post(body, { "sentry-hook-resource": "installation", "sentry-hook-signature": sign(body) })).status).toBe(202);
  const id = `test-${Date.now()}`;
  const ok = await post(body, { "sentry-hook-resource": "issue", "sentry-hook-signature": sign(body), "request-id": id });
  expect(ok.status).toBe(202);
  expect(await prisma.webhookDelivery.findUnique({ where: { id: `sentry-${id}` } })).toMatchObject({ event: "sentry.issue", action: "created", status: "pending" });
  expect(await (await post(body, { "sentry-hook-resource": "issue", "sentry-hook-signature": sign(body), "request-id": id })).json()).toEqual({ ok: true, duplicate: true });
  // Sentry's examples sign the re-serialised JSON: spacing differences still verify.
  const spaced = JSON.stringify(JSON.parse(body), null, 2);
  expect(sentrySignatureValid(SECRET, spaced, sign(body))).toBe(true);
});

test("Settings > Sentry: projects map to repos", async () => {
  const call = (path: string, init: RequestInit = {}) =>
    api.fetch(new Request(`http://api.test${path}`, { ...init, headers: { cookie, "content-type": "application/json", origin: process.env.WEB_ORIGIN ?? "" } }));
  const added = await call("/settings/sentry/projects", { method: "POST", body: JSON.stringify({ slug: "Web-App", repo: "acme/web", perDay: 3 }) });
  expect(added.status).toBe(201);
  const view = await (await call("/settings/sentry")).json();
  expect(view.secretSet).toBe(true);
  expect(view.webhookUrl).toEndWith("/webhooks/sentry");
  expect(view.projects.find((p: any) => p.slug === "web-app")).toMatchObject({ repo: "acme/web", perDay: 3, enabled: true, harness: null, userId });
  expect((await call("/settings/sentry/projects", { method: "POST", body: JSON.stringify({ slug: "x y", repo: "acme/web" }) })).status).toBe(400);
});
