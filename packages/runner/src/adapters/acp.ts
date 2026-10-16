import type { RunAdapter } from "../adapter";
import type { RunEvent } from "@repo/shared/run-event";
import * as acp from "@agentclientprotocol/sdk";
import type { SessionUpdate, PermissionOption, PermissionOptionKind, SessionId } from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { GeminiSubagents } from "./gemini-subagents";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Gemini CLI has no ACP option for how hard it thinks, so the chat box's effort
 * goes in as a model config override in its own settings file. It targets
 * "chat-base-3", the config Gemini 3 models build on (2.5 models use a thinking
 * budget instead, and keep their default). Other settings in the file are kept.
 */
export async function writeGeminiEffort(effort: string | undefined, home = process.env.HOME ?? homedir()) {
    const file = path.join(home, ".gemini", "settings.json");
    const existing = await readFile(file, "utf8").catch(() => null);
    // The session's home persists across turns: back on the default, drop our override.
    if (!effort && existing === null) return;
    const settings = JSON.parse(existing ?? "{}") as Record<string, any>;
    const configs = (settings.modelConfigs ??= {});
    const others = (Array.isArray(configs.customOverrides) ? configs.customOverrides : []).filter(
        (o: any) => !(o?.match?.model === "chat-base-3" && o?.modelConfig?.generateContentConfig?.thinkingConfig),
    );
    configs.customOverrides = effort
        ? [...others, { match: { model: "chat-base-3" }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: effort.toUpperCase() } } } }]
        : others;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(settings, null, 2));
}

export type NormalizedEvent = Pick<RunEvent, "kind" | "data">;

export function mapAcpUpdate(update: SessionUpdate): NormalizedEvent[] {
    switch (update.sessionUpdate) {
        case "agent_message_chunk": {
            const block = update.content;
            if (block.type === "text") {
                return [{ kind: "text", data: block.text }];
            }
            return [{ kind: "raw", data: block }];
        }

        // Reasoning is kept out of the reply text so a chat can fold it away.
        case "agent_thought_chunk": {
            const block = update.content;
            return [{ kind: "raw", data: block.type === "text" ? { thought: block.text } : block }];
        }

        case "tool_call": {
            // Gemini delegates with invoke_agent ("Delegating to agent 'name'"). Shown as
            // an Agent call, the same as Claude's, so the chat nests the subagent's work.
            const agent = /^Delegating to agent '([^']+)'/.exec(update.title ?? "")?.[1];
            if (agent || update.toolCallId.startsWith("invoke_agent")) {
                const name = agent ?? "subagent";
                return [{ kind: "tool_call", data: { id: update.toolCallId, name: "Agent", input: { subagent_type: name, description: "" } } }];
            }
            return [{
                kind: "tool_call",
                data: {
                    id: update.toolCallId,
                    name: update.name,
                    title: update.title,
                    status: update.status,
                    input: update.rawInput,
                },
            }];
        }

        case "tool_call_update":
            return [{
                kind: "tool_result",
                data: {
                    id: update.toolCallId,
                    status: update.status,
                    content: update.content,
                    output: update.rawOutput,
                },
            }];

        case "available_commands_update":
            // Same shape as Claude's init message, so the chat can offer them after "/".
            return [{
                kind: "status",
                data: {
                    type: "commands",
                    slash_commands: update.availableCommands.map((c) => c.name),
                },
            }];

        case "user_message_chunk":
            return [];

        default:
            return [{ kind: "raw", data: update }];
    }
}

function pickPermissionOption(options: PermissionOption[]): string | undefined {
    const byKind = (kind: PermissionOptionKind) =>
        options.find((o) => o.kind === kind)?.optionId;
    return byKind("allow_once") ?? byKind("reject_once") ?? options[0]?.optionId;
}

// `session/load` has no fluent wrapper the way `session/new` has
// `buildSession(...)` — the convenience layer only builds `ActiveSession`s
// around a `session/new` response. `attachSession` is the private method
// `SessionBuilder.start()` itself calls to do that wiring; it only reads
// `response.sessionId` plus whatever `session/update` notifications arrive
// after, so handing it a `LoadSessionResponse` with the known sessionId
// merged in produces the same `ActiveSession` a public API would, if one
// existed. Marked `private` in the .d.ts (TS-only, erased at runtime), so
// this is relying on an internal that isn't a stable public contract —
// revisit if a future SDK version wraps `session/load` properly.
async function startResumedSession(
    ctx: acp.ClientContext,
    sessionId: SessionId,
    cwd: string,
): Promise<acp.ActiveSession> {
    // Each run spawns a fresh `gemini --acp` subprocess (see `start()` below),
    // so this connection has no prior auth state even though the session
    // being loaded does. Verified live: `session/load` on a brand-new
    // subprocess fails with "Authentication required" (-32000) without this,
    // while `session/new` doesn't need it upfront. "gemini-api-key" matches
    // the one credential path this harness supports (`GEMINI_API_KEY`, see
    // `HARNESS_CREDENTIALS` in apps/worker/src/docker.ts) — not a guess among
    // the oauth-personal/vertex-ai/gateway alternatives `initialize` lists.
    await ctx.request(acp.methods.agent.authenticate, { methodId: "gemini-api-key" as acp.AuthMethodId });

    const loadResponse = await ctx.request(acp.methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers: [],
    });
    const attachSession = (
        ctx as unknown as { attachSession(response: acp.NewSessionResponse): acp.ActiveSession }
    ).attachSession;
    return attachSession.call(ctx, { sessionId, ...loadResponse });
}

