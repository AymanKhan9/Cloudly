import { test, expect } from "bun:test";
import { parseSession, rewriteCwd, importedHistory, canResumeNatively, githubRepoFromUrl, type ParsedSession } from "../src/session-import";

const lines = (...xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
const ok = (r: ParsedSession | { error: string }) => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

test("Claude Code: turns on the current branch, tools, commands and compaction", () => {
  const base = { sessionId: "6f1c2b9e-0000-4000-8000-000000000001", cwd: "/Users/me/app", gitBranch: "fix-login", isSidechain: false };
  const file = lines(
    { type: "summary", summary: "Fix the login redirect", leafUuid: "x" },
    { ...base, type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "The login page redirects in a loop. Fix it." } },
    { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Looking at the middleware." }] } },
    { ...base, type: "assistant", uuid: "a2", parentUuid: "a1", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/Users/me/app/src/auth.ts" } }] } },
    { ...base, type: "user", uuid: "r1", parentUuid: "a2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] } },
    { ...base, type: "assistant", uuid: "a3", parentUuid: "r1", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "bun test auth" } }, { type: "text", text: "Fixed: the cookie check ran before the session loaded." }] } },
    // A rewound branch: this message was abandoned (nothing descends from it).
    { ...base, type: "user", uuid: "old", parentUuid: "a3", message: { role: "user", content: "abandoned idea" } },
    { ...base, type: "user", uuid: "m1", parentUuid: "a3", isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" } },
    { ...base, type: "user", uuid: "c1", parentUuid: "m1", message: { role: "user", content: "<command-name>/compact</command-name>\n<command-args>keep auth</command-args>" } },
    { ...base, type: "system", subtype: "compact_boundary", uuid: "b1", parentUuid: null, logicalParentUuid: "c1" },
    { ...base, type: "user", uuid: "s1", parentUuid: "b1", isCompactSummary: true, message: { role: "user", content: "Summary: fixed the redirect loop." } },
    { ...base, type: "user", uuid: "u2", parentUuid: "s1", message: { role: "user", content: "Now add a test for it." } },
    { ...base, type: "assistant", uuid: "a4", parentUuid: "u2", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } },
    { ...base, type: "assistant", uuid: "a5", parentUuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "Added tests/auth.test.ts." }] } },
  );
  const s = ok(parseSession("6f1c.jsonl", file));
  expect(s.source).toBe("claude-code");
  expect(s.sessionId).toBe(base.sessionId);
  expect(s.cwd).toBe("/Users/me/app");
  expect(s.gitBranch).toBe("fix-login");
  expect(s.title).toBe("Fix the login redirect");
  expect(s.summary).toBe("Summary: fixed the redirect loop.");
  expect(s.turns.map((t) => t.prompt)).toEqual(["The login page redirects in a loop. Fix it.", "/compact keep auth", "Now add a test for it."]);
  expect(s.turns[0]!.steps).toEqual([
    { t: "text", text: "Looking at the middleware." },
    { t: "tool", title: "Read /Users/me/app/src/auth.ts" },
    { t: "tool", title: "Bash bun test auth" },
    { t: "text", text: "Fixed: the cookie check ran before the session loaded." },
  ]);
  expect(s.turns[2]!.steps).toEqual([{ t: "text", text: "Added tests/auth.test.ts." }]);
  expect(canResumeNatively(s)).toBe(true);
});

test("Codex: typed prompts, not its own context; tools; git details", () => {
  const file = lines(
    { timestamp: "t", type: "session_meta", payload: { id: "0199a1b2-c3d4", cwd: "/home/me/api", git: { branch: "main", repository_url: "git@github.com:acme/api.git" } } },
    { timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/home/me/api</cwd>\n</environment_context>" }] } },
    { timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add rate limiting" }] } },
    { timestamp: "t", type: "event_msg", payload: { type: "user_message", message: "Add rate limiting" } },
    { timestamp: "t", type: "response_item", payload: { type: "reasoning", summary: [] } },
    { timestamp: "t", type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "rg limiter"] }), call_id: "c1" } },
    { timestamp: "t", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "{}" } },
    { timestamp: "t", type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Add File: src/limit.ts\n+x\n*** Update File: src/app.ts\n*** End Patch" } },
    { timestamp: "t", type: "event_msg", payload: { type: "agent_message", message: "Done: 100 requests a minute." } },
    { timestamp: "t", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done: 100 requests a minute." }] } },
  );
  const s = ok(parseSession("rollout-2026-11-01T10-00-00-0199a1b2-c3d4.jsonl", file));
  expect(s.source).toBe("codex");
  expect(s.sessionId).toBe("0199a1b2-c3d4");
  expect(githubRepoFromUrl(s.repoUrl)).toBe("acme/api");
  expect(s.turns).toEqual([
    {
      prompt: "Add rate limiting",
      steps: [
        { t: "tool", title: "Bash bash -lc rg limiter" },
        { t: "tool", title: "Edit src/limit.ts, src/app.ts" },
        { t: "text", text: "Done: 100 requests a minute." },
      ],
    },
  ]);
});

