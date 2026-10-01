import type { RunAdapter } from "../adapter";
import type { RunEvent } from "@repo/shared/run-event";
import { query, type SDKMessage, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";

const canUseTool: CanUseTool = async (_toolName, _input, options) => {
    return { behavior: "allow", toolUseID: options.toolUseID };
};

export type NormalizedEvent = Pick<RunEvent, "kind" | "data">;

export function mapClaudeMessage(message: SDKMessage): NormalizedEvent[] {
    switch (message.type) {
        case "system":
            return [{ kind: "status", data: message }];

        case "assistant": {
            const events: NormalizedEvent[] = [];
            for (const block of message.message.content) {
                if (block.type === "text") {
                    events.push({ kind: "text", data: block.text });
                } else if (block.type === "tool_use") {
                    events.push({
                        kind: "tool_call",
                        data: { id: block.id, name: block.name, input: block.input },
                    });
                }
            }
            return events;
        }

        case "user": {
            const events: NormalizedEvent[] = [];
            if (Array.isArray(message.message.content)) {
                for (const block of message.message.content) {
                    if (block.type === "tool_result") {
                        events.push({
                            kind: "tool_result",
                            data: { toolUseId: block.tool_use_id, content: block.content },
                        });
                    }
                }
            }
            return events;
        }

        case "result":
            if (message.subtype === "success") {
                return [{
                    kind: "done",
                    data: {
                        result: message.result,
                        sessionId: message.session_id,
                        totalCostUsd: message.total_cost_usd,
                    },
                }];
            }
            return [{
                kind: "error",
                data: { subtype: message.subtype, errors: message.errors },
            }];

        default:
            return [{ kind: "raw", data: message }];
    }
}

export class ClaudeAdapter implements RunAdapter {
    private controller?: AbortController;

    async *start(
        task: string,
        resume?: string
    ): AsyncIterable<RunEvent> {
        this.controller = new AbortController();

        let seq = 0;

        for await (const message of query({
            prompt: task,
            options: {
                cwd: "/workspace",
                permissionMode: "default",
                canUseTool,
                disallowedTools: ["Bash(git push *)"],
                maxTurns: 5,
                maxBudgetUsd: 20,
                resume,
                abortController: this.controller,
            },
        })) {
            for (const event of mapClaudeMessage(message)) {
                yield { seq: seq++, ts: Date.now(), ...event };
            }
        }
    }

    async interrupt(): Promise<void> {
        this.controller?.abort();
    }
}
