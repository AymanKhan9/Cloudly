import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import api from "../src/index";
import { setUpdateSources } from "../src/agent-routes";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
const stamp = Date.now();
const id = `acp-apiupd-${stamp}`;
let cookie = "";
let userId = "";

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `upd-${stamp}` } })).id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
  await prisma.provider.create({
    data: {
      id, name: "Pi", source: "catalog", sourceId: "acp-pi", version: "0.0.34",
      spec: { launch: { install: { kind: "npm", packages: ["pi-acp@0.0.34", "@earendil-works/pi-coding-agent@1.4.0"] }, args: [] }, credentials: [], hosts: [] },
    },
  });
  setUpdateSources({
    registry: async () => [{ id: "pi-acp", name: "pi ACP", version: "0.0.35", distribution: { npx: { package: "pi-acp@0.0.35" } } }],
    npmLatest: async () => "1.4.0",
  });
});
afterAll(async () => {
  await prisma.provider.deleteMany({ where: { id } });
  await prisma.user.delete({ where: { id: userId } });
});

const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET") headers.set("origin", "https://cloudly.test");
  return api.fetch(new Request(`http://api.test${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }));
};

test("with auto-update off, a check finds the update and the Update button installs it", async () => {
  expect((await call(`/settings/agents/${id}`, { method: "PATCH", json: { autoUpdate: false } })).status).toBe(200);
  expect((await call(`/settings/agents/${id}/update`, { method: "POST" })).status).toBe(409);

  const checked = await (await call("/settings/agents/updates/check", { method: "POST" })).json();
  expect(checked.results.find((r: any) => r.id === id)).toEqual({ id, from: "0.0.34", to: "0.0.35 · pi-coding-agent 1.4.0", outcome: "available" });
  const listed = (await (await call("/settings/agents")).json()).agents.find((a: any) => a.id === id);
  expect(listed).toMatchObject({ autoUpdate: false, availableVersion: "0.0.35 · pi-coding-agent 1.4.0", version: "0.0.34" });

  const updated = await (await call(`/settings/agents/${id}/update`, { method: "POST" })).json();
  expect(updated.agent).toMatchObject({ updateState: "updating", version: "0.0.35 · pi-coding-agent 1.4.0", availableVersion: null });
});
