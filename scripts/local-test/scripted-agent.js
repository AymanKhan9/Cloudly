#!/usr/bin/env node
// A scripted ACP agent, for testing Cloudly end to end without a model or a key.
// Add it under Settings > Agents > By command (see README.md). It does what the
// last [[ ... ]] block in its prompt says, one step per ";":
//
//   write PATH=TEXT    append PATH=TEXT    rm PATH    (\n in TEXT is a newline)
//   run COMMAND        say TEXT            think TEXT     rich      artifacts
//   slow SECONDS       fail MESSAGE        ask QUESTION   call SERVER.TOOL {json}
//   recall             (lists the messages this session has had)
//
// It also does Cloudly's own jobs when the prompt asks for them: a plan
// (plan.json), a review or audit (findings.json), a council answer
// (answer.md) and lessons (lessons.json). Session history is kept in its HOME,
// so session/load resumes a session the way real agents do.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execSync } = require("node:child_process");

const STATE_DIR = path.join(os.homedir(), ".scripted-agent");
fs.mkdirSync(STATE_DIR, { recursive: true });
const MODELS = [
  { value: "scripted-fast", name: "Scripted Fast" },
  { value: "scripted-smart", name: "Scripted Smart" },
];
const EFFORTS = [
  { value: "low", name: "Low" },
  { value: "high", name: "High" },
];

const sessions = new Map();
let buf = "";
let active = null; // { id, cancelled }

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const reply = (id, result) => send({ id, result });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const text = (sessionId, t) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load(id) {
  if (sessions.has(id)) return sessions.get(id);
  const file = path.join(STATE_DIR, id + ".json");
  const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { id, cwd: "/workspace", history: [], model: MODELS[0].value, effort: "low" };
  sessions.set(id, s);
  return s;
}
const persist = (s) => fs.writeFileSync(path.join(STATE_DIR, s.id + ".json"), JSON.stringify(s));

function configOptions(s) {
  return [
    { id: "model", name: "Model", type: "select", category: "model", currentValue: s.model, options: MODELS },
    { id: "effort", name: "Effort", type: "select", category: "thought_level", currentValue: s.effort, options: EFFORTS },
  ];
}

let toolSeq = 0;
async function tool(s, title, kind, input, fn) {
  const toolCallId = "t" + ++toolSeq;
  update(s.id, { sessionUpdate: "tool_call", toolCallId, title, kind, status: "in_progress", rawInput: input });
  let out;
  let failed = false;
  try {
    out = await fn();
  } catch (err) {
    out = String(err && err.message ? err.message : err);
    failed = true;
  }
  update(s.id, { sessionUpdate: "tool_call_update", toolCallId, status: failed ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text: String(out ?? "").slice(0, 4000) } }] });
  return out;
}

const unescape = (t) => t.replace(/\\n/g, "\n").trim();
function steps(prompt) {
  const blocks = [...prompt.matchAll(/\[\[([\s\S]*?)\]\]/g)];
  if (!blocks.length) return null;
  return blocks[blocks.length - 1][1].split(/;(?![^{]*\})/).map((x) => x.trim()).filter(Boolean);
}

/** A minimal MCP client for one tools/call, over stdio or HTTP. */
async function callMcp(server, name, args) {
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scripted-agent", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
  ];
  if (server.url) {
    let session;
    let result;
    for (const m of msgs) {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
        body: JSON.stringify(m),
      });
      session = res.headers.get("mcp-session-id") || session;
      const body = await res.text();
      const data = body.trim().startsWith("{") ? body : body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop();
      if (m.id === 2) result = data ? JSON.parse(data) : { error: { message: `HTTP ${res.status}` } };
    }
    return result;
  }
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries((server.env || []).map((e) => [e.name, e.value]));
    const p = spawn(server.command, server.args || [], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === 2) {
            p.kill();
            resolve(m);
          }
        } catch {}
      }
    });
    p.on("error", reject);
    for (const m of msgs) p.stdin.write(JSON.stringify(m) + "\n");
    setTimeout(() => (p.kill(), reject(new Error("MCP server didn't answer"))), 15000);
  });
}

const RICH = [
  "Here's what I found.",
  "",
  "| File | Lines | Status |",
  "| --- | ---: | --- |",
  "| src/app.js | 42 | changed |",
  "| README.md | 7 | unchanged |",
  "",
  "```js",
  "export function greet(name) {",
  "  return `Hello, ${name}!`;",
  "}",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Request] --> B{Rate limit} -->|ok| C[Handler]",
  "  B -->|429| D[Retry-After]",
  "```",
  "",
  "The cost grows as $O(n \\log n)$, and in full:",
  "",
  "$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$",
  "",
].join("\n");

