import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma, getProvider } from "@repo/db";
import api from "../src/index";
import { reportedModels } from "../src/harnesses";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
const ORIGIN = "https://cloudly.test";
const AGENT = "acp-opencode-models-test";
let cookie = "";
let userId = "";

beforeAll(async () => {
  await prisma.provider.deleteMany({ where: { id: AGENT } });
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `models-test-${Date.now()}` } });
  userId = user.id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});

afterAll(async () => {
  await prisma.run.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.provider.deleteMany({ where: { id: AGENT } });
});

function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET") headers.set("origin", ORIGIN);
  return api.fetch(new Request(`http://api.test${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }));
}

test("an added agent's models are the ones its last turn listed, so they can be picked before a session", async () => {
  expect(await reportedModels(AGENT)).toBeNull();
  const old = await prisma.run.create({ data: { repo: "acme/shop", baseBranch: "main", prompt: "a", harness: AGENT, status: "succeeded", userId, createdAt: new Date(Date.now() - 60_000) } });
  await prisma.runEvent.create({ data: { runId: old.id, seq: 0, kind: "status", ts: new Date(Date.now() - 60_000), data: { type: "models", current: "opencode/old", options: [{ value: "opencode/old", label: "Old" }] } } });
  const run = await prisma.run.create({ data: { repo: "acme/shop", baseBranch: "main", prompt: "b", harness: AGENT, status: "failed", userId } });
  await prisma.runEvent.create({
    data: {
      runId: run.id, seq: 0, kind: "status",
      data: { type: "models", current: "opencode/deepseek-v4.1-flash-free", options: [{ value: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free" }, { value: "anthropic/claude-sonnet-5-5" }, { nope: 1 }] },
    },
  });
  expect(await reportedModels(AGENT)).toEqual({
    models: [
      { value: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free" },
      { value: "anthropic/claude-sonnet-5-5", label: "anthropic/claude-sonnet-5-5" },
    ],
    defaultModel: "opencode/deepseek-v4.1-flash-free",
  });
});

test("a model picked before the session starts is the session's model", async () => {
  const res = await call("/threads", { method: "POST", json: { repo: "acme/shop", baseBranch: "main", prompt: "Add a test", harness: "native-claude", model: "claude-sonnet-5-5" } });
  expect(res.status).toBe(201);
  const { id } = await res.json();
  expect((await prisma.thread.findUnique({ where: { id } }))?.model).toBe("claude-sonnet-5-5");
  // "/model" in the message itself still wins.
  const typed = await (await call("/threads", { method: "POST", json: { repo: "acme/shop", baseBranch: "main", prompt: "/model claude-haiku-5-5", harness: "native-claude", model: "claude-sonnet-5-5" } })).json();
  expect((await prisma.thread.findUnique({ where: { id: typed.id } }))?.model).toBe("claude-haiku-5-5");
  expect((await call("/threads", { method: "POST", json: { repo: "acme/shop", baseBranch: "main", prompt: "x", harness: "native-claude", model: "two words" } })).status).toBe(400);
  await prisma.thread.deleteMany({ where: { userId } });
});

test("an OpenCode added before it took an OpenCode key gets the key", async () => {
  await prisma.provider.create({
    data: {
      id: AGENT, name: "OpenCode", source: "catalog", sourceId: "acp-opencode",
      spec: { launch: { install: { kind: "npm", packages: ["opencode-ai"] }, args: ["acp"] }, credentials: [{ env: "OPENROUTER_API_KEY", label: "OpenRouter API key", hosts: ["openrouter.ai"], optional: true }], hosts: ["opencode.ai"] },
    },
  });
  const agent = await getProvider(AGENT);
  expect(agent?.credentials.map((c) => c.env)).toContain("OPENCODE_API_KEY");
  expect(agent?.credentials.find((c) => c.env === "OPENCODE_API_KEY")?.hosts).toEqual(["opencode.ai"]);
  expect(agent?.spec.hosts).toContain("models.dev");
  // Optional: free models run without it.
  expect(agent?.missing).toEqual([]);
});
