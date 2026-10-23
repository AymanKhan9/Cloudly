import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
let cookie = "";
let userId = "";

beforeAll(async () => {
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `council-api-${Date.now()}` } });
  userId = user.id;
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

test("a research council starts with one research turn per member; notes and stopping work", async () => {
  expect((await call("/councils", { method: "POST", json: { question: "x", members: ["native-claude"], chair: "native-claude" } })).status).toBe(400);
  expect((await call("/councils", { method: "POST", json: { question: "x", members: ["native-claude", "native-claude"], chair: "native-claude" } })).status).toBe(400);
  expect((await call("/councils", { method: "POST", json: { question: "x", members: ["native-claude", "gemini-acp"], chair: "native-claude", repo: "acme/x" } })).status).toBe(400);

  const est = await (await call("/councils/estimate?members=native-claude,gemini-acp&chair=native-claude&rounds=3")).json();
  expect(est.turns).toBe(7);

  const res = await call("/councils", {
    method: "POST",
    json: { question: "What's the state of the job market?", members: ["native-claude", "native-codex", "gemini-acp"], chair: "gemini-acp", rounds: 2, budgetUsd: 3 },
  });
  expect(res.status).toBe(201);
  const { id } = await res.json();
  const view = await (await call(`/councils/${id}`)).json();
  expect(view.council).toMatchObject({ status: "running", round: 1, rounds: 2, chair: "gemini-acp", repo: null, budgetUsd: 3 });
  expect(view.turns.map((t: { harness: string; round: number; role: string; status: string }) => [t.harness, t.round, t.role, t.status])).toEqual([
    ["native-claude", 1, "member", "queued"],
    ["native-codex", 1, "member", "queued"],
    ["gemini-acp", 1, "member", "queued"],
  ]);
  expect((await (await call("/councils")).json()).councils[0].id).toBe(id);

  expect((await call(`/councils/${id}/guidance`, { method: "POST", json: { text: "Focus on AI roles" } })).status).toBe(200);
  expect((await (await call(`/councils/${id}`)).json()).council.guidance[0]).toMatchObject({ text: "Focus on AI roles", round: 1 });

  expect((await call(`/councils/${id}/report`)).status).toBe(404);
  expect((await call(`/councils/${id}/cancel`, { method: "POST" })).status).toBe(200);
  const stopped = await (await call(`/councils/${id}`)).json();
  expect(stopped.council.status).toBe("cancelled");
  expect(stopped.turns.every((t: { status: string }) => t.status === "cancelled")).toBe(true);
  expect((await call(`/councils/${id}/guidance`, { method: "POST", json: { text: "late" } })).status).toBe(409);

  await prisma.council.update({ where: { id }, data: { report: "# Report" } });
  const dl = await call(`/councils/${id}/report`);
  expect(dl.headers.get("content-disposition")).toContain("council-report.md");
  expect(await dl.text()).toBe("# Report");
});

test("a round's turns come back in the order the members were picked, whatever order the database returns", async () => {
  const council = await prisma.council.create({
    data: { userId, question: "Q?", members: ["native-claude", "native-codex", "gemini-acp"], chair: "native-claude" },
  });
  // Same timestamp, inserted backwards: the database's own order says nothing.
  const at = new Date();
  for (const harness of ["gemini-acp", "native-codex", "native-claude"]) {
    await prisma.run.create({
      data: { repo: "", baseBranch: "", prompt: "x", harness, status: "queued", userId, councilId: council.id, councilRound: 1, councilRole: "member", createdAt: at },
    });
  }
  const view = await (await call(`/councils/${council.id}`)).json();
  expect(view.turns.map((t: { harness: string }) => t.harness)).toEqual(["native-claude", "native-codex", "gemini-acp"]);
});
