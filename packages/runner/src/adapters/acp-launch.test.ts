import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AcpAdapter, sessionModels, writeHomeFiles } from "./acp";
import type { RunEvent } from "@repo/shared/run-event";

// A stand-in ACP agent, the shape of the ones added under Settings > Agents: it
// logs every request it gets, offers an API-key sign-in, lists models as a
// config option, and answers a prompt in two chunks.
const FAKE_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.FAKE_ACP_LOG;
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    fs.appendFileSync(log, JSON.stringify({ method: m.method, params: m.params }) + "\\n");
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "browser", name: "Browser" }, { id: "fake.api_key", name: "Key" }] } });
    else if (m.method === "authenticate") send({ id: m.id, result: {} });
    else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "s-1", configOptions: [
      { id: "provider", name: "Provider", type: "select", currentValue: "gw", options: [{ value: "gw", name: "Gateway" }] },
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "small", options: [{ group: "fast", name: "Fast", options: [{ value: "small", name: "Small" }] }, { value: "large", name: "Large" }] },
    ] } });
    else if (m.method === "session/set_config_option") {
      if (m.params.value === "missing") send({ id: m.id, error: { code: -32602, message: "no such model" } });
      else send({ id: m.id, result: { configOptions: [] } });
    }
    else if (m.method === "session/prompt") {
      for (const text of ["Hel", "lo"]) send({ method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      send({ id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
    }
    else if (m.id !== undefined) send({ id: m.id, result: {} });
  }
});
`;

let dir = "";
let agent = "";
let log = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "acp-launch-"));
  agent = path.join(dir, "run");
  log = path.join(dir, "requests.log");
  await writeFile(agent, FAKE_AGENT);
  await chmod(agent, 0o755);
  process.env.FAKE_ACP_LOG = log;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function turn(adapter: AcpAdapter): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const e of adapter.start("Say hello")) events.push(e);
  return events;
}

async function requests(): Promise<{ method: string; params: any }[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  await writeFile(log, "");
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("an added agent signs in with its key, gets the session's model, and streams its reply", async () => {
  const events = await turn(new AcpAdapter("large", undefined, [], { name: "Fake", command: agent, authMethodId: "fake.api_key", cwd: dir }));
  const sent = await requests();

  expect(sent.find((r) => r.method === "authenticate")?.params).toEqual({ methodId: "fake.api_key" });
  expect(sent.find((r) => r.method === "session/set_config_option")?.params).toEqual({ sessionId: "s-1", configId: "model", value: "large" });
  expect(sent.find((r) => r.method === "session/new")?.params.cwd).toBe(dir);

  expect(events.find((e) => e.kind === "status" && (e.data as any).type === "acp.session")?.data).toEqual({ type: "acp.session", sessionId: "s-1" });
  // The model menu gets every choice, grouped or not, and not the "provider" option.
  expect(events.find((e) => (e.data as any)?.type === "models")?.data).toEqual({
    type: "models",
    current: "large",
    options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }],
  });
  expect(events.filter((e) => e.kind === "text").map((e) => e.data).join("")).toBe("Hello");
  expect(events.at(-1)).toMatchObject({ kind: "done", data: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } } });
});

test("no sign-in it doesn't offer, and a model it refuses is said in the reply, not a failed turn", async () => {
  const events = await turn(new AcpAdapter("missing", undefined, [], { name: "Fake", command: agent, authMethodId: "other.method", cwd: dir }));
  const sent = await requests();
  expect(sent.some((r) => r.method === "authenticate")).toBe(false);
  const text = events.filter((e) => e.kind === "text").map((e) => e.data).join("");
  expect(text).toContain(`Couldn't switch to the model "missing"`);
  expect(text).toContain("small, large");
  expect(text.endsWith("Hello")).toBe(true);
  expect(events.at(-1)?.kind).toBe("done");
});

test("an agent that needs ordinary pipes (Antigravity) gets them and still finishes its turn", async () => {
  const events = await turn(new AcpAdapter(undefined, undefined, [], { name: "Fake", command: agent, cwd: dir, pipes: true }));
  await requests();
  expect(events.filter((e) => e.kind === "text").map((e) => e.data).join("")).toBe("Hello");
  expect(events.at(-1)?.kind).toBe("done");
});

test("an agent the image hasn't installed yet fails with what to do about it", async () => {
  const adapter = new AcpAdapter(undefined, undefined, [], { name: "Cursor", command: path.join(dir, "missing", "run"), cwd: dir });
  await expect(turn(adapter)).rejects.toThrow("Cursor isn't installed in the sandbox image yet");
});

test("models come from config options, or the older models list some agents still send", () => {
  expect(sessionModels({ models: { currentModelId: "grok-4.6", availableModels: [{ modelId: "grok-4.6", name: "Grok 4.6" }] } })).toEqual({
    current: "grok-4.6",
    options: [{ value: "grok-4.6", label: "Grok 4.6" }],
  });
  expect(sessionModels({})).toBeNull();
});

test("settings files go under HOME and nowhere else", async () => {
  const home = path.join(dir, "home");
  await writeHomeFiles({ ".gemini/antigravity-acp/settings.json": '{"auth":{"type":"gemini-api-key"}}', "../escaped.txt": "no" }, home);
  expect(await readFile(path.join(home, ".gemini/antigravity-acp/settings.json"), "utf8")).toContain("gemini-api-key");
  expect(await Bun.file(path.join(dir, "escaped.txt")).exists()).toBe(false);
});
