import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import api from "../src/index";
import { resetRegistryCache } from "../src/agent-routes";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
const ORIGIN = "https://cloudly.test";
let cookie = "";
let userId = "";

// A stand-in for the ACP registry, shaped like cdn.agentclientprotocol.com's.
const REGISTRY = {
  version: "1.0.0",
  agents: [
    {
      id: "grok-build",
      name: "Grok Build",
      version: "1.0.73",
      description: "xAI's agent",
      distribution: { npx: { package: "@xai-official/grok@1.0.73", args: ["agent", "stdio"] } },
    },
    {
      id: "t-binary",
      name: "Binary Agent",
      version: "2.0.0",
      description: "Ships archives",
      icon: "https://cdn.example.test/t-binary.svg",
      distribution: {
        binary: {
          "linux-x86_64": { archive: "https://dl.example.test/a-x64.tar.gz", cmd: "./agent", args: ["acp"], sha256: "ab" },
          "darwin-aarch64": { archive: "https://dl.example.test/a-mac.tar.gz", cmd: "./agent" },
        },
      },
    },
    { id: "t-mac-only", name: "Mac Only", version: "1", distribution: { binary: { "darwin-aarch64": { archive: "https://x.test/a.zip", cmd: "./a" } } } },
    { id: "not valid id!", name: "Broken", version: "1", distribution: {} },
  ],
};

let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: () => Response.json(REGISTRY) });
  process.env.ACP_REGISTRY_URL = `http://127.0.0.1:${server.port}/registry.json`;
  resetRegistryCache();
  await prisma.provider.deleteMany({ where: { id: { in: ["acp-grok", "acp-t-binary", "acp-my-agent"] } } });
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `agents-test-${Date.now()}` } });
  userId = user.id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});

afterAll(async () => {
  server.stop(true);
  delete process.env.ACP_REGISTRY_URL;
  resetRegistryCache();
  await prisma.user.delete({ where: { id: userId } });
  await prisma.provider.deleteMany({ where: { id: { in: ["acp-grok", "acp-t-binary", "acp-my-agent"] } } });
});

