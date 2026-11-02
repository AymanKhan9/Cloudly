import type { RunAdapter } from "../adapter";
import type { RunEvent } from "@repo/shared/run-event";
import * as acp from "@agentclientprotocol/sdk";
import type { SessionUpdate, PermissionOption, PermissionOptionKind, SessionId } from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { GeminiSubagents } from "./gemini-subagents";
import { acpMcpServers, type McpSpec } from "../mcp";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** An agent added under Settings > Agents: the image installed it, the worker says how to start it. */
export interface AcpLaunch {
    name: string;
    /** Its run script, /opt/cloudly/agents/<id>/run. */
    command: string;
    /** Sent with `authenticate` when the agent offers it (e.g. Grok's "xai.api_key"). */
    authMethodId?: string;
    /** Written under HOME first, e.g. a settings file choosing API-key sign-in. */
    homeFiles?: Record<string, string>;
    /** Where it works: the sandbox's /workspace unless a test says otherwise. */
    cwd?: string;
    /** Behind ordinary pipes: some agents (Antigravity) hang on the socket stdio a spawn gives them. */
    pipes?: boolean;
    /** It can resume its own session with `session/load` (Pi, OpenCode), so turns keep its context. */
    resume?: boolean;
    /** Where its turn's cost is: "pi-session" reads Pi's session file. Otherwise only `usage_update`'s cost. */
    cost?: "pi-session";
}

type ConfigOption = NonNullable<acp.NewSessionResponse["configOptions"]>[number];

/** A select option's choices, whether listed flat or in groups. */
function selectValues(option: ConfigOption): { value: string; name: string }[] {
    if (option.type !== "select") return [];
    return (option.options as unknown[]).flatMap((o: any) =>
        Array.isArray(o?.options) ? o.options.map((x: any) => ({ value: String(x.value), name: String(x.name ?? x.value) })) : [{ value: String(o.value), name: String(o.name ?? o.value) }],
    );
}

/** ACP's unstable models list, which some agents (Grok) still send instead of config options. */
interface UnstableModels {
    currentModelId: string;
    availableModels: { modelId: string; name?: string | null }[];
}

/** The session's model choices, from its config options or its (older) models list. */
export function sessionModels(response: { configOptions?: acp.NewSessionResponse["configOptions"]; models?: UnstableModels | null }): { current?: string; options: { value: string; label: string }[]; configId?: string } | null {
    const option = response.configOptions?.find((o) => o.type === "select" && (o.id === "model" || o.category === "model") && o.id !== "provider");
    if (option && option.type === "select") {
        return { current: String(option.currentValue), options: selectValues(option).map((v) => ({ value: v.value, label: v.name })), configId: option.id };
    }
    const models = response.models;
    if (models?.availableModels?.length) {
        return { current: models.currentModelId, options: models.availableModels.map((m) => ({ value: m.modelId, label: m.name ?? m.modelId })) };
    }
    return null;
}

