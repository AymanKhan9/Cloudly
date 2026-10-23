// The repo's shared context, as tools, for runs on a repo that has it turned on.
// The worker writes the current context to /context/context.md before the run;
// notes the agent adds go to /context/new-notes.jsonl, which the worker reads
// back afterwards. Append-only: an agent can add to the shared picture, not
// rewrite or delete what others left there.
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { serveStdio } from "./mcp-stdio";

type Json = Record<string, any>;

export const CONTEXT_DIR = process.env.CLOUDLY_CONTEXT_DIR ?? "/context";
const MAX_NOTE = 4000;
const MAX_NOTES = 20;
let added = 0;

export const TOOLS = [
    {
        name: "repo_context",
        description:
            "The repo's shared context: the notes and decisions every agent and editor working on it follows, and what other sessions and tools did recently. Read it before starting and when you're unsure why something is the way it is.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "add_note",
        description:
            "Leave a note for every other agent and editor working on this repo: a convention you found, a decision and its reason, a gotcha, or work left to do. Keep it short and specific. Don't include secrets.",
        inputSchema: {
            type: "object",
            properties: {
                title: { type: "string", description: "One line." },
                text: { type: "string", description: "The details, if any." },
                kind: { type: "string", enum: ["note", "decision"] },
            },
            required: ["title"],
        },
    },
];

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name: string, args: Json): Promise<Json> {
    if (name === "repo_context") {
        return text(await readFile(path.join(CONTEXT_DIR, "context.md"), "utf8").catch(() => "No shared context for this repo."));
    }
    if (name === "add_note") {
        const title = String(args.title ?? "").trim();
        if (!title) return text("A note needs a title.", true);
        if (added >= MAX_NOTES) return text(`That's ${MAX_NOTES} notes this turn; that's the limit.`, true);
        const note = {
            kind: args.kind === "decision" ? "decision" : "note",
            title: title.slice(0, 200),
            text: String(args.text ?? "").slice(0, MAX_NOTE),
        };
        await appendFile(path.join(CONTEXT_DIR, "new-notes.jsonl"), JSON.stringify(note) + "\n");
        added++;
        return text("Saved. Other agents and editors on this repo will see it from their next turn.");
    }
    throw new Error(`unknown tool: ${name}`);
}

export async function handle(message: Json): Promise<Json | null> {
    const { id, method, params } = message;
    if (id === undefined || id === null) return null;
    const reply = (result: Json) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
        case "initialize":
            return reply({
                protocolVersion: params?.protocolVersion ?? "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "cloudly-context", version: "1.0.0" },
                instructions: "Shared context for this repo, the same for every agent and editor working on it.",
            });
        case "ping":
            return reply({});
        case "tools/list":
            return reply({ tools: TOOLS });
        case "tools/call":
            try {
                return reply(await callTool(String(params?.name), params?.arguments ?? {}));
            } catch (err) {
                return reply(text(err instanceof Error ? err.message : String(err), true));
            }
        default:
            return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
}

if (import.meta.main) await serveStdio(handle);
