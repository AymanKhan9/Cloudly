import type { RunAdapter } from "../adapter";
import type { RunEvent } from "@repo/shared/run-event";
import { claudeMcpServers, type McpSpec } from "../mcp";
import { query, type SDKMessage, type SDKUserMessage, type CanUseTool, type EffortLevel } from "@anthropic-ai/claude-agent-sdk";

const canUseTool: CanUseTool = async (_toolName, _input, options) => {
    return { behavior: "allow", toolUseID: options.toolUseID };
};

/** Keeps `running` in step with Claude Code's live background tasks (ambient watchers don't count). */
export function trackBackground(running: Set<string>, message: { subtype?: string; [k: string]: unknown }): void {
    const m = message as { subtype?: string; tasks?: { task_id: string; ambient?: boolean }[]; task_id?: string; is_backgrounded?: boolean; ambient?: boolean };
    if (m.subtype === "background_tasks_changed" && Array.isArray(m.tasks)) {
        running.clear();
        for (const t of m.tasks) if (!t.ambient) running.add(t.task_id);
    } else if (m.subtype === "task_started" && m.is_backgrounded && !m.ambient && m.task_id) {
        running.add(m.task_id);
    } else if (m.subtype === "task_notification" && m.task_id) {
        running.delete(m.task_id);
    }
}

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
    /** Messages from the user mid-turn, waiting to go into the input stream. */
    private steers: string[] = [];
    private wakeInput?: () => void;
    private closed = false;

    /**
     * maxBudgetUsd: the SDK stops the run itself once it has spent this much
     * (none on a subscription). systemAppend: added to Claude Code's own system
     * prompt, so the user's message (and any /command) reaches it untouched.
     */
    constructor(private maxBudgetUsd?: number, private systemAppend?: string, private model?: string, private effort?: string, private mcp: McpSpec[] = []) {}

    async *start(
        task: string,
        resume?: string
    ): AsyncIterable<RunEvent> {
        this.controller = new AbortController();

        let seq = 0;

        // Streaming input: with a plain string prompt Claude Code closes as soon as
        // the turn ends, too early to ask how full the context is. The input stays
        // open until that answer is in.
        // A message from the user mid-turn goes into the same stream: Claude Code
        // takes it in at its next step, without stopping.
        let finish!: () => void;
        const finished = new Promise<void>((resolve) => (finish = resolve));
        let sent = 1;
        let results = 0;
        let lastMessage = Date.now();
        const close = () => {
            this.closed = true;
            finish();
            this.wakeInput?.();
        };
        const self = this;
        async function* input(): AsyncIterable<SDKUserMessage> {
            yield { type: "user", message: { role: "user", content: task }, parent_tool_use_id: null };
            while (!self.closed) {
                const next = self.steers.shift();
                if (next !== undefined) {
                    sent++;
                    yield { type: "user", message: { role: "user", content: next }, parent_tool_use_id: null };
                    continue;
                }
                await Promise.race([finished, new Promise<void>((resolve) => (self.wakeInput = resolve))]);
            }
        }
        // A message taken in mid-turn may not get a result of its own: once the
        // agent has been quiet a while after its last result, the turn is over.
        // Background work (a subagent or command the agent sent to the background)
        // ends the turn with a result while it still runs; Claude Code picks the
        // turn up again when it finishes. Closing the input then would cut the
        // channel tool permissions go through, so the turn waits for it.
        const background = new Set<string>();
        const watchdog = setInterval(() => {
            if (this.closed || results === 0 || this.steers.length > 0 || background.size > 0 || Date.now() - lastMessage <= 6000) return;
            if (results < sent || waitedOnBackground) close();
        }, 1000);
        let waitedOnBackground = false;

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
                // Cloudly's MCP servers, on top of any the repo configures itself.
                ...(this.mcp.length ? { mcpServers: claudeMcpServers(this.mcp) } : {}),
                abortController: this.controller,
            },
        });
        try {
            for await (const message of q) {
                lastMessage = Date.now();
                // How full the context window is, like Claude Code's context indicator.
                // "summary" answers from the last response's usage: no extra API calls.
                if (message.type === "system") trackBackground(background, message);
                if (message.type === "result") results++;
                if (message.type === "result" && background.size > 0) waitedOnBackground = true;
                if (message.type === "result" && results >= sent && this.steers.length === 0 && background.size === 0) {
                    const usage = await q.getContextUsage({ detail: "summary" }).catch(() => null);
                    close();
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
            clearInterval(watchdog);
            close();
        }
    }

    steer(text: string): boolean {
        if (this.closed || !this.controller) return false;
        this.steers.push(text);
        this.wakeInput?.();
        return true;
    }

    async interrupt(): Promise<void> {
        this.controller?.abort();
    }
}