function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
  return api.fetch(new Request(`http://api.test${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }));
}

test("signed out, the agent list and settings are closed", async () => {
  const res = await api.fetch(new Request("http://api.test/harnesses"));
  expect(res.status).toBe(401);
  expect((await api.fetch(new Request("http://api.test/settings/agents"))).status).toBe(401);
});

test("the registry lists what a Linux sandbox can install, and which the catalog covers", async () => {
  const { agents } = await (await call("/settings/agents/registry")).json();
  expect(agents.map((a: any) => a.id)).toEqual(["grok-build", "t-binary", "t-mac-only"]);
  expect(agents.find((a: any) => a.id === "grok-build").catalogId).toBe("acp-grok");
  expect(agents.find((a: any) => a.id === "t-mac-only").installable).toBe(false);
});

test("a catalog agent comes with its keys and hosts, and joins the picker once added", async () => {
  const { catalog } = await (await call("/settings/agents")).json();
  expect(catalog.map((c: any) => c.name)).toEqual(expect.arrayContaining(["Cursor", "Grok", "OpenCode", "Antigravity", "Pi", "fx", "Muse Code"]));

  const res = await call("/settings/agents", { method: "POST", json: { kind: "catalog", id: "acp-grok", keys: { values: { XAI_API_KEY: "xai-real-key-4321" } } } });
  expect(res.status).toBe(201);
  const { agent } = await res.json();
  expect(agent).toMatchObject({ id: "acp-grok", name: "Grok", source: "catalog", version: "1.0.73", missing: [] });
  expect(agent.spec.launch).toMatchObject({ install: { kind: "npm", packages: ["@xai-official/grok@1.0.73"] }, args: ["agent", "stdio"], authMethodId: "xai.api_key" });
  expect(agent.credentials[0]).toMatchObject({ env: "XAI_API_KEY", hosts: ["x.ai"], set: true, preview: "…4321" });
  expect(JSON.stringify(agent)).not.toContain("xai-real-key-4321");

  // Adding it again through the registry is refused, and the registry shows it as added.
  expect((await call("/settings/agents", { method: "POST", json: { kind: "registry", id: "grok-build" } })).status).toBe(400);
  const { agents } = await (await call("/settings/agents/registry")).json();
  expect(agents.find((a: any) => a.id === "grok-build").added).toBe(true);

  const { harnesses } = await (await call("/harnesses")).json();
  expect(harnesses.slice(0, 3).map((h: any) => h.id)).toEqual(["native-claude", "native-codex", "gemini-acp"]);
  expect(harnesses.find((h: any) => h.id === "acp-grok")).toMatchObject({ name: "Grok", cost: "none", missing: [] });
});

test("registry icons come only from the registry's own CDN", async () => {
  // t-binary's icon is on another host, so it isn't fetched.
  expect((await call("/settings/agents/icon/t-binary")).status).toBe(404);
  expect((await call("/settings/agents/icon/not-in-registry")).status).toBe(404);
});

test("agents Cloudly can't run safely are refused with the reason", async () => {
  const res = await call("/settings/agents", { method: "POST", json: { kind: "catalog", id: "acp-muse" } });
  expect(res.status).toBe(400);
  expect((await res.json()).message).toContain("Meta account");
  expect((await call("/settings/agents", { method: "POST", json: { kind: "registry", id: "t-mac-only" } })).status).toBe(400);
});

test("a registry agent installs from its Linux build and takes keys the user defines", async () => {
  const res = await call("/settings/agents", {
    method: "POST",
    json: { kind: "registry", id: "t-binary", hosts: ["login.example.test"], keys: { values: { BIN_KEY: "bk-0000" }, define: [{ env: "BIN_KEY", hosts: ["api.example.test"] }] } },
  });
  expect(res.status).toBe(201);
  const { agent } = await res.json();
  // Served from Cloudly's own origin, so the web app can draw it as a mask.
  expect(agent).toMatchObject({ id: "acp-t-binary", source: "registry", icon: "/api/settings/agents/icon/t-binary" });
  expect(agent.spec.launch.install).toEqual({ kind: "binary", builds: { x86_64: { url: "https://dl.example.test/a-x64.tar.gz", cmd: "./agent", sha256: "ab" } } });
  expect(agent.spec.hosts).toEqual(["login.example.test"]);
  expect(agent.credentials[0]).toMatchObject({ env: "BIN_KEY", hosts: ["api.example.test"], set: true });

  // A key the user defined can go; a catalog agent's own can't.
  expect((await call("/settings/agents/acp-t-binary/keys/BIN_KEY", { method: "DELETE" })).status).toBe(200);
  expect((await call("/settings/agents/acp-grok/keys/XAI_API_KEY", { method: "DELETE" })).status).toBe(400);
});

test("a custom command becomes an agent; sessions can use it while it's on", async () => {
  const res = await call("/settings/agents", {
    method: "POST",
    json: { kind: "custom", name: "My Agent", command: "my-agent", args: ["--acp"], installScript: "npm install -g my-agent" },
  });
  expect(res.status).toBe(201);
  const { agent } = await res.json();
  expect(agent.id).toBe("acp-my-agent");
  expect(agent.spec.launch).toMatchObject({ install: { kind: "script", cmd: "my-agent", script: "npm install -g my-agent" }, args: ["--acp"] });

  const thread = { repo: "acme/agents", baseBranch: "main", prompt: "Hello", harness: "acp-my-agent" };
  const made = await call("/threads", { method: "POST", json: thread });
  expect(made.status).toBe(201);

  await call("/settings/agents/acp-my-agent", { method: "PATCH", json: { enabled: false } });
  expect((await call("/threads", { method: "POST", json: thread })).status).toBe(400);
  expect((await call("/threads", { method: "POST", json: { ...thread, harness: "acp-nonexistent" } })).status).toBe(400);

  // Multi-line commands would break the run script.
  expect((await call("/settings/agents", { method: "POST", json: { kind: "custom", name: "x", command: "a\nb" } })).status).toBe(400);

  expect((await call("/settings/agents/acp-my-agent", { method: "DELETE" })).status).toBe(204);
  expect(await prisma.provider.findUnique({ where: { id: "acp-my-agent" } })).toBeNull();
});
