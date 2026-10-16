import type { RunAdapter } from "../adapter";
import type { RunEvent } from "@repo/shared/run-event";
import { query, type SDKMessage, type SDKUserMessage, type CanUseTool, type EffortLevel } from "@anthropic-ai/claude-agent-sdk";

const canUseTool: CanUseTool = async (_toolName, _input, options) => {
    return { behavior: "allow", toolUseID: options.toolUseID };
};

export type NormalizedEvent = Pick<RunEvent, "kind" | "data">;

export function mapClaudeMessage(message: SDKMessage): NormalizedEvent[] {
    switch (message.type) {
        case "system":
            return [{ kind: "status", data: message }];

        case "assistant": {
            // A subagent's messages carry the id of the Agent call that started it.
            // Its text is tagged rather than a plain string, so the chat nests it
            // under that call and the transcript (plain strings only) skips it.
            const parent = message.parent_tool_use_id ?? undefined;
            const events: NormalizedEvent[] = [];
            for (const block of message.message.content) {
                if (block.type === "text") {
                    events.push({ kind: "text", data: parent ? { text: block.text, parent } : block.text });
                } else if (block.type === "tool_use") {
                    events.push({
                        kind: "tool_call",
                        data: { id: block.id, name: block.name, input: block.input, ...(parent ? { parent } : {}) },
                    });
                }
            }
            return events;
        }

        case "user": {
            const parent = message.parent_tool_use_id ?? undefined;
            const events: NormalizedEvent[] = [];
            if (Array.isArray(message.message.content)) {
                for (const block of message.message.content) {
                    if (block.type === "tool_result") {
                        events.push({
                            kind: "tool_result",
                            data: { toolUseId: block.tool_use_id, content: block.content, ...(parent ? { parent } : {}) },
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
            // Failed results (max budget, crashes) cost money too; the worker counts it.
            return [{
                kind: "error",
                data: { subtype: message.subtype, errors: message.errors, totalCostUsd: message.total_cost_usd },
            }];

        default:
            return [{ kind: "raw", data: message }];
    }
}

export class ClaudeAdapter implements RunAdapter {
    private controller?: AbortController;

    /**
     * maxBudgetUsd: the SDK stops the run itself once it has spent this much
     * (none on a subscription). systemAppend: added to Claude Code's own system
     * prompt, so the user's message (and any /command) reaches it untouched.
     */
    constructor(private maxBudgetUsd?: number, private systemAppend?: string, private model?: string, private effort?: string) {}

    async *start(
        task: string,
        resume?: string
    ): AsyncIterable<RunEvent> {
        this.controller = new AbortController();

        let seq = 0;

        // Streaming input: with a plain string prompt Claude Code closes as soon as
        // the turn ends, too early to ask how full the context is. The input stays
        // open until that answer is in.
        let finish!: () => void;
        const finished = new Promise<void>((resolve) => (finish = resolve));
        async function* input(): AsyncIterable<SDKUserMessage> {
            yield { type: "user", message: { role: "user", content: task }, parent_tool_use_id: null };
            await finished;
        }

        const q = query({
            prompt: input(),
            options: {
                cwd: "/workspace",
                permissionMode: "default",
                canUseTool,
                disallowedTools: ["Bash(git push *)"],
                maxBudgetUsd: this.maxBudgetUsd,
                // Like `claude --model`: beats a model pinned in the repo's .claude/settings.json.
                model: this.model,
                // The chat box's effort; the SDK falls back to the nearest level the model has.
                effort: this.effort as EffortLevel | undefined,
                // Claude Code's own system prompt, as in the CLI, plus Cloudly's rules.
                systemPrompt: { type: "preset", preset: "claude_code", append: this.systemAppend },
                resume,
                abortController: this.controller,
            },
        });
        try {
            for await (const message of q) {
                // How full the context window is, like Claude Code's context indicator.
                // "summary" answers from the last response's usage: no extra API calls.
                if (message.type === "result") {
                    const usage = await q.getContextUsage({ detail: "summary" }).catch(() => null);
                    finish();
                    if (usage) {
                        yield {
                            seq: seq++, ts: Date.now(), kind: "status",
                            data: { type: "context", model: usage.model, tokens: usage.totalTokens, max: usage.maxTokens, percentage: usage.percentage },
                        };
                    }
                }
                for (const event of mapClaudeMessage(message)) {
                    yield { seq: seq++, ts: Date.now(), ...event };
                }
            }
        } finally {
            finish();
        }
    }

    async interrupt(): Promise<void> {
        this.controller?.abort();
    }
}