test("Pi: follows the current branch of its tree, with compaction summaries", () => {
  const file = lines(
    { type: "session", version: 3, id: "pi-123", timestamp: "t", cwd: "/work/site" },
    { type: "message", id: "s0", parentId: null, timestamp: "t", message: { role: "system", content: "", sections: {} } },
    { type: "message", id: "u1", parentId: "s0", timestamp: "t", message: { role: "user", content: "Make the header sticky" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "t", message: { role: "assistant", content: [{ type: "toolCall", id: "x", name: "edit", arguments: { path: "src/header.css" } }] } },
    { type: "message", id: "r1", parentId: "a1", timestamp: "t", message: { role: "toolResult", toolCallId: "x", content: [] } },
    { type: "message", id: "a2", parentId: "r1", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
    { type: "message", id: "u2", parentId: "a2", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "Try another way" }] } },
    { type: "branch_summary", id: "b1", parentId: "a2", timestamp: "t", fromId: "u2", summary: "Tried a fixed header." },
    { type: "message", id: "u3", parentId: "b1", timestamp: "t", message: { role: "user", content: "Keep it sticky but shorter" } },
    { type: "session_info", id: "i1", parentId: "u3", timestamp: "t", name: "Header work" },
  );
  const s = ok(parseSession("x.jsonl", file));
  expect(s.source).toBe("pi");
  expect(s.sessionId).toBe("pi-123");
  expect(s.title).toBe("Header work");
  expect(s.summary).toBe("Tried a fixed header.");
  expect(s.turns.map((t) => t.prompt)).toEqual(["Make the header sticky", "Keep it sticky but shorter"]);
  expect(s.turns[0]!.steps).toEqual([{ t: "tool", title: "edit src/header.css" }, { t: "text", text: "Done." }]);
});

test("Gemini CLI, OpenCode, chat JSON and plain text", () => {
  const gemini = ok(parseSession("session.json", JSON.stringify({
    sessionId: "g-1", projectHash: "h", messages: [
      { id: "1", type: "user", content: "Why is CI slow?" },
      { id: "2", type: "gemini", content: "The cache misses.", toolCalls: [{ name: "run_shell_command", args: { command: "cat ci.yml" } }] },
      { id: "3", type: "info", content: "noise" },
    ],
  })));
  expect(gemini.source).toBe("gemini");
  expect(gemini.turns[0]!.steps).toEqual([{ t: "text", text: "The cache misses." }, { t: "tool", title: "run_shell_command cat ci.yml" }]);
  expect(canResumeNatively(gemini)).toBe(false);

  const opencode = ok(parseSession("export.json", JSON.stringify({
    info: { id: "ses_1", title: "Dark mode", directory: "/p" },
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "Add dark mode" }, { type: "text", text: "ctx", synthetic: true }] },
      { info: { role: "assistant" }, parts: [{ type: "reasoning", text: "..." }, { type: "tool", tool: "edit", state: { input: { filePath: "app.css" } } }, { type: "text", text: "Added." }] },
    ],
  })));
  expect(opencode.source).toBe("opencode");
  expect(opencode.title).toBe("Dark mode");
  expect(opencode.turns).toEqual([{ prompt: "Add dark mode", steps: [{ t: "tool", title: "edit app.css" }, { t: "text", text: "Added." }] }]);

  const chat = ok(parseSession("chat.json", JSON.stringify({ messages: [
    { role: "system", content: "be nice" },
    { role: "user", content: [{ type: "text", text: "Hi" }] },
    { role: "assistant", content: "Hello", tool_calls: [{ function: { name: "grep", arguments: "{\"pattern\":\"TODO\"}" } }] },
  ] })));
  expect(chat.source).toBe("chat");
  expect(chat.turns).toEqual([{ prompt: "Hi", steps: [{ t: "text", text: "Hello" }, { t: "tool", title: "grep TODO" }] }]);

  const text = ok(parseSession("notes.md", "Context first.\n\n## User\nPlan the migration\n\n**Assistant:** Three steps.\nOne, two, three.\nUser: go"));
  expect(text.source).toBe("text");
  expect(text.summary).toBe("Context first.");
  expect(text.turns).toEqual([
    { prompt: "Plan the migration", steps: [{ t: "text", text: "Three steps.\nOne, two, three." }] },
    { prompt: "go", steps: [] },
  ]);

  const prose = ok(parseSession("notes.txt", "Pi is a small agent.\nNothing here is a conversation."));
  expect(prose.turns).toEqual([]);
  expect(prose.summary).toContain("Nothing here");

  expect(parseSession("x.jsonl", lines({ foo: 1 }, { bar: 2 }))).toHaveProperty("error");
  expect(parseSession("x", "  ")).toHaveProperty("error");
});

test("rewriting the directory, and the history an agent is given", () => {
  const raw = JSON.stringify({ cwd: "/Users/me/app", file: "/Users/me/app/src/a.ts", other: "/Users/me/app2/x", win: "C:\\code\\app\\b.ts" });
  expect(JSON.parse(rewriteCwd(raw, "/Users/me/app"))).toEqual({ cwd: "/workspace", file: "/workspace/src/a.ts", other: "/Users/me/app2/x", win: "C:\\code\\app\\b.ts" });
  expect(JSON.parse(rewriteCwd(raw, "C:\\code\\app")).win).toBe("/workspace\\b.ts");

  const turns = Array.from({ length: 40 }, (_, i) => ({ prompt: `ask ${i}`, reply: "x".repeat(1000), tools: i === 39 ? ["Bash ls", "Edit a.ts"] : [] }));
  const h = importedHistory(turns, "Earlier: set up the repo.", 10_000);
  expect(h.startsWith("Summary of the earliest part:\nEarlier: set up the repo.")).toBe(true);
  expect(h).toContain("earlier turns not shown");
  expect(h).toContain("User: ask 39");
  expect(h).toContain("(Bash ls; Edit a.ts)");
  expect(h).not.toContain("User: ask 0\n");
});
