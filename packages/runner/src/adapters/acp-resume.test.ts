import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AcpAdapter, piTurnCost } from "./acp";
import type { RunEvent } from "@repo/shared/run-event";

// A stand-in for an agent like OpenCode or Pi: it can load a session it knows
// (replaying the old conversation first), offers an effort option, reports
// usage with what the session has cost, and writes a Pi-style session file.
const AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.FAKE_ACP_LOG;
const home = process.env.HOME;
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const effort = { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] };
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    fs.appendFileSync(log, JSON.stringify({ method: m.method, params: m.params }) + "\\n");
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "new-1", configOptions: [effort] } });
    else if (m.method === "session/load") {
      if (m.params.sessionId !== "known") { send({ id: m.id, error: { code: -32602, message: "Unknown sessionId" } }); continue; }
      update("known", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "an old reply" } });
      send({ id: m.id, result: { configOptions: [effort] } });
    }
    else if (m.method === "session/set_config_option") send({ id: m.id, result: { configOptions: [] } });
    else if (m.method === "session/prompt") {
      const sid = m.params.sessionId;
      // Pi's session file: an older reply, and this turn's two.
      const file = home + "/.pi/agent/sessions/s.jsonl";
      fs.mkdirSync(home + "/.pi/agent/sessions", { recursive: true });
      fs.mkdirSync(home + "/.pi/pi-acp", { recursive: true });
      const msg = (ts, usd) => JSON.stringify({ type: "message", id: "x", message: { role: "assistant", timestamp: ts, usage: { cost: { total: usd } } } });
      fs.writeFileSync(file, [JSON.stringify({ type: "session" }), msg(Date.now() - 3600000, 5), JSON.stringify({ type: "message", message: { role: "user", timestamp: Date.now() } }), msg(Date.now(), 0.25), msg(Date.now(), 0.5)].join("\\n") + "\\n");
      fs.writeFileSync(home + "/.pi/pi-acp/session-map.json", JSON.stringify({ version: 1, sessions: { [sid]: { sessionId: sid, sessionFile: file } } }));
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done: " + m.params.prompt.map((p) => p.text).join("") } });
      update(sid, { sessionUpdate: "usage_update", used: 50000, size: 200000, cost: { amount: 1.75, currency: "USD" } });
      send({ id: m.id, result: { stopReason: "end_turn" } });
    }
    else if (m.id !== undefined) send({ id: m.id, result: {} });
  }
});
`;

let dir = "";
let agent = "";
let log = "";
const savedHome = process.env.HOME;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "acp-resume-"));
  agent = path.join(dir, "run");
  log = path.join(dir, "requests.log");
  await writeFile(agent, AGENT);
  await chmod(agent, 0o755);
  process.env.FAKE_ACP_LOG = log;
  process.env.HOME = path.join(dir, "home");
  await mkdir(process.env.HOME, { recursive: true });
});
afterAll(async () => {
  process.env.HOME = savedHome;
  await rm(dir, { recursive: true, force: true });
});

async function turn(adapter: AcpAdapter, resume?: string, fallback?: string) {
  const events: RunEvent[] = [];
  for await (const e of adapter.start("the task", resume, fallback)) events.push(e);
  const sent = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  await writeFile(log, "");
  return { events, sent, text: events.filter((e) => e.kind === "text").map((e) => e.data).join("") };
}
const status = (events: RunEvent[], type: string) => events.filter((e) => e.kind === "status" && (e.data as any).type === type).map((e) => e.data as any);
const launch = (extra: object = {}) => ({ name: "Fake", command: agent, cwd: dir, resume: true, ...extra });

test("an agent that can resume continues its own session, without the old conversation in the prompt", async () => {
  const { events, sent, text } = await turn(new AcpAdapter(undefined, undefined, [], launch()), "known", "the task, with the history");
  expect(sent.map((r) => r.method)).toContain("session/load");
  expect(sent.some((r) => r.method === "session/new")).toBe(false);
  expect(status(events, "acp.session")).toEqual([{ type: "acp.session", sessionId: "known", resumed: true }]);
  // The replayed old reply isn't this turn's.
  expect(text).toBe("Done: the task");
});

test("a session that can't be loaded starts over, with the conversation in the prompt", async () => {
  const { events, sent, text } = await turn(new AcpAdapter(undefined, undefined, [], launch()), "gone", "the task, with the history");
  expect(sent.map((r) => r.method)).toEqual(expect.arrayContaining(["session/load", "session/new"]));
  expect(status(events, "acp.resume_failed")[0].message).toContain("Unknown sessionId");
  expect(status(events, "acp.session")).toEqual([{ type: "acp.session", sessionId: "new-1", resumed: false }]);
  expect(text).toBe("Done: the task, with the history");

  // An agent without native resume never tries.
  const plain = await turn(new AcpAdapter(undefined, undefined, [], launch({ resume: false })), "known", "fallback");
  expect(plain.sent.some((r) => r.method === "session/load")).toBe(false);
});

test("usage fills the context ring and reports the session's cost; effort goes through the agent's thinking option", async () => {
  const { events, sent, text } = await turn(new AcpAdapter(undefined, "high", [], launch()));
  expect(status(events, "context")).toEqual([{ type: "context", tokens: 50000, max: 200000, percentage: 25 }]);
  expect(status(events, "acp.cost")).toEqual([{ type: "acp.cost", sessionUsd: 1.75 }]);
  expect(sent.find((r) => r.method === "session/set_config_option")?.params).toEqual({ sessionId: "new-1", configId: "effort", value: "high" });
  expect(status(events, "efforts")).toEqual([{ type: "efforts", current: "high", options: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }] }]);

  // An effort the model doesn't have is said, and the turn goes on.
  const odd = await turn(new AcpAdapter(undefined, "max", [], launch()));
  expect(odd.text).toContain(`This model has no "max" effort`);
  expect(odd.sent.some((r) => r.method === "session/set_config_option")).toBe(false);
});

test("Pi's turn cost is summed from its session file, counting only this turn's replies", async () => {
  const { events } = await turn(new AcpAdapter(undefined, undefined, [], launch({ cost: "pi-session" })));
  expect(status(events, "acp.cost")).toEqual([{ type: "acp.cost", sessionUsd: 1.75 }, { type: "acp.cost", turnUsd: 0.75 }]);
  // Nothing to read: no cost rather than a wrong one.
  expect(await piTurnCost("unknown-session", 0)).toBeNull();
});