/** Writes an added agent's settings files under HOME, never outside it. */
export async function writeHomeFiles(files: Record<string, string> | undefined, home = process.env.HOME ?? homedir()) {
    for (const [rel, contents] of Object.entries(files ?? {})) {
        const file = path.resolve(home, rel);
        if (!file.startsWith(path.resolve(home) + path.sep)) continue;
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, contents);
    }
}

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

        case "usage_update": {
            // How full the context window is (the chat's ring), and, from agents that
            // track it (OpenCode), what the session has cost so far.
            const u = update as { used?: unknown; size?: unknown; cost?: { amount?: unknown; currency?: unknown } | null };
            const events: NormalizedEvent[] = [];
            if (typeof u.used === "number" && typeof u.size === "number" && u.size > 0) {
                events.push({ kind: "status", data: { type: "context", tokens: u.used, max: u.size, percentage: Math.min(100, Math.round((u.used / u.size) * 100)) } });
            }
            if (typeof u.cost?.amount === "number" && Number.isFinite(u.cost.amount) && (u.cost.currency ?? "USD") === "USD") {
                events.push({ kind: "status", data: { type: "acp.cost", sessionUsd: u.cost.amount } });
            }
            return events;
        }

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
    mcpServers: acp.McpServer[] = [],
    authMethodId: string | null = "gemini-api-key",
): Promise<acp.ActiveSession> {
    // Each run spawns a fresh `gemini --acp` subprocess (see `start()` below),
    // so this connection has no prior auth state even though the session
    // being loaded does. Verified live: `session/load` on a brand-new
    // subprocess fails with "Authentication required" (-32000) without this,
    // while `session/new` doesn't need it upfront. "gemini-api-key" matches
    // the one credential path this harness supports (`GEMINI_API_KEY`, see
    // `HARNESS_CREDENTIALS` in apps/worker/src/docker.ts) — not a guess among
    // the oauth-personal/vertex-ai/gateway alternatives `initialize` lists.
    if (authMethodId) await ctx.request(acp.methods.agent.authenticate, { methodId: authMethodId as acp.AuthMethodId });

    const loadResponse = await ctx.request(acp.methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers,
    });
    const attachSession = (
        ctx as unknown as { attachSession(response: acp.NewSessionResponse): acp.ActiveSession }
    ).attachSession;
    return attachSession.call(ctx, { sessionId, ...loadResponse });
}

/**
 * Gemini CLI, or with `launch` any agent added under Settings > Agents. Only
 * Gemini gets its own extras (effort through its settings file, subagents from
 * its chat logs, a pinned model); the rest get the session's model, if chosen,
 * through ACP itself.
 */
export class AcpAdapter implements RunAdapter {
    /** The session's "/model" choice; for Gemini, otherwise GEMINI_MODEL or the pinned flash model. */
    constructor(private model?: string, private effort?: string, private mcp: McpSpec[] = [], private launch?: AcpLaunch) {}

    private process?: ChildProcessByStdio<Writable, Readable, null>;
    private ctx?: acp.ClientContext;
    private sessionId?: SessionId;