const PNG_CHART =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAVklEQVR42u3PQQqAMAwEwP7L3/noXhU8FnoIjYTqhJyWsGTatfk0AAAAgGeOsw+b++isHwAA4KuA6ENV9wAAAH8DRPO3+wEAAHYHZBVV5QAAAAAAS/kNqG3NPpOURp8AAAAASUVORK5CYII=";

function writeArtifacts(n) {
  const dir = "/artifacts";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.md"), `# Test report ${n}\n\nWritten ${new Date().toISOString()}.\n\n| Check | Result |\n| --- | --- |\n| Unit | passed |\n| Lint | passed |\n\n![chart](chart.png)\n`);
  fs.writeFileSync(path.join(dir, "latency.csv"), "day,p50,p95\nMon,120,340\nTue,110,300\nWed,130,420\nThu,90,260\nFri,100,280\n");
  fs.writeFileSync(path.join(dir, "dashboard.html"), `<!doctype html><title>Dashboard</title><body style="font:16px system-ui;padding:24px"><h1>Dashboard v${n}</h1><p id=t></p><script>document.getElementById('t').textContent='Rendered by a script at '+new Date().toISOString()</script></body>`);
  fs.writeFileSync(path.join(dir, "chart.png"), Buffer.from(PNG_CHART, "base64"));
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify({ version: n, ok: true }, null, 2));
}

/** Cloudly's own jobs, recognised from what the prompt asks for. */
async function cloudlyJob(s, prompt) {
  // Fix turns: the test repo's checks fail while a BROKEN file exists; the reviewer wants a summary line.
  if (/^Fix the failing (checks|CI)/m.test(prompt.split("\n").slice(-400).join("\n")) && prompt.lastIndexOf("Fix the failing") > prompt.lastIndexOf("[[")) {
    await tool(s, "Delete BROKEN", "delete", { path: "BROKEN" }, () => (fs.rmSync("BROKEN", { force: true }), "deleted"));
    text(s.id, "Fixed: the BROKEN marker made the test fail, so I removed it.");
    return true;
  }
  if (prompt.lastIndexOf("Fix the reviewer's findings") > prompt.lastIndexOf("[[")) {
    await tool(s, "Edit README.md", "edit", { path: "README.md" }, () => (fs.appendFileSync("README.md", "\nSummary: reviewed and fixed.\n"), "appended"));
    text(s.id, "Added the summary line the reviewer asked for.");
    return true;
  }
  if (prompt.includes("/workspace/.cloudly-plan/plan.json")) {
    await tool(s, "Write plan.json", "edit", {}, () => {
      fs.mkdirSync("/workspace/.cloudly-plan", { recursive: true });
      fs.writeFileSync(
        "/workspace/.cloudly-plan/plan.json",
        JSON.stringify({
          summary: "Two parts: the helper first, then the page that uses it.",
          tasks: [
            { key: "helper", title: "Add a greeting helper", prompt: "Add src/greet.js exporting greet(name). [[write src/greet.js=export const greet = (n) => `Hello, ${n}!`;\\n; say Added the helper.]]", dependsOn: [] },
            { key: "docs", title: "Document the helper", prompt: "Mention greet() in README.md. [[append README.md=\\n## greet\\nSee src/greet.js.\\n; say Documented it.]]", dependsOn: [] },
            { key: "page", title: "Use the helper on the page", prompt: "Use greet() in index.html. [[write public/hello.txt=Hello from the plan\\n; say Used it.]]", dependsOn: ["helper"] },
          ],
        }),
      );
      return "plan.json written";
    });
    text(s.id, "I wrote the plan: three tasks, the page waits for the helper.");
    return true;
  }
  if (prompt.includes("/workspace/.cloudly-review/findings.json")) {
    const audit = prompt.includes("Audit this repository");
    const findings = audit
      ? [
          { file: "src/app.js", line: 3, severity: "blocking", title: "Division by zero", body: "average() divides by the length without checking for an empty list." },
          { file: "src/app.js", line: 1, severity: "suggestion", title: "No input validation", body: "Check that the argument is an array." },
          { severity: "nit", title: "No tests for app.js", body: "Add a test." },
        ]
      : (() => {
          // A review: one blocking finding on round 1, none after, so the fix loop ends.
          const round = Number((prompt.match(/\(round (\d+)\)/) || [])[1] || 1);
          return round === 1 ? [{ file: "README.md", line: 1, severity: "blocking", title: "Missing trailing summary", body: "Add a summary line to the README." }] : [];
        })();
    await tool(s, "Write findings.json", "edit", {}, () => {
      fs.mkdirSync("/workspace/.cloudly-review", { recursive: true });
      fs.writeFileSync("/workspace/.cloudly-review/findings.json", JSON.stringify({ summary: findings.length ? `${findings.length} finding(s).` : "Looks good.", findings }));
      return "findings.json written";
    });
    text(s.id, findings.length ? `Found ${findings.length} thing(s) to look at.` : "No problems found.");
    return true;
  }
  if (prompt.includes("/workspace/.cloudly-council/answer.md")) {
    const round = (prompt.match(/round (\d+)/i) || [])[1] || "1";
    const chair = /chair/i.test(prompt) && /report/i.test(prompt);
    await tool(s, "Write answer.md", "edit", {}, () => {
      fs.mkdirSync("/workspace/.cloudly-council", { recursive: true });
      fs.writeFileSync(
        "/workspace/.cloudly-council/answer.md",
        chair
          ? `# Council report\n\n## Where they agree\n- Postgres is the safe default.\n\n## Where they differ\n- One prefers managed hosting, one self-hosting.\n`
          : `## Round ${round} answer from ${s.model}\n\n- Point one for round ${round}.\n- Point two, with a source: https://example.com/source-${round}\n`,
      );
      return "answer.md written";
    });
    text(s.id, `Answered round ${round}.`);
    return true;
  }
  if (prompt.includes("/workspace/.cloudly-lessons/lessons.json")) {
    const evidence = [...new Set([...prompt.matchAll(/\b([FRCKI]\d{1,3})\b/g)].map((m) => m[1]))].slice(0, 3);
    await tool(s, "Write lessons.json", "edit", {}, () => {
      fs.mkdirSync("/workspace/.cloudly-lessons", { recursive: true });
      fs.writeFileSync(
        "/workspace/.cloudly-lessons/lessons.json",
        JSON.stringify({ lessons: [{ title: "Keep the README summary", rule: "Every README change ends with a one-line summary of what changed.", why: "The reviewer flagged it each time.", evidence }] }),
      );
      return "lessons.json written";
    });
    text(s.id, "Proposed one lesson.");
    return true;
  }
  return false;
}

