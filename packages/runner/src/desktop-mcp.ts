// Computer use for every agent: a small MCP server (stdio, JSON-RPC lines) that
// sees and drives the run's virtual display with ImageMagick and xdotool. Claude,
// Codex and Gemini all speak MCP, so one server serves all three.
import { openBrowser, SCREEN } from "./desktop";

type Json = Record<string, any>;

const XY = { x: { type: "integer", description: `0 to ${SCREEN.width - 1}` }, y: { type: "integer", description: `0 to ${SCREEN.height - 1}` } };

export const TOOLS = [
    {
        name: "screenshot",
        description: `Take a screenshot of the virtual desktop (${SCREEN.width}x${SCREEN.height}). Use it to see the result of each action.`,
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "click",
        description: "Move the mouse to (x, y) in screenshot pixels and click.",
        inputSchema: {
            type: "object",
            properties: { ...XY, button: { type: "string", enum: ["left", "right", "middle"] }, double: { type: "boolean" } },
            required: ["x", "y"],
        },
    },
    { name: "move", description: "Move the mouse to (x, y) without clicking.", inputSchema: { type: "object", properties: XY, required: ["x", "y"] } },
    {
        name: "type",
        description: "Type text at the keyboard focus.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    {
        name: "key",
        description: 'Press a key or combination in xdotool syntax, e.g. "Return", "ctrl+l", "ctrl+shift+t", "Escape".',
        inputSchema: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] },
    },
    {
        name: "scroll",
        description: "Scroll at (x, y).",
        inputSchema: {
            type: "object",
            properties: { ...XY, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "integer", minimum: 1, maximum: 30 } },
            required: ["x", "y", "direction"],
        },
    },
    {
        name: "open_url",
        description: "Open a URL in the desktop's browser, e.g. a dev server at http://localhost:3000.",
        inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    {
        name: "wait",
        description: "Wait for something on screen to finish loading.",
        inputSchema: { type: "object", properties: { seconds: { type: "number", minimum: 0, maximum: 30 } }, required: ["seconds"] },
    },
];

async function run(cmd: string[]): Promise<Uint8Array> {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":99" } });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`${cmd[0]} failed: ${err.trim() || `exit ${code}`}`);
    return new Uint8Array(out);
}

const int = (v: unknown, max: number) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0 || n >= max) throw new Error(`coordinate out of range: ${v}`);
    return String(n);
};

/** The xdotool (or other) commands a tool call becomes. Exported for tests. */
export function commandsFor(name: string, args: Json): string[][] {
    switch (name) {
        case "click": {
            const button = { left: "1", middle: "2", right: "3" }[String(args.button ?? "left")] ?? "1";
            return [["xdotool", "mousemove", int(args.x, SCREEN.width), int(args.y, SCREEN.height), "click", ...(args.double ? ["--repeat", "2"] : []), button]];
        }
        case "move":
            return [["xdotool", "mousemove", int(args.x, SCREEN.width), int(args.y, SCREEN.height)]];
        case "type":
            return [["xdotool", "type", "--delay", "15", "--", String(args.text ?? "")]];
        case "key":
            return [["xdotool", "key", "--", ...String(args.keys ?? "").split(/\s+/).filter(Boolean)]];
        case "scroll": {
            const button = { up: "4", down: "5", left: "6", right: "7" }[String(args.direction)] ?? "5";
            const amount = String(Math.min(30, Math.max(1, Math.round(Number(args.amount ?? 3)))));
            return [["xdotool", "mousemove", int(args.x, SCREEN.width), int(args.y, SCREEN.height), "click", "--repeat", amount, button]];
        }
        default:
            throw new Error(`unknown tool: ${name}`);
    }
}

async function callTool(name: string, args: Json): Promise<Json> {
    if (name === "screenshot") {
        const png = await run(["import", "-window", "root", "png:-"]);
        return { content: [{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" }] };
    }
    if (name === "open_url") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new Error("Only http and https URLs open in the browser.");
        openBrowser(url);
        await Bun.sleep(2000);
        return { content: [{ type: "text", text: `Opened ${url}. Take a screenshot to see it.` }] };
    }
    if (name === "wait") {
        await Bun.sleep(Math.min(30, Math.max(0, Number(args.seconds ?? 1))) * 1000);
        return { content: [{ type: "text", text: "Done waiting." }] };
    }
    for (const cmd of commandsFor(name, args)) await run(cmd);
    // Give the screen a moment to update before the agent looks again.
    await Bun.sleep(300);
    return { content: [{ type: "text", text: "Done." }] };
}

export async function handle(message: Json): Promise<Json | null> {
    const { id, method, params } = message;
    if (id === undefined || id === null) return null; // a notification
    const reply = (result: Json) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
        case "initialize":
            return reply({
                protocolVersion: params?.protocolVersion ?? "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "cloudly-desktop", version: "1.0.0" },
                instructions: `Controls the sandbox's virtual desktop (${SCREEN.width}x${SCREEN.height}). Take a screenshot first, then act on what you see.`,
            });
        case "ping":
            return reply({});
        case "tools/list":
            return reply({ tools: TOOLS });
        case "tools/call":
            try {
                return reply(await callTool(String(params?.name), params?.arguments ?? {}));
            } catch (err) {
                return reply({ content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
            }
        default:
            return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
}

if (import.meta.main) {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of Bun.stdin.stream()) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let message: Json;
            try {
                message = JSON.parse(line);
            } catch {
                continue;
            }
            // Calls run concurrently; each answer goes out whole, on its own line.
            handle(message).then((out) => out && process.stdout.write(JSON.stringify(out) + "\n"));
        }
    }
}
