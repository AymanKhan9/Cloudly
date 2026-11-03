import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AcpAdapter } from "./acp";
import { steerPrompt } from "../adapter";
import type { RunEvent } from "@repo/shared/run-event";

// A slow agent: each prompt says what it's working on, then takes a few seconds,
// unless it's cancelled, which ends the prompt at once.
const AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.FAKE_ACP_LOG;
let buf = "";
let pending = null;
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    fs.appendFileSync(log, JSON.stringify({ method: m.method, params: m.params }) + "\\n");
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "s-1" } });
    else if (m.method === "session/prompt") {
      const text = m.params.prompt.map((b) => b.text).join("");
      send({ method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working on: " + text.split("\\n").pop() + "|" } } } });
      const id = m.id;
      const timer = setTimeout(() => { pending = null; send({ id, result: { stopReason: "end_turn" } }); }, 2500);
      pending = { id, timer };
    } else if (m.method === "session/cancel" && pending) {
      clearTimeout(pending.timer);
      send({ id: pending.id, result: { stopReason: "cancelled" } });
      pending = null;
    }
  }
});
`;

let dir = "";
let agent = "";
let log = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "steer-"));
  agent = path.join(dir, "agent.js");
  log = path.join(dir, "log.jsonl");
  await writeFile(agent, AGENT);
  await chmod(agent, 0o755);
  process.env.FAKE_ACP_LOG = log;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a message mid-turn stops the agent's prompt and carries on with it, in the same session", async () => {
  const adapter = new AcpAdapter(undefined, undefined, [], { name: "Fake", command: agent, cwd: dir } as never);
  const events: RunEvent[] = [];
  let steered = false;
  for await (const e of adapter.start("write the parser")) {
    events.push(e);
    if (!steered && e.kind === "text") {
      steered = true;
      expect(adapter.steer("use tabs, not spaces")).toBe(true);
    }
  }
  const text = events.filter((e) => e.kind === "text").map((e) => e.data).join("");
  expect(text).toBe("working on: write the parser|working on: use tabs, not spaces|");
  // One "done" for the whole turn, at the end.
  expect(events.filter((e) => e.kind === "done")).toHaveLength(1);
  expect(events.at(-1)?.kind).toBe("done");
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const prompts = calls.filter((c) => c.method === "session/prompt");
  expect(prompts).toHaveLength(2);
  expect(prompts[1].params.sessionId).toBe("s-1");
  expect(prompts[1].params.prompt[0].text).toBe(steerPrompt(["use tabs, not spaces"]));
  expect(calls.filter((c) => c.method === "session/cancel")).toHaveLength(1);
  // Once the turn is over, a message waits for the next turn.
  expect(adapter.steer("too late")).toBe(false);
}, 20_000);

test("the runner picks up a message from the control folder and says the agent took it", async () => {
  const control = await mkdtemp(path.join(tmpdir(), "control-"));
  await Bun.write(path.join(control, "config.json"), JSON.stringify({ task: "write the parser", harness: "acp-fake", acp: { name: "Fake", command: agent, cwd: dir } }));
  const steerDir = path.join(control, "steer");
  await Bun.$`mkdir -p ${steerDir}`;
  const proc = Bun.spawn(["bun", path.resolve(import.meta.dir, "../index.ts")], {
    env: { ...process.env, CONTROL_CONFIG_PATH: path.join(control, "config.json"), CONTROL_STEER_DIR: steerDir, FAKE_ACP_LOG: log },
    stdout: "pipe", stderr: "pipe",
  });
  setTimeout(() => void Bun.write(path.join(steerDir, "1-m1.json"), JSON.stringify({ id: "m1", text: "also handle empty input" })), 1200);
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const events = out.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  const steer = events.find((e) => e.data?.type === "steer");
  expect(steer).toMatchObject({ kind: "status", data: { id: "m1", text: "also handle empty input" } });
  const text = events.filter((e) => e.kind === "text").map((e) => e.data).join("");
  expect(text).toContain("working on: also handle empty input|");
  expect(events.at(-1)?.kind).toBe("done");
  await rm(control, { recursive: true, force: true });
}, 30_000);

test("a trial installs the new version first, then runs it from there", async () => {
  const control = await mkdtemp(path.join(tmpdir(), "control-"));
  const trialDir = path.join(dir, "trial-agent");
  const preinstall = `set -e\nmkdir -p '${trialDir}'\ncp '${agent}' '${trialDir}/run'\nchmod 755 '${trialDir}/run'`;
  await Bun.write(path.join(control, "config.json"), JSON.stringify({ task: "try me", harness: "acp-fake", acp: { name: "Fake", command: `${trialDir}/run`, cwd: dir, preinstall } }));
  const proc = Bun.spawn(["bun", path.resolve(import.meta.dir, "../index.ts")], {
    env: { ...process.env, CONTROL_CONFIG_PATH: path.join(control, "config.json"), CONTROL_STEER_DIR: path.join(control, "steer"), FAKE_ACP_LOG: log },
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  const events = out.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  expect(events[0]).toMatchObject({ kind: "status", data: { type: "trial.install", name: "Fake" } });
  expect(events.filter((e) => e.kind === "text").map((e) => e.data).join("")).toBe("working on: try me|");

  // An install that fails ends the run with why.
  await Bun.write(path.join(control, "config.json"), JSON.stringify({ task: "x", harness: "acp-fake", acp: { name: "Fake", command: "/nope", cwd: dir, preinstall: "echo 'npm ERR! 404 Not Found' >&2; exit 1" } }));
  const bad = Bun.spawn(["bun", path.resolve(import.meta.dir, "../index.ts")], { env: { ...process.env, CONTROL_CONFIG_PATH: path.join(control, "config.json") }, stdout: "pipe", stderr: "pipe" });
  const badOut = await new Response(bad.stdout).text();
  expect(await bad.exited).toBe(1);
  expect(badOut).toContain("The new version of Fake didn't install: npm ERR! 404 Not Found");
  await rm(control, { recursive: true, force: true });
}, 30_000);
