// ask_user: how an agent says it can't go on without the user. A turn in
// Cloudly runs with nobody watching, so the agent doesn't wait for an answer:
// it asks, ends its turn, and the session shows as needing the user in their
// sidebar until they reply. The question goes to /ask/question.json, which the
// worker reads after the turn.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { serveStdio } from "./mcp-stdio";

type Json = Record<string, any>;

export const ASK_DIR = process.env.CLOUDLY_ASK_DIR ?? "/ask";
export const MAX_QUESTION = 2000;

export const TOOLS = [
    {
        name: "ask_user",
        description:
            "Use only when you can't continue without the user: a decision that's theirs to make, or information you can't find. The question shows in their sidebar, flagged as needing them. Then finish your turn with what you did so far; their answer comes as the next message. Never ask for permission to run commands, edit files or install packages: you have it.",
        inputSchema: {
            type: "object",
            properties: { question: { type: "string", description: "One clear question, with the options if there are any." } },
            required: ["question"],
        },
    },
];

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name: string, args: Json): Promise<Json> {
    if (name !== "ask_user") throw new Error(`unknown tool: ${name}`);
    const question = String(args.question ?? "").trim();
    if (!question) return text("The question is empty.", true);
    await writeFile(path.join(ASK_DIR, "question.json"), JSON.stringify({ question: question.slice(0, MAX_QUESTION) }));
    return text("The user will see your question. Finish this turn now, with a short summary of where things stand; their answer arrives as the next message.");
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
                serverInfo: { name: "cloudly-ask", version: "1.0.0" },
                instructions: "Ask the user a question when you can't go on without them.",
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
