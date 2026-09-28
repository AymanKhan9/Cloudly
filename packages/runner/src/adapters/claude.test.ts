import { test, expect } from "bun:test";
import { mapClaudeMessage } from "./claude";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Fixtures are cast through `unknown` since we only exercise the fields
// mapClaudeMessage actually reads, not the SDK's full required shape.

test("system message maps to status", () => {
    const msg = { type: "system", subtype: "init" } as unknown as SDKMessage;
    expect(mapClaudeMessage(msg)).toEqual([{ kind: "status", data: msg }]);
});

test("assistant text block maps to text", () => {
    const msg = {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
    } as unknown as SDKMessage;
    expect(mapClaudeMessage(msg)).toEqual([{ kind: "text", data: "Hello" }]);
});

test("assistant tool_use block maps to tool_call", () => {
    const msg = {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
    } as unknown as SDKMessage;
    expect(mapClaudeMessage(msg)).toEqual([
        { kind: "tool_call", data: { id: "t1", name: "Bash", input: { command: "ls" } } },
    ]);
});

test("assistant message with multiple blocks maps to multiple events", () => {
    const msg = {
        type: "assistant",
        message: {
            content: [
                { type: "text", text: "Running a command" },
                { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
            ],
        },
    } as unknown as SDKMessage;
    expect(mapClaudeMessage(msg)).toEqual([
        { kind: "text", data: "Running a command" },
        { kind: "tool_call", data: { id: "t1", name: "Bash", input: { command: "ls" } } },
    ]);
});

test("user tool_result block maps to tool_result", () => {
    const msg = {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ls output" }] },
    } as unknown as SDKMessage;
    expect(mapClaudeMessage(msg)).toEqual([
        { kind: "tool_result", data: { toolUseId: "t1", content: "ls output" } },
    ]);
});

test("result success maps to done", () => {
    const msg = {
        type: "result",
        subtype: "success",
        result: "done!",
        session_id: "s1",
        total_cost_usd: 0.01,
    } as unknown as SDKMessage;
    expect(mapClaudeMessage(msg)).toEqual([
        { kind: "done", data: { result: "done!", sessionId: "s1", totalCostUsd: 0.01 } },
    ]);
});

test("result error_max_turns maps to error", () => {
    const msg = {
        type: "result",
        subtype: "error_max_turns",
        errors: ["hit max turns"],
    } as unknown as SDKMessage;
    expect(mapClaudeMessage(msg)).toEqual([
        { kind: "error", data: { subtype: "error_max_turns", errors: ["hit max turns"] } },
    ]);
});

test("unrecognized message type falls back to raw", () => {
    const msg = { type: "hook_started" } as unknown as SDKMessage;
    expect(mapClaudeMessage(msg)).toEqual([{ kind: "raw", data: msg }]);
});
