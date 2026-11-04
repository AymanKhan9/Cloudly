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
    {
        name: "request_secret",
        description:
            "Ask the user for a secret (an API key, a token, a password) without ever seeing it. They get a box to paste it in; Cloudly stores it encrypted and, from your next turn, it's an environment variable holding a placeholder that the network proxy swaps for the real value only on HTTPS requests to the hosts named here. Use the variable as it is in a header or URL (e.g. Authorization: Bearer $STRIPE_KEY). Never ask for a secret in chat. After calling this, finish your turn with where things stand.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "The environment variable to hold it: capital letters, digits and underscores, e.g. STRIPE_API_KEY." },
                description: { type: "string", description: "What it is and where the user finds it, in a sentence or two." },
                hosts: { type: "array", items: { type: "string" }, description: "The hosts it's for, e.g. [\"api.stripe.com\"]. Subdomains are included." },
            },
            required: ["name", "hosts"],
        },
    },
];

export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const HOST = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function requestSecret(args: Json): Promise<Json> {
    const name = String(args.name ?? "").trim();
    if (!SECRET_NAME.test(name)) return text("Name it like an environment variable: capital letters, digits and underscores, e.g. STRIPE_API_KEY.", true);
    const raw = Array.isArray(args.hosts) ? args.hosts : String(args.hosts ?? "").split(/[\s,]+/);
    const hosts = [...new Set(raw.map((h: unknown) => String(h).trim().replace(/^https?:\/\//, "").replace(/[/:].*$/, "").toLowerCase()).filter((h: string) => HOST.test(h)))].slice(0, 10);
    if (!hosts.length) return text("Name the host or hosts the secret is for, e.g. [\"api.stripe.com\"].", true);
    const description = String(args.description ?? "").trim().slice(0, MAX_QUESTION);
    await writeFile(path.join(ASK_DIR, "secret.json"), JSON.stringify({ name, description, hosts }));
    return text(
        `The user will see a box to enter ${name}. Finish this turn now, with a short summary of where things stand. Once they save it, the next message says so, and ${name} is in your environment from then on: a placeholder the proxy swaps for the real value on HTTPS requests to ${hosts.join(", ")}. You never see the value itself.`,
    );
}

async function callTool(name: string, args: Json): Promise<Json> {
    if (name === "request_secret") return requestSecret(args);
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
                instructions: "Ask the user a question when you can't go on without them, or for a secret you need (never ask for one in chat).",
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