async function runSteps(s, prompt, cancelled) {
  if (await cloudlyJob(s, prompt)) return "end_turn";
  const list = steps(prompt);
  if (!list) {
    // No script: a small, real change, so a session has something to show.
    const n = s.history.length;
    await tool(s, "Read README.md", "read", { path: "README.md" }, () => (fs.existsSync("README.md") ? fs.readFileSync("README.md", "utf8").slice(0, 200) : "(none)"));
    await tool(s, `Edit notes/turn-${n}.md`, "edit", { path: `notes/turn-${n}.md` }, () => {
      fs.mkdirSync("notes", { recursive: true });
      fs.writeFileSync(`notes/turn-${n}.md`, `# Turn ${n}\n\n${prompt.split("\n").filter(Boolean).pop().slice(0, 300)}\n`);
      return "written";
    });
    text(s.id, `Done: I wrote notes/turn-${n}.md for "${prompt.split("\n").filter(Boolean).pop().slice(0, 80)}".`);
    return "end_turn";
  }
  for (const step of list) {
    if (cancelled()) return "cancelled";
    const [, verb, rest = ""] = step.match(/^(\w+)\s*([\s\S]*)$/) || [];
    switch (verb) {
      case "write":
      case "append": {
        const i = rest.indexOf("=");
        const file = rest.slice(0, i).trim();
        const body = unescape(rest.slice(i + 1)) + (verb === "write" ? "\n" : "");
        await tool(s, `${verb === "write" ? "Write" : "Edit"} ${file}`, "edit", { path: file }, () => {
          fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
          (verb === "write" ? fs.writeFileSync : fs.appendFileSync)(file, body);
          return `${body.length} bytes`;
        });
        break;
      }
      case "rm":
        await tool(s, `Delete ${rest}`, "delete", { path: rest }, () => (fs.rmSync(rest, { force: true }), "deleted"));
        break;
      case "run":
        await tool(s, rest, "execute", { command: rest }, () => {
          try {
            return execSync(rest, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
          } catch (e) {
            throw new Error((e.stdout || "") + (e.stderr || "") || e.message);
          }
        });
        break;
      case "say":
        text(s.id, unescape(rest) + "\n\n");
        break;
      case "think":
        update(s.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: unescape(rest) } });
        break;
      case "rich":
        text(s.id, RICH);
        break;
      case "artifacts":
        await tool(s, "Write artifacts", "edit", { dir: "/artifacts" }, () => (writeArtifacts(s.history.length), "5 files"));
        break;
      case "slow": {
        const secs = Number(rest) || 10;
        for (let i = 1; i <= secs; i++) {
          if (cancelled()) return "cancelled";
          text(s.id, `Working… ${i}/${secs}\n`);
          await sleep(1000);
        }
        break;
      }
      case "fail":
        throw new Error(unescape(rest) || "Scripted failure");
      case "ask":
        fs.writeFileSync("/ask/question.json", JSON.stringify({ question: unescape(rest) }));
        text(s.id, "I asked you a question; I'll wait for the answer.\n");
        break;
      case "recall":
        // What it was given: its own session's messages, and the conversation Cloudly sent with the prompt.
        text(s.id, `This session has had ${s.history.length} message(s):\n${s.history.map((h, i) => `${i + 1}. ${h}`).join("\n")}\n\nThe prompt I was given ends:\n\n${prompt.slice(-1500)}\n`);
        break;
      case "call": {
        const [, target, json = "{}"] = rest.match(/^(\S+)\s*([\s\S]*)$/) || [];
        const [serverName, toolName] = target.split(".");
        const server = (s.mcp || []).find((m) => m.name === serverName);
        await tool(s, `${serverName}.${toolName}`, "other", JSON.parse(json), async () => {
          if (!server) throw new Error(`No MCP server "${serverName}". Have: ${(s.mcp || []).map((m) => m.name).join(", ")}`);
          const r = await callMcp(server, toolName, JSON.parse(json));
          return JSON.stringify(r.result ?? r.error);
        });
        break;
      }
      default:
        text(s.id, `Unknown step: ${step}\n`);
    }
  }
  return "end_turn";
}

