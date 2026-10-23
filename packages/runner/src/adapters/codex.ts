import type { RunAdapter } from "../adapter";
import { CodexSubagents } from "./codex-subagents";
import type { RunEvent } from "@repo/shared/run-event";
import { Codex, type ModelReasoningEffort, type ThreadEvent } from "@openai/codex-sdk";
import type { NormalizedEvent } from "./claude";
import { codexMcpConfig, type McpSpec } from "../mcp";

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

    constructor(private model?: string, private effort?: string, private mcp: McpSpec[] = []) {}

    async *start(task: string, resume?: string): AsyncIterable<RunEvent> {
        this.controller = new AbortController();
        // With an API key, calls go to Cloudly's gateway, which adds the real key.
        const codex = new Codex({ apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL, config: codexMcpConfig(this.mcp) });

        const threadOptions = {
            workingDirectory: "/workspace",
            skipGitRepoCheck: true,
            approvalPolicy: "never" as const,
            // Codex's own sandbox defaults to read-only here, so it couldn't write a
            // file. The Cloudly container (limits, egress proxy) is the sandbox.
            sandboxMode: "danger-full-access" as const,
            model: this.model,
            modelReasoningEffort: this.effort as ModelReasoningEffort | undefined,
        };
        const thread = resume
            ? codex.resumeThread(resume, threadOptions)
            : codex.startThread(threadOptions);

        let seq = 0;
        const { events } = await thread.runStreamed(task, { signal: this.controller.signal });
        const subagents = new CodexSubagents();
        if (resume) subagents.threadId = resume;

        // Main-thread events as they come, and every half second whatever the
        // subagents' own logs have added since.
        const it = events[Symbol.asyncIterator]();
        let next = it.next();
        for (;;) {
            const step = await Promise.race([next, Bun.sleep(500).then(() => null)]);
            for (const event of await subagents.poll().catch(() => [])) {
                yield { seq: seq++, ts: Date.now(), ...event };
            }
            if (step === null) continue;
            if (step.done) break;
            next = it.next();
            if (step.value.type === "thread.started") subagents.threadId = step.value.thread_id;
            for (const normalized of mapCodexEvent(step.value)) {
                yield { seq: seq++, ts: Date.now(), ...normalized };
            }
        }
        for (const event of await subagents.poll().catch(() => [])) {
            yield { seq: seq++, ts: Date.now(), ...event };
        }
    }

    async interrupt(): Promise<void> {
        this.controller?.abort();
    }
}