    /**
     * `fallbackTask` is the task with the earlier conversation written in, for
     * when the agent's own session can't be resumed after all.
     */
    async *start(task: string, resume?: string, fallbackTask?: string): AsyncIterable<RunEvent> {
        const launch = this.launch;
        const cwd = launch?.cwd ?? "/workspace";
        if (launch) {
            if (!existsSync(launch.command)) {
                throw new Error(`${launch.name} isn't installed in the sandbox image yet. Settings > Sandbox tools shows the build; it starts a few seconds after the agent is added.`);
            }
            await writeHomeFiles(launch.homeFiles);
            // Agents that can't resume their own session start each turn clean, with
            // the earlier conversation in the prompt.
            if (!launch.resume) resume = undefined;
        } else {
            await writeGeminiEffort(this.effort).catch((err) => console.error("could not set Gemini effort:", err));
        }
        this.process = launch
            ? launch.pipes
                ? spawn("sh", ["-c", 'cat | "$0" | cat', launch.command], { cwd, stdio: ["pipe", "pipe", "inherit"] })
                : spawn(launch.command, [], { cwd, stdio: ["pipe", "pipe", "inherit"] })
            : spawn("gemini", ["--acp"], { cwd, stdio: ["pipe", "pipe", "inherit"] });

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

                const init = await clientCtx.request(acp.methods.agent.initialize, {
                    protocolVersion: acp.PROTOCOL_VERSION,
                    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
                });

                // An API key in the environment is one of several sign-ins some agents
                // offer; pick it, or they fall back to a browser sign-in nobody can do.
                if (launch?.authMethodId && init.authMethods?.some((m) => m.id === launch.authMethodId)) {
                    await clientCtx.request(acp.methods.agent.authenticate, { methodId: launch.authMethodId as acp.AuthMethodId });
                }

                const mcpServers = acpMcpServers(this.mcp) as acp.McpServer[];
                let session: acp.ActiveSession;
                let resumed = false;
                if (resume && launch) {
                    // An added agent's session file can be gone (a cleaned data dir, an
                    // upgrade): start over, with the conversation in the prompt instead.
                    try {
                        session = await startResumedSession(clientCtx, resume as SessionId, cwd, mcpServers, null);
                        resumed = true;
                    } catch (err) {
                        push([{ kind: "status", data: { type: "acp.resume_failed", message: err instanceof Error ? err.message : String(err) } }]);
                        session = await clientCtx.buildSession({ cwd, mcpServers }).start();
                        if (fallbackTask) task = fallbackTask;
                    }
                } else if (resume) {
                    session = await startResumedSession(clientCtx, resume as SessionId, cwd, mcpServers);
                    resumed = true;
                } else {
                    session = await clientCtx.buildSession({ cwd, mcpServers }).start();
                }

                // Subagents' own work, from Gemini's chat logs, every half second.
                const subagents = new GeminiSubagents();
                subagents.sessionId = session.sessionId;
                let polling = false;
                const pollSubagents = async () => {
                    if (polling || launch) return;
                    polling = true;
                    push(await subagents.poll().catch(() => []));
                    polling = false;
                };
                const timer = setInterval(pollSubagents, 500);

                try {
                    this.sessionId = session.sessionId;
                    push([{ kind: "status", data: { type: "acp.session", sessionId: session.sessionId, resumed } }]);

                    if (launch) {
                        push(await this.chooseModel(clientCtx, session));
                        push(await this.chooseEffort(clientCtx, session));
                    } else {
                        // Gemini's "auto" router sends free-tier keys to models they have no
                        // quota for (the pro models have a free limit of 0) and then retries
                        // for minutes, so pin a fast flash model. GEMINI_MODEL=auto opts out.
                        const model = this.model ?? process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
                        if (model !== "auto") {
                            await clientCtx
                                .request("session/set_model", { sessionId: session.sessionId, modelId: model })
                                .catch((err) => console.error("session/set_model failed:", err));
                        }
                    }

                    // `session/load` replays the whole earlier conversation as updates.
                    // Those already belong to earlier turns, so wait for the replay burst
                    // to go quiet and drop it before this turn's prompt goes out.
                    let first: ReturnType<typeof session.nextUpdate> | undefined;
                    if (resumed) {
                        const idle = Symbol("idle");
                        first = session.nextUpdate();
                        for (;;) {
                            const got = await Promise.race([first, Bun.sleep(1500).then(() => idle)]);
                            if (got === idle) break;
                            first = session.nextUpdate();
                        }
                    }
                    const turnStarted = Date.now();
                    session.prompt(task);

                    for (;;) {
                        const message = await (first ?? session.nextUpdate());
                        first = undefined;
                        if (message.kind === "stop") {
                            clearInterval(timer);
                            while (polling) await Bun.sleep(20);
                            await pollSubagents();
                            if (launch?.cost === "pi-session") {
                                const usd = await piTurnCost(session.sessionId, turnStarted).catch(() => null);
                                if (usd !== null) push([{ kind: "status", data: { type: "acp.cost", turnUsd: usd } }]);
                            }
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

    /**
     * Switches an added agent to the session's "/model" choice, and reports the
     * models it offers so the chat's model menu can list them.
     */
    private async chooseModel(ctx: acp.ClientContext, session: acp.ActiveSession): Promise<NormalizedEvent[]> {
        const models = sessionModels(session.newSessionResponse as Parameters<typeof sessionModels>[0]);
        let current = models?.current;
        if (this.model && this.model !== current) {
            try {
                if (models?.configId) {
                    await ctx.request("session/set_config_option", { sessionId: session.sessionId, configId: models.configId, value: this.model });
                } else {
                    await ctx.request("session/set_model", { sessionId: session.sessionId, modelId: this.model });
                }
                current = this.model;
            } catch (err) {
                const known = models?.options.map((o) => o.value).slice(0, 12).join(", ");
                return [
                    ...(models ? [{ kind: "status" as const, data: { type: "models", current, options: models.options } }] : []),
                    { kind: "text", data: `Couldn't switch to the model "${this.model}" (${err instanceof Error ? err.message : String(err)}), so this turn uses ${current ?? "the agent's default"}.${known ? ` It offers: ${known}.` : ""}\n\n` },
                ];
            }
        }
        return models ? [{ kind: "status", data: { type: "models", current, options: models.options } }] : [];
    }

    /**
     * Applies the session's effort through the agent's thinking option (Pi's
     * "Thinking", OpenCode's "Effort"), and reports the levels it offers so the
     * chat's effort menu can list them.
     */
    private async chooseEffort(ctx: acp.ClientContext, session: acp.ActiveSession): Promise<NormalizedEvent[]> {
        const options = (session.newSessionResponse as { configOptions?: ConfigOption[] | null }).configOptions ?? [];
        const option = options.find((o) => o.type === "select" && (o.category === "thought_level" || o.id === "thought_level" || o.id === "effort"));
        if (!option || option.type !== "select") return [];
        const levels = selectValues(option);
        let current = typeof option.currentValue === "string" ? option.currentValue : undefined;
        const events: NormalizedEvent[] = [];
        if (this.effort && this.effort !== current) {
            if (levels.some((l) => l.value === this.effort)) {
                try {
                    await ctx.request("session/set_config_option", { sessionId: session.sessionId, configId: option.id, value: this.effort });
                    current = this.effort;
                } catch (err) {
                    events.push({ kind: "text", data: `Couldn't set the effort to "${this.effort}" (${err instanceof Error ? err.message : String(err)}).\n\n` });
                }
            } else {
                events.push({ kind: "text", data: `This model has no "${this.effort}" effort, so this turn uses ${current ?? "the agent's default"}. It offers: ${levels.map((l) => l.value).join(", ")}.\n\n` });
            }
        }
        events.unshift({ kind: "status", data: { type: "efforts", current, options: levels.map((l) => ({ value: l.value, label: l.name })) } });
        return events;
    }

    async interrupt(): Promise<void> {
        if (this.ctx && this.sessionId) {
            await this.ctx.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
            return;
        }
        this.process?.kill("SIGINT");
    }
}
const PI_FILE_MAX = 64 * 1024 * 1024;

/**
 * What Pi's turn cost: Pi records each reply's cost in its session file
 * (usage.cost.total, in dollars), and pi-acp maps the ACP session to that file
 * in ~/.pi/pi-acp/session-map.json. Sums the replies since the turn started.
 */
export async function piTurnCost(sessionId: string, since: number, home = process.env.HOME ?? "/home/node"): Promise<number | null> {
    const map = await Bun.file(`${home}/.pi/pi-acp/session-map.json`).json().catch(() => null) as { sessions?: Record<string, { sessionFile?: unknown }> } | null;
    const file = map?.sessions?.[sessionId]?.sessionFile;
    if (typeof file !== "string" || !file.startsWith("/")) return null;
    const f = Bun.file(file);
    if (!(await f.exists()) || f.size > PI_FILE_MAX) return null;
    let total = 0;
    let seen = false;
    for (const line of (await f.text()).split("\n")) {
        if (!line.includes('"assistant"')) continue;
        try {
            const entry = JSON.parse(line);
            const m = entry?.message;
            if (entry?.type !== "message" || m?.role !== "assistant" || typeof m.timestamp !== "number" || m.timestamp < since) continue;
            const usd = m.usage?.cost?.total;
            if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0) {
                total += usd;
                seen = true;
            }
        } catch {}
    }
    return seen ? total : null;
}
