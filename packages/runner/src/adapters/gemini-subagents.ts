import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type Event = { kind: "tool_call" | "tool_result"; data: Record<string, unknown> };

/**
 * Gemini CLI runs a subagent (its invoke_agent tool) out of sight of ACP: the
 * client only sees the delegation and an empty result. Each subagent writes a
 * chat log to ~/.gemini/tmp/<project>/chats/<main session id>/<id>.jsonl, so
 * this follows those logs during a turn and reports the subagent's tool calls,
 * tagged with the invoke_agent call, and its complete_task report.
 *
 * The log doesn't name the call that started it, so logs pair with
 * invoke_agent calls in the order both appear.
 * ponytail: order pairing; if parallel delegations ever land out of order, two
 * subagents' work could swap rows. Upgrade path: match on the delegated prompt
 * once ACP carries the call's arguments.
 * Like Codex's rollouts, these logs are an internal format: anything
 * unrecognised is skipped.
 */
export class GeminiSubagents {
    /** The main ACP session; its id names the folder subagent logs go in. */
    sessionId?: string;
    private pending: string[] = [];
    private files = new Map<string, { parent: string; offset: number; seen: Set<string> }>();
    private readonly root = path.join(process.env.HOME ?? homedir(), ".gemini", "tmp");
    private readonly since = Date.now() - 1000;

    /** An invoke_agent call started; the next new subagent log is its work. */
    delegated(callId: string) {
        this.pending.push(callId);
    }

    async poll(): Promise<Event[]> {
        if (!this.sessionId) return [];
        const out: Event[] = [];
        for (const file of await this.logs()) {
            let entry = this.files.get(file);
            if (!entry) {
                const parent = this.pending[0];
                if (!parent) continue; // its call hasn't arrived yet; try again next poll
                const head = await readFrom(file, 0);
                const meta = parseLine(head.text.split("\n")[0] ?? "");
                if (meta?.kind !== "subagent") continue;
                this.pending.shift();
                entry = { parent, offset: 0, seen: new Set() };
                this.files.set(file, entry);
            }
            const { text, end } = await readFrom(file, entry.offset);
            entry.offset = end;
            for (const line of text.split("\n")) if (line) out.push(...mapChatLine(line, entry.parent, entry.seen));
        }
        return out;
    }

    private async logs(): Promise<string[]> {
        const found: string[] = [];
        for (const project of await readdir(this.root).catch(() => [])) {
            const dir = path.join(this.root, project, "chats", this.sessionId!);
            for (const name of await readdir(dir).catch(() => [])) {
                const p = path.join(dir, name);
                if (name.endsWith(".jsonl") && (this.files.has(p) || (await stat(p)).mtimeMs >= this.since)) found.push(p);
            }
        }
        return found.sort();
    }
}

function parseLine(line: string): any {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

const textOf = (result: unknown) =>
    Array.isArray(result)
        ? result.map((r: any) => (typeof r?.functionResponse?.response?.output === "string" ? r.functionResponse.response.output : "")).join("\n")
        : "";

/** complete_task's report is free text or an object whose summary is the readable part. */
export function reportText(report: unknown): string {
    if (typeof report === "string") return report;
    if (report && typeof report === "object") {
        const r = report as Record<string, unknown>;
        const summary = r.SummaryOfFindings ?? r.summary ?? r.Summary;
        if (typeof summary === "string") return summary;
    }
    return report === undefined ? "" : JSON.stringify(report, null, 2);
}

/**
 * One line of a subagent's chat log, as tagged events. A message is written
 * more than once as it fills in, so calls already reported are skipped.
 */
export function mapChatLine(line: string, parent: string, seen: Set<string>): Event[] {
    const r = parseLine(line);
    if (!r || r.type !== "gemini" || !Array.isArray(r.toolCalls)) return [];
    const out: Event[] = [];
    for (const tc of r.toolCalls) {
        if (typeof tc?.id !== "string" || seen.has(tc.id) || !tc.result) continue;
        seen.add(tc.id);
        if (tc.name === "complete_task") {
            out.push({ kind: "tool_result", data: { id: parent, status: "completed", content: reportText(tc.args?.report) } });
            continue;
        }
        out.push(
            { kind: "tool_call", data: { id: tc.id, name: tc.name, input: tc.args ?? {}, parent } },
            { kind: "tool_result", data: { id: tc.id, status: tc.status === "success" ? "completed" : String(tc.status ?? ""), content: [{ type: "content", content: { type: "text", text: textOf(tc.result) } }], parent } },
        );
    }
    return out;
}

/** Whole lines from `offset` on; a line still being written waits for the next read. */
async function readFrom(file: string, offset: number, max = 4 * 1024 * 1024) {
    const fh = await open(file, "r");
    try {
        const { size } = await fh.stat();
        const length = Math.min(max, Math.max(0, size - offset));
        const buf = Buffer.alloc(length);
        if (length) await fh.read(buf, 0, length, offset);
        const complete = buf.lastIndexOf(0x0a) + 1;
        return { text: buf.subarray(0, complete).toString("utf8"), end: offset + complete };
    } finally {
        await fh.close();
    }
}
