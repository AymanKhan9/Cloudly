import type { RunAdapter } from "../adapter";
import type { RunEvent } from "@repo/shared/run-event";
import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import type { NormalizedEvent } from "./claude";

export function mapCodexEvent(event: ThreadEvent): NormalizedEvent[] {
    switch (event.type) {
        case "thread.started":
        case "turn.started":
            return [{ kind: "status", data: event }];

        case "turn.completed":
            return [{ kind: "done", data: event }];

        case "turn.failed":
            return [{ kind: "error", data: event.error }];

        case "item.started":
        case "item.updated":
            if (event.item.type === "command_execution") {
                return [{ kind: "tool_call", data: event.item }];
            }
            return [{ kind: "raw", data: event }];

        case "item.completed":
            switch (event.item.type) {
                case "agent_message":
                case "reasoning":
                    return [{ kind: "text", data: event.item.text }];
                case "command_execution":
                case "file_change":
                case "mcp_tool_call":
                case "web_search":
                    return [{ kind: "tool_result", data: event.item }];
                case "todo_list":
                    return [{ kind: "status", data: event.item }];
                case "error":
                    return [{ kind: "error", data: event.item }];
                default:
                    return [{ kind: "raw", data: event }];
            }

        case "error":
            return [{ kind: "error", data: event }];

        default:
            return [{ kind: "raw", data: event }];
    }
}

export class CodexAdapter implements RunAdapter {
    private controller?: AbortController;

    async *start(task: string, resume?: string): AsyncIterable<RunEvent> {
        this.controller = new AbortController();
        const codex = new Codex();

        const threadOptions = {
            workingDirectory: "/workspace",
            skipGitRepoCheck: true,
            approvalPolicy: "never" as const,
        };
        const thread = resume
            ? codex.resumeThread(resume, threadOptions)
            : codex.startThread(threadOptions);

        let seq = 0;
        const { events } = await thread.runStreamed(task, { signal: this.controller.signal });

        for await (const event of events) {
            for (const normalized of mapCodexEvent(event)) {
                yield { seq: seq++, ts: Date.now(), ...normalized };
            }
        }
    }

    async interrupt(): Promise<void> {
        this.controller?.abort();
    }
}
