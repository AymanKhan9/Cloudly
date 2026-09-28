import { test, expect } from "bun:test";
import { mapCodexEvent } from "./codex";
import type { ThreadEvent } from "@openai/codex-sdk";

test("thread.started maps to status", () => {
    const event = { type: "thread.started", thread_id: "abc" } as ThreadEvent;
    expect(mapCodexEvent(event)).toEqual([{ kind: "status", data: event }]);
});

test("agent_message item.completed maps to text", () => {
    const event = {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Hello!" },
    } as ThreadEvent;
    expect(mapCodexEvent(event)).toEqual([{ kind: "text", data: "Hello!" }]);
});

test("command_execution item.started maps to tool_call", () => {
    const item = { id: "item_1", type: "command_execution", command: "ls -la", aggregated_output: "", status: "in_progress" };
    const event = { type: "item.started", item } as ThreadEvent;
    expect(mapCodexEvent(event)).toEqual([{ kind: "tool_call", data: item }]);
});

test("command_execution item.completed maps to tool_result", () => {
    const item = { id: "item_1", type: "command_execution", command: "ls -la", aggregated_output: "a\nb\n", exit_code: 0, status: "completed" };
    const event = { type: "item.completed", item } as ThreadEvent;
    expect(mapCodexEvent(event)).toEqual([{ kind: "tool_result", data: item }]);
});

test("turn.completed maps to done", () => {
    const event = { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } } as ThreadEvent;
    expect(mapCodexEvent(event)).toEqual([{ kind: "done", data: event }]);
});

test("turn.failed maps to error with the inner error object", () => {
    const event = { type: "turn.failed", error: { message: "something broke" } } as ThreadEvent;
    expect(mapCodexEvent(event)).toEqual([{ kind: "error", data: { message: "something broke" } }]);
});

test("todo_list item.completed maps to status", () => {
    const item = { id: "item_2", type: "todo_list", items: [{ text: "step 1", completed: true }] };
    const event = { type: "item.completed", item } as ThreadEvent;
    expect(mapCodexEvent(event)).toEqual([{ kind: "status", data: item }]);
});

test("top-level error event maps to error", () => {
    const event = { type: "error", message: "fatal" } as ThreadEvent;
    expect(mapCodexEvent(event)).toEqual([{ kind: "error", data: event }]);
});
