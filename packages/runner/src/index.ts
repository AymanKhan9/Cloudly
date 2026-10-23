import type { RunAdapter } from "./adapter";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { AcpAdapter } from "./adapters/acp";
import { CONTEXT_MCP, DESKTOP_MCP, type McpSpec } from "./mcp";
import { startDesktop } from "./desktop";

const CONFIG_PATH = process.env.CONTROL_CONFIG_PATH ?? "/control/config.json";

type RunConfig = {
    task: string;
    resume?: string;
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
        task: raw.task, resume: raw.resume, harness:raw.harness, maxBudgetUsd: raw.maxBudgetUsd, systemAppend: raw.systemAppend,
        model: raw.model, effort: raw.effort, mcpServers: raw.mcpServers, desktop: raw.desktop, context: raw.context, research: raw.research,
    };
}

let lastSeq = -1;

async function main() {
    const config = await loadConfig();
    const makeAdapter = adapters[config.harness];
    if(!makeAdapter){
        throw new Error(`unknown harness: ${config.harness}`);
    }
    const mcp: McpSpec[] = [...(config.mcpServers ?? []), ...(config.context ? [CONTEXT_MCP] : [])];
    if (config.desktop) {
        if (await startDesktop(config.desktop.password)) {
            mcp.push(DESKTOP_MCP);
        } else {
            lastSeq++;
            console.log(JSON.stringify({
                seq: lastSeq, ts: Date.now(), kind: "status",
                data: { type: "desktop", available: false, message: "No virtual display: tick \"Desktop and browser\" under Settings > Sandbox tools." },
            }));
        }
    }
    const adapter : RunAdapter = makeAdapter(config, mcp);

    process.on("SIGINT", () => {
        adapter.interrupt();
    });

    // Adapters number their own events from 0; anything the runner said first comes before them.
    const offset = lastSeq + 1;
    for await (const event of adapter.start(config.task, config.resume)) {
        lastSeq = event.seq + offset;
        console.log(JSON.stringify({ ...event, seq: lastSeq }));
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
