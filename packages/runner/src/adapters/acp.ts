import type { RunAdapter } from "../adapter";
import type { RunEvent } from "@repo/shared/run-event";
import * as acp from "@agentclientprotocol/sdk";
import type { SessionUpdate, PermissionOption, PermissionOptionKind, SessionId } from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Writable, Readable } from "node:stream";

export type NormalizedEvent = Pick<RunEvent, "kind" | "data">;

export function mapAcpUpdate(update: SessionUpdate): NormalizedEvent[] {
    switch (update.sessionUpdate) {
        case "agent_message_chunk":
        case "agent_thought_chunk": {
            const block = update.content;
            if (block.type === "text") {
                return [{ kind: "text", data: block.text }];
            }
            return [{ kind: "raw", data: block }];
        }

        case "tool_call":
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
    private process?: ChildProcessByStdio<Writable, Readable, null>;
    private ctx?: acp.ClientContext;
    private sessionId?: SessionId;

    async *start(task: string, resume?: string): AsyncIterable<RunEvent> {
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

                try {
                    this.sessionId = session.sessionId;
                    session.prompt(task);

                    for (;;) {
                        const message = await session.nextUpdate();
                        if (message.kind === "stop") {
                            push([{ kind: "done", data: message.response }]);
                            return message.response;
                        }
                        push(mapAcpUpdate(message.notification.update));
                    }
                } finally {
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