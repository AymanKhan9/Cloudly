import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

let cookie = "";
let userId = "";
let otherCookie = "";
let otherId = "";

async function login(name: string) {
  const id = (await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `${name}-${Date.now()}` } })).id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId: id, expiresAt: new Date(Date.now() + 3600_000) } });
  return { id, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}
beforeAll(async () => {
  ({ id: userId, cookie } = await login("art-api"));
  ({ id: otherId, cookie: otherCookie } = await login("art-other"));
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
});

const call = (path: string, init: RequestInit & { as?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.as !== "") headers.set("cookie", init.as ?? cookie);
  return api.fetch(new Request(`http://api.test${path}`, { ...init, headers }));
};

test("artifacts: never served as a page of this origin; shared links on and off", async () => {
  const thread = await prisma.thread.create({ data: { userId, repo: "acme/a", baseBranch: "main", harness: "native-claude", title: "Charts", branch: "agent/a" } });
  const run = await prisma.run.create({ data: { userId, threadId: thread.id, repo: "acme/a", baseBranch: "main", harness: "native-claude", prompt: "chart it", status: "succeeded" } });
  const mk = (name: string, kind: string, mime: string, content: string, version = 1) =>
    prisma.artifact.create({ data: { threadId: thread.id, runId: run.id, name, kind, mime, content: Buffer.from(content), size: content.length, sha256: name + version, version } });
  const html = await mk("chart.html", "html", "text/html", "<script>alert(1)</script>");
  const svg = await mk("logo.svg", "svg", "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  await mk("chart.html", "html", "text/html", "<p>v2</p>", 2);

  const view = await (await call(`/threads/${thread.id}`)).json();
  expect(view.thread.artifacts.map((a: any) => [a.name, a.version, a.shared])).toEqual([["chart.html", 1, false], ["chart.html", 2, false], ["logo.svg", 1, false]]);
  expect(view.thread.artifacts[0].content).toBeUndefined();

  const h = await call(`/artifacts/${html.id}/content`);
  expect(h.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(h.headers.get("content-security-policy")).toStartWith("sandbox");
  expect(h.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await h.text()).toBe("<script>alert(1)</script>");
  const s = await call(`/artifacts/${svg.id}/content?download=1`);
  expect(s.headers.get("content-type")).toBe("image/svg+xml");
  expect(s.headers.get("content-security-policy")).toStartWith("sandbox");
  expect(s.headers.get("content-disposition")).toBe('attachment; filename="logo.svg"');

  // Not someone else's, and not without signing in.
  expect((await call(`/artifacts/${html.id}/content`, { as: otherCookie })).status).toBe(404);
  expect((await call(`/artifacts/${html.id}/content`, { as: "" })).status).toBe(401);

  // A share link: the same token each time, readable signed out, until it's turned off.
  const { token } = await (await call(`/artifacts/${svg.id}/share`, { method: "POST" })).json();
  expect((await (await call(`/artifacts/${svg.id}/share`, { method: "POST" })).json()).token).toBe(token);
  expect((await (await call(`/shared/${token}`, { as: "" })).json()).artifact).toMatchObject({ name: "logo.svg", kind: "svg", version: 1 });
  const pub = await call(`/shared/${token}/content`, { as: "" });
  expect(pub.headers.get("content-security-policy")).toStartWith("sandbox");
  expect((await (await call(`/threads/${thread.id}`)).json()).thread.artifacts.find((a: any) => a.id === svg.id).shared).toBe(true);
  expect((await call(`/artifacts/${svg.id}/share`, { method: "POST", as: otherCookie })).status).toBe(404);
  await call(`/artifacts/${svg.id}/share`, { method: "DELETE" });
  expect((await call(`/shared/${token}/content`, { as: "" })).status).toBe(404);
  expect((await call(`/shared/not-a-token`, { as: "" })).status).toBe(404);
});
