import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GeminiSubagents, mapChatLine, reportText } from "./gemini-subagents";
import { mapAcpUpdate } from "./acp";

// Shapes copied from a real Gemini CLI 0.63 subagent chat log (trimmed).
const call = (id: string, name: string, args: object, output: string) => ({
    id, name, args, status: "success",
    result: [{ functionResponse: { id, name, response: { output } } }],
});
const listing = JSON.stringify({ type: "gemini", toolCalls: [call("list_directory__call_1", "list_directory", { dir_path: "/workspace/src" }, "cli.py\ntotals.py")] });
const finish = JSON.stringify({
    type: "gemini",
    toolCalls: [call("complete_task__call_2", "complete_task", { report: { ExplorationTrace: ["Listed src"], SummaryOfFindings: "Two modules." } }, "Output submitted and task completed.")],
});

test("invoke_agent becomes an Agent call named after the subagent", () => {
    const update = { sessionUpdate: "tool_call", toolCallId: "invoke_agent__call_9", title: "Delegating to agent 'codebase_investigator'", status: "in_progress" } as any;
    expect(mapAcpUpdate(update)).toEqual([
        { kind: "tool_call", data: { id: "invoke_agent__call_9", name: "Agent", input: { subagent_type: "codebase_investigator", description: "" } } },
    ]);
});

test("a subagent's tool calls are tagged, repeats skipped, and complete_task is its report", () => {
    const seen = new Set<string>();
    const first = mapChatLine(listing, "invoke_agent__call_9", seen);
    expect(first.map((e) => [e.kind, e.data.parent])).toEqual([["tool_call", "invoke_agent__call_9"], ["tool_result", "invoke_agent__call_9"]]);
    expect(mapChatLine(listing, "invoke_agent__call_9", seen)).toEqual([]);
    expect(mapChatLine(finish, "invoke_agent__call_9", seen)).toEqual([
        { kind: "tool_result", data: { id: "invoke_agent__call_9", status: "completed", content: "Two modules." } },
    ]);
    expect(reportText("plain")).toBe("plain");
});

test("logs pair with invoke_agent calls in order, only for this session", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "gemini-sub-"));
    process.env.HOME = home;
    const chats = path.join(home, ".gemini", "tmp", "workspace", "chats");
    await mkdir(path.join(chats, "main-session"), { recursive: true });
    await mkdir(path.join(chats, "other-session"), { recursive: true });
    const watcher = new GeminiSubagents();
    watcher.sessionId = "main-session";

    const meta = JSON.stringify({ sessionId: "sub-1", kind: "subagent" }) + "\n";
    await writeFile(path.join(chats, "main-session", "sub-1.jsonl"), meta + listing + "\n");
    await writeFile(path.join(chats, "other-session", "sub-x.jsonl"), meta + listing + "\n");
    expect(await watcher.poll()).toEqual([]); // no invoke_agent call yet

    watcher.delegated("invoke_agent__call_9");
    expect((await watcher.poll()).map((e) => e.data.parent)).toEqual(["invoke_agent__call_9", "invoke_agent__call_9"]);
    await appendFile(path.join(chats, "main-session", "sub-1.jsonl"), finish + "\n");
    expect(await watcher.poll()).toEqual([{ kind: "tool_result", data: { id: "invoke_agent__call_9", status: "completed", content: "Two modules." } }]);
});
