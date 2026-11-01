// The user's other Cloudly sessions, as tools (see @repo/shared/sessions). The
// worker writes the ones this session may see to /sessions before the turn;
// messages the agent sends go to /sessions/outbox.jsonl, which the worker reads
// after the turn and delivers as turns in those sessions.
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { serveStdio } from "./mcp-stdio";
import { SESSION_LIMITS, type OutboxMessage, type SessionsIndex } from "@repo/shared/sessions";

type Json = Record<string, any>;

export const SESSIONS_DIR = process.env.CLOUDLY_SESSIONS_DIR ?? "/sessions";
const sent = new Set<string>();

export const TOOLS = [
    {
        name: "list_sessions",
        description:
            "The user's other Cloudly sessions you can see: each one's id, title, agent, repo, branch, latest status and pull request. Use it to find the session the user means, or one already working on something related.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "read_session",
        description:
            "Another session's conversation: what the user asked it and what its agent answered, newest last, plus its branch and pull request. Its code is on its branch; in the same repo, `git fetch origin <branch>` and diff against it.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string", description: "The session: its id from list_sessions, a session link or reference the user pasted, or its exact title." } },
            required: ["id"],
        },
    },
    {
        name: "send_to_session",
        description:
            "Send a message to another session. It becomes a turn there, run by that session's agent on its own branch, after this turn ends. Set reply to true to get its answer back as a new turn in this session. Say what you need plainly; the other agent doesn't see this conversation. One message per session per turn.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "The session: its id from list_sessions, a session link or reference the user pasted, or its exact title." },
                message: { type: "string" },
                reply: { type: "boolean", description: "Send its answer back to this session as a new turn." },
            },
            required: ["id", "message"],
        },
    },
];

/**
 * The session a reference points at, among the ones this turn may see: a session
 * link, a reference copied from the sidebar, a full id, the start of one (at
 * least 6 characters, if only one session matches), or an exact title.
 */
export function findSession(idx: SessionsIndex, ref: string): { session?: SessionsIndex["sessions"][number]; problem?: string } {
    const r = ref.trim();
    if (!r) return { problem: "Say which session: its id, link or title." };
    const full = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(r)?.[0]?.toLowerCase();
    if (full) {
        const session = idx.sessions.find((s) => s.id === full);
        if (session) return { session };
        if (full === idx.self.id) return { problem: "That's this session." };
    } else if (/^[0-9a-f-]{6,}$/i.test(r)) {
        const matches = idx.sessions.filter((s) => s.id.startsWith(r.toLowerCase()));
        if (matches.length === 1) return { session: matches[0] };
        if (matches.length > 1) return { problem: `"${r}" matches ${matches.length} sessions: ${matches.map((m) => `${m.id} ("${m.title}")`).join(", ")}. Use more of the id.` };
    } else {
        const byTitle = idx.sessions.filter((s) => s.title.toLowerCase() === r.toLowerCase());
        if (byTitle.length === 1) return { session: byTitle[0] };
    }
    const scope = idx.scope === "repo"
        ? " This session can only see the user's sessions on the same repo; if it's on another repo, the user can switch Other sessions to All your sessions in the chat box."
        : "";
    return { problem: `No session matching "${r}" among the ones you can see. list_sessions shows them.${scope}` };
}

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function index(): Promise<SessionsIndex | null> {
    try {
        return JSON.parse(await readFile(path.join(SESSIONS_DIR, "index.json"), "utf8"));
    } catch {
        return null;
    }
}

function listing(idx: SessionsIndex): string {
    if (!idx.sessions.length) return `No other sessions ${idx.scope === "repo" ? "on this repo" : "yet"}.`;
    const lines = idx.sessions.map(
        (s) => `- ${s.id}: "${s.title}" · ${s.agent} · ${s.repo} on ${s.branch} · ${s.status}${s.prUrl ? ` · ${s.prUrl}` : ""} · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${s.updatedAt}`,
    );
    return [`You are in "${idx.self.title}". Other sessions, newest first:`, ...lines].join("\n");
}

async function callTool(name: string, args: Json): Promise<Json> {
    const idx = await index();
    if (!idx) return text("Other sessions aren't available in this turn.", true);
    if (name === "list_sessions") return text(listing(idx));

    const found = findSession(idx, String(args.id ?? ""));
    if (!found.session) return text(found.problem!, true);
    const session = found.session;

    if (name === "read_session") {
        // The id is one the worker listed, so it's a plain uuid, never a path.
        return text(await readFile(path.join(SESSIONS_DIR, `${session.id}.md`), "utf8").catch(() => "Its conversation isn't available."));
    }
    if (name === "send_to_session") {
        const message = String(args.message ?? "").trim();
        if (!message) return text("The message is empty.", true);
        if (idx.canSend <= 0) {
            return text("This turn can't send messages: it's already deep in a chain of messages between sessions. Tell the user what you'd have sent instead.", true);
        }
        if (sent.has(session.id)) return text(`You've already sent "${session.title}" a message this turn.`, true);
        if (sent.size >= Math.min(idx.canSend, SESSION_LIMITS.sendsPerTurn)) return text("That's as many messages as one turn may send.", true);
        const line: OutboxMessage = { to: session.id, message: message.slice(0, SESSION_LIMITS.messageChars), replyWanted: args.reply === true };
        await appendFile(path.join(SESSIONS_DIR, "outbox.jsonl"), JSON.stringify(line) + "\n");
        sent.add(session.id);
        return text(
            `Queued for "${session.title}". It's delivered when this turn ends and runs as that session's next turn.` +
                (line.replyWanted ? " Its answer comes back to this session as a new turn, so finish this turn now rather than waiting for it." : ""),
        );
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
                serverInfo: { name: "cloudly-sessions", version: "1.0.0" },
                instructions: "The user's other Cloudly sessions: read their conversations and send them messages.",
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