export class AcpAdapter implements RunAdapter {
    /** The session's "/model" choice; otherwise GEMINI_MODEL or the pinned flash model. */
    constructor(private model?: string, private effort?: string) {}

    private process?: ChildProcessByStdio<Writable, Readable, null>;
    private ctx?: acp.ClientContext;
    private sessionId?: SessionId;

    async *start(task: string, resume?: string): AsyncIterable<RunEvent> {
        await writeGeminiEffort(this.effort).catch((err) => console.error("could not set Gemini effort:", err));
        this.process = spawn("gemini", ["--acp"], {
            cwd: "/workspace",
            stdio: ["pipe", "pipe", "inherit"],
        });

        const input = Writable.toWeb(this.process.stdin);
        const output = Readable.toWeb(this.process.stdout) as ReadableStream<Uint8Array>;
        const stream = acp.ndJsonStream(input, output);

        let seq = 0;
        const queue: RunEvent[] = [];
        let wake: (() => void) | null = null;
        let done = false;
        let failure: unknown = null;

        const push = (events: NormalizedEvent[]) => {
            for (const event of events) {
                queue.push({ seq: seq++, ts: Date.now(), ...event });
            }
            wake?.();
        };

        const connection = acp
            .client({ name: "cloud-agents" })
            .onRequest(acp.methods.client.session.requestPermission, async (reqCtx) => {
                const optionId = pickPermissionOption(reqCtx.params.options);
                if (!optionId) {
                    return { outcome: { outcome: "cancelled" } };
                }
                return { outcome: { outcome: "selected", optionId } };
            })
            .connectWith(stream, async (clientCtx) => {
                this.ctx = clientCtx;

                await clientCtx.request(acp.methods.agent.initialize, {
                    protocolVersion: acp.PROTOCOL_VERSION,
                    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
                });

                const session = resume
                    ? await startResumedSession(clientCtx, resume as SessionId, "/workspace")
                    : await clientCtx.buildSession("/workspace").start();

                // Subagents' own work, from their chat logs, every half second.
                const subagents = new GeminiSubagents();
                subagents.sessionId = session.sessionId;
                let polling = false;
                const pollSubagents = async () => {
                    if (polling) return;
                    polling = true;
                    push(await subagents.poll().catch(() => []));
                    polling = false;
                };
                const timer = setInterval(pollSubagents, 500);

                try {
                    this.sessionId = session.sessionId;
                    push([{ kind: "status", data: { type: "acp.session", sessionId: session.sessionId } }]);

                    // Gemini's "auto" router sends free-tier keys to models they have no
                    // quota for (the pro models have a free limit of 0) and then retries
                    // for minutes, so pin a fast flash model. GEMINI_MODEL=auto opts out.
                    const model = this.model ?? process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
                    if (model !== "auto") {
                        await clientCtx
                            .request("session/set_model", { sessionId: session.sessionId, modelId: model })
                            .catch((err) => console.error("session/set_model failed:", err));
                    }

                    // `session/load` replays the whole earlier conversation as updates.
                    // Those already belong to earlier turns, so wait for the replay burst
                    // to go quiet and drop it before this turn's prompt goes out.
                    let first: ReturnType<typeof session.nextUpdate> | undefined;
                    if (resume) {
                        const idle = Symbol("idle");
                        first = session.nextUpdate();
                        for (;;) {
                            const got = await Promise.race([first, Bun.sleep(1500).then(() => idle)]);
                            if (got === idle) break;
                            first = session.nextUpdate();
                        }
                    }
                    session.prompt(task);

                    for (;;) {
                        const message = await (first ?? session.nextUpdate());
                        first = undefined;
                        if (message.kind === "stop") {
                            clearInterval(timer);
                            while (polling) await Bun.sleep(20);
                            await pollSubagents();
                            push([{ kind: "done", data: message.response }]);
                            return message.response;
                        }
                        const events = mapAcpUpdate(message.notification.update);
                        for (const e of events) {
                            const d = e.data as { name?: string; id?: string };
                            if (e.kind === "tool_call" && d.name === "Agent" && d.id) subagents.delegated(d.id);
                        }
                        push(events);
                    }
                } finally {
                    // Also when the turn ends in an error: keep what the subagents logged.
                    clearInterval(timer);
                    while (polling) await Bun.sleep(20);
                    await pollSubagents();
                    session.dispose();
                }
            })
            .catch((error) => {
                failure = error;
            })
            .finally(() => {
                done = true;
                wake?.();
                this.process?.kill();
            });

        while (true) {
            if (queue.length > 0) {
                yield queue.shift()!;
                continue;
            }
            if (done) {
                if (failure) throw failure;
                break;
            }
            await new Promise<void>((resolve) => {
                wake = resolve;
            });
        }

        await connection;
    }

    async interrupt(): Promise<void> {
        if (this.ctx && this.sessionId) {
            await this.ctx.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
            return;
        }
        this.process?.kill("SIGINT");
    }
}