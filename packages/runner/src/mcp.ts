// The MCP servers a run gets, and how each agent is told about them. Remote
// servers are the credential gateway's /mcp/<name> URLs (the gateway adds the
// token); the desktop server is a local process the runner provides.

export type McpSpec =
    | { name: string; url: string }
    | { name: string; command: string; args: string[] };

/** The computer-use server, when the run has a virtual display. */
export const DESKTOP_MCP: McpSpec = {
    name: "desktop",
    command: "bun",
    args: [new URL("./desktop-mcp.ts", import.meta.url).pathname],
};

/** The repo's shared context, when the repo has it turned on. */
export const CONTEXT_MCP: McpSpec = {
    name: "context",
    command: "bun",
    args: [new URL("./context-mcp.ts", import.meta.url).pathname],
};

/** Claude Agent SDK's mcpServers option. */
export function claudeMcpServers(specs: McpSpec[]) {
    return Object.fromEntries(
        specs.map((s) => [s.name, "url" in s ? { type: "http" as const, url: s.url } : { type: "stdio" as const, command: s.command, args: s.args }]),
    );
}

/** Codex's `mcp_servers` config table, passed as --config overrides. */
export function codexMcpConfig(specs: McpSpec[]): { mcp_servers: Record<string, Record<string, string | string[]>> } | undefined {
    if (specs.length === 0) return undefined;
    return {
        mcp_servers: Object.fromEntries(
            specs.map((s): [string, Record<string, string | string[]>] => [s.name, "url" in s ? { url: s.url } : { command: s.command, args: s.args }]),
        ),
    };
}

/** ACP's session/new and session/load mcpServers. */
export function acpMcpServers(specs: McpSpec[]) {
    return specs.map((s) =>
        "url" in s
            ? { type: "http" as const, name: s.name, url: s.url, headers: [] }
            : { name: s.name, command: s.command, args: s.args, env: [] },
    );
}
