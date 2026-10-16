import { test, expect } from "bun:test";
import { mapAcpUpdate } from "./acp";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

// Fixtures are cast through `unknown` since we only exercise the fields
// mapAcpUpdate actually reads, not the SDK's full required shape.

test("agent_message_chunk text block maps to text", () => {
    const update = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
    } as unknown as SessionUpdate;
    expect(mapAcpUpdate(update)).toEqual([{ kind: "text", data: "Hello" }]);
});

test("agent_message_chunk non-text block maps to raw", () => {
    const update = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "base64", mimeType: "image/png" },
    } as unknown as SessionUpdate;
    expect(mapAcpUpdate(update)).toEqual([
        { kind: "raw", data: { type: "image", data: "base64", mimeType: "image/png" } },
    ]);
});

test("agent_thought_chunk maps to a raw thought, not reply text", () => {
    const update = {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking..." },
    } as unknown as SessionUpdate;
    expect(mapAcpUpdate(update)).toEqual([{ kind: "raw", data: { thought: "thinking..." } }]);
});

test("tool_call maps to tool_call", () => {
    const update = {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Run ls",
        name: "Bash",
        status: "pending",
        rawInput: { command: "ls" },
    } as unknown as SessionUpdate;
    expect(mapAcpUpdate(update)).toEqual([
        {
            kind: "tool_call",
            data: { id: "t1", name: "Bash", title: "Run ls", status: "pending", input: { command: "ls" } },
        },
    ]);
});

test("tool_call_update maps to tool_result", () => {
    const update = {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ls output" } }],
        rawOutput: "ls output",
    } as unknown as SessionUpdate;
    expect(mapAcpUpdate(update)).toEqual([
        {
            kind: "tool_result",
            data: {
                id: "t1",
                status: "completed",
                content: [{ type: "content", content: { type: "text", text: "ls output" } }],
                output: "ls output",
            },
        },
    ]);
});

test("user_message_chunk produces no events", () => {
    const update = {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hi" },
    } as unknown as SessionUpdate;
    expect(mapAcpUpdate(update)).toEqual([]);
});

test("unrecognized update kind falls back to raw", () => {
    const update = { sessionUpdate: "plan", entries: [] } as unknown as SessionUpdate;
    expect(mapAcpUpdate(update)).toEqual([{ kind: "raw", data: update }]);
});

test("the agent's command list is passed on so the chat can offer it", () => {
    const update = {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "compress", description: "Compress the context" }, { name: "memory", description: "" }],
    } as unknown as SessionUpdate;
    expect(mapAcpUpdate(update)).toEqual([{ kind: "status", data: { type: "commands", slash_commands: ["compress", "memory"] } }]);
});

test("Gemini effort is written as a thinkingLevel override and removed when back to default", async () => {
    const { mkdtemp, readFile, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { writeGeminiEffort } = await import("./acp");
    const home = await mkdtemp(path.join(tmpdir(), "gemini-effort-"));
    await mkdir(path.join(home, ".gemini"), { recursive: true });
    await writeFile(path.join(home, ".gemini", "settings.json"), JSON.stringify({ ui: { theme: "x" } }));

    await writeGeminiEffort("low", home);
    let s = JSON.parse(await readFile(path.join(home, ".gemini", "settings.json"), "utf8"));
    expect(s.ui).toEqual({ theme: "x" });
    expect(s.modelConfigs.customOverrides).toEqual([
        { match: { model: "chat-base-3" }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: "LOW" } } } },
    ]);

    await writeGeminiEffort("high", home);
    s = JSON.parse(await readFile(path.join(home, ".gemini", "settings.json"), "utf8"));
    expect(s.modelConfigs.customOverrides.map((o: any) => o.modelConfig.generateContentConfig.thinkingConfig.thinkingLevel)).toEqual(["HIGH"]);

    await writeGeminiEffort(undefined, home);
    s = JSON.parse(await readFile(path.join(home, ".gemini", "settings.json"), "utf8"));
    expect(s.modelConfigs.customOverrides).toEqual([]);
});
