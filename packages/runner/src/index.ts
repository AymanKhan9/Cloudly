import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import type { RunAdapter } from "./adapter";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { AcpAdapter, type AcpLaunch } from "./adapters/acp";
import { ASK_MCP, CONTEXT_MCP, DESKTOP_MCP, SESSIONS_MCP, type McpSpec } from "./mcp";
import { startDesktop } from "./desktop";

const CONFIG_PATH = process.env.CONTROL_CONFIG_PATH ?? "/control/config.json";

type RunConfig = {
    task: string;
    resume?: string;
    /** The task with the earlier conversation in it, for an added agent that can't resume after all. */
    fallbackTask?: string;
    harness:string;
    /** What's left of the monthly limit; only Claude can enforce it mid-run. */
    maxBudgetUsd?: number;
    /** Cloudly's sandbox rules, appended to Claude Code's own system prompt. */
    systemAppend?: string;
    /** The session's chosen model, if any. */
    model?: string;
    /** How hard the agent thinks (see @repo/shared/effort), if chosen. */
    effort?: string;
    /** Remote MCP servers, as the credential gateway's URLs for them. */
    mcpServers?: { name: string; url: string }[];
    /** Start a virtual display the agent can use and the user can watch. */
    desktop?: { password: string };
    /** The repo's shared context is mounted at /context. */
    context?: boolean;
    /** A research turn: turn on the agent's own web search where it's off by default (Codex). */
    research?: boolean;
    /** An agent added under Settings > Agents, run over ACP. */
    acp?: AcpLaunch;
    /** The user's other sessions are mounted at /sessions. */
    sessions?: boolean;
    /** A session's turn: ask_user writes to /ask. */
    ask?: boolean;
};

const adapters: Record<string,(config: RunConfig, mcp: McpSpec[])=>RunAdapter> = {
    "native-claude" : (config, mcp)=> new ClaudeAdapter(config.maxBudgetUsd, config.systemAppend, config.model, config.effort, mcp),
    "native-codex": (config, mcp)=> new CodexAdapter(config.model, config.effort, mcp, config.research),
    "gemini-acp": (config, mcp)=> new AcpAdapter(config.model, config.effort, mcp),
};

async function loadConfig(): Promise<RunConfig> {
    const raw = await Bun.file(CONFIG_PATH).json();
    if (typeof raw.task !== "string") {
        throw new Error(`invalid config at ${CONFIG_PATH}: missing "task"`);
    }
    return {
        task: raw.task, resume: raw.resume, fallbackTask: raw.fallbackTask, harness:raw.harness, maxBudgetUsd: raw.maxBudgetUsd, systemAppend: raw.systemAppend,
        model: raw.model, effort: raw.effort, mcpServers: raw.mcpServers, desktop: raw.desktop, context: raw.context, research: raw.research, acp: raw.acp, sessions: raw.sessions, ask: raw.ask,
    };
}

let lastSeq = -1;

/** Prints an event of the runner's own, numbered after everything so far. */
function emit(kind: string, data: unknown) {
    lastSeq++;
    console.log(JSON.stringify({ seq: lastSeq, ts: Date.now(), kind, data }));
}

/**
 * Messages the user sends while the turn runs: the worker writes each to
 * /control/steer/<id>.json, and the agent gets it if it can still take it.
 */
function watchSteers(adapter: RunAdapter, dir = process.env.CONTROL_STEER_DIR ?? "/control/steer"): () => void {
    const seen = new Set<string>();
    const timer = setInterval(async () => {
        let names: string[] = [];
        try {
            names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
        } catch {
            return;
        }
        for (const name of names) {
            if (seen.has(name)) continue;
            seen.add(name);
            try {
                const m = (await Bun.file(`${dir}/${name}`).json()) as { id?: unknown; text?: unknown };
                if (typeof m.id !== "string" || typeof m.text !== "string" || !m.text.trim()) continue;
                const taken = adapter.steer?.(m.text) ?? false;
                emit("status", taken ? { type: "steer", id: m.id, text: m.text } : { type: "steer.late", id: m.id });
            } catch {}
        }
    }, 700);
    return () => clearInterval(timer);
}

async function main() {
    const config = await loadConfig();
    // Added agents all speak ACP; the worker says how to start each one.
    const makeAdapter = config.acp
        ? (c: RunConfig, mcp: McpSpec[]) => new AcpAdapter(c.model, c.effort, mcp, c.acp)
        : adapters[config.harness];
    if(!makeAdapter){
        throw new Error(`unknown harness: ${config.harness}`);
    }
    const mcp: McpSpec[] = [...(config.mcpServers ?? []), ...(config.context ? [CONTEXT_MCP] : []), ...(config.sessions ? [SESSIONS_MCP] : []), ...(config.ask ? [ASK_MCP] : [])];
    if (config.desktop) {
        if (await startDesktop(config.desktop.password)) {
            mcp.push(DESKTOP_MCP);
        } else {
            emit("status", { type: "desktop", available: false, message: "No virtual display: tick \"Desktop and browser\" under Settings > Sandbox tools." });
        }
    }
    // A trial of an agent's new version: install it in this sandbox first.
    if (config.acp?.preinstall) {
        emit("status", { type: "trial.install", name: config.acp.name });
        const r = spawnSync("bash", ["-c", config.acp.preinstall], { encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
        if (r.status !== 0) throw new Error(`The new version of ${config.acp.name} didn't install: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
    }
    const adapter : RunAdapter = makeAdapter(config, mcp);

    process.on("SIGINT", () => {
        adapter.interrupt();
    });

    // Adapters number their own events from 0; the runner's own (a message
    // taken mid-turn) come in between, so everything is numbered here, in order.
    const stopSteers = watchSteers(adapter);
    try {
        for await (const event of adapter.start(config.task, config.resume, config.fallbackTask)) {
            lastSeq++;
            console.log(JSON.stringify({ ...event, seq: lastSeq }));
        }
    } finally {
        stopSteers();
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((err) => {
        console.log(JSON.stringify({
            seq: lastSeq + 1,
            ts: Date.now(),
            kind: "error",
            data: { message: err instanceof Error ? err.message : String(err) },
        }));
        process.exit(1);
    });
