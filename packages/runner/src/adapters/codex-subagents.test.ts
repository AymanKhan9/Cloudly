import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexSubagents, mapRolloutLine } from "./codex-subagents";

// Shapes copied from a real Codex 0.162 subagent rollout (trimmed).
const meta = (id: string, parent: string, task: string) =>
    JSON.stringify({ type: "session_meta", payload: { id, source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: `/root/${task}`, agent_nickname: "Locke", agent_role: null } } } } });
const command = JSON.stringify({
    type: "event_msg",
    payload: { type: "item_completed", item: { type: "CommandExecution", id: "exec-1", command: ["/bin/bash", "-lc", "rg --files src"], aggregated_output: "src/cli.py\n", exit_code: 0 } },
});
const done = JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Found 2 files." } });

test("a subagent's command and report map to tagged events", () => {
    expect(mapRolloutLine(command, "child")).toEqual([
        { kind: "tool_call", data: { id: "exec-1", type: "command_execution", command: "rg --files src", parent: "child" } },
        { kind: "tool_result", data: { id: "exec-1", type: "command_execution", exit_code: 0, aggregated_output: "src/cli.py\n", parent: "child" } },
    ]);
    expect(mapRolloutLine(done, "child")).toEqual([{ kind: "tool_result", data: { toolUseId: "child", content: "Found 2 files." } }]);
    expect(mapRolloutLine("not json", "child")).toEqual([]);
});

test("follows only this thread's subagents, and lines as they are written", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "codex-sub-"));
    const day = path.join(home, "sessions", "2026", "10", "15");
    await mkdir(day, { recursive: true });
    process.env.CODEX_HOME = home;
    const watcher = new CodexSubagents();
    watcher.threadId = "main";

    await writeFile(path.join(day, "a.jsonl"), meta("child", "main", "python_inventory") + "\n");
    await writeFile(path.join(day, "b.jsonl"), meta("other", "someone-else", "x") + "\n" + command + "\n");
    const first = await watcher.poll();
    expect(first).toEqual([{ kind: "tool_call", data: { id: "child", name: "Agent", input: { subagent_type: "Locke", description: "python inventory" } } }]);

    // Half a line written so far: nothing yet; the rest arrives next poll.
    await appendFile(path.join(day, "a.jsonl"), command.slice(0, 40));
    expect(await watcher.poll()).toEqual([]);
    await appendFile(path.join(day, "a.jsonl"), command.slice(40) + "\n" + done + "\n");
    expect((await watcher.poll()).map((e) => e.kind)).toEqual(["tool_call", "tool_result", "tool_result"]);
});