async function onPrompt(m) {
  const s = load(m.params.sessionId);
  const prompt = (m.params.prompt || []).map((b) => b.text || "").join("");
  const last = (prompt.split(/\n/).filter((l) => l.trim()).pop() || "").slice(0, 200);
  s.history.push(last);
  persist(s);
  const turn = { id: m.id, cancelled: false };
  active = turn;
  try {
    process.chdir(s.cwd);
    const stop = await runSteps(s, prompt, () => turn.cancelled);
    send({ id: m.id, result: { stopReason: turn.cancelled ? "cancelled" : stop } });
  } catch (err) {
    send({ id: m.id, error: { code: -32603, message: "Internal error: " + (err && err.message ? err.message : String(err)) } });
  } finally {
    if (active === turn) active = null;
  }
}

function handle(m) {
  switch (m.method) {
    case "initialize":
      return reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: {} }, authMethods: [] });
    case "session/new": {
      const id = "s-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const s = load(id);
      s.cwd = m.params.cwd || s.cwd;
      s.mcp = m.params.mcpServers || [];
      persist(s);
      return reply(m.id, { sessionId: id, configOptions: configOptions(s) });
    }
    case "session/load": {
      const s = load(m.params.sessionId);
      s.cwd = m.params.cwd || s.cwd;
      s.mcp = m.params.mcpServers || [];
      persist(s);
      for (const h of s.history) update(s.id, { sessionUpdate: "user_message_chunk", content: { type: "text", text: h } });
      return reply(m.id, { configOptions: configOptions(s) });
    }
    case "session/set_config_option": {
      const s = load(m.params.sessionId);
      if (m.params.configId === "model") {
        if (!MODELS.some((x) => x.value === m.params.value)) return send({ id: m.id, error: { code: -32602, message: `No model ${m.params.value}` } });
        s.model = m.params.value;
      } else if (m.params.configId === "effort") s.effort = m.params.value;
      persist(s);
      return reply(m.id, { configOptions: configOptions(s) });
    }
    case "session/prompt":
      return void onPrompt(m);
    case "session/cancel":
      if (active) active.cancelled = true;
      return;
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}

process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch (err) {
      process.stderr.write(`scripted-agent: ${err}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
