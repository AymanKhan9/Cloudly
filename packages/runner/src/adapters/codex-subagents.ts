import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type Event = { kind: "tool_call" | "tool_result"; data: Record<string, unknown> };

/**
 * Codex runs subagents (its spawn_agent tool) in threads of their own, and
 * `codex exec --json` only reports the main thread. Each thread writes a
 * rollout log under CODEX_HOME/sessions, and a subagent's first line names its
 * parent thread. This follows those logs during a turn and reports each
 * subagent's work in the shape the Claude adapter uses: an "Agent" call, then
 * the subagent's own calls tagged with `parent`, then its report.
 *
 * ponytail: rollout logs are Codex's internal format, not an API. Anything
 * unrecognised is skipped, so a format change hides subagent detail rather than
 * breaking the turn. Upgrade path: switch to exec events if Codex starts
 * exporting subagent items there.
 */
export class CodexSubagents {
    private files = new Map<string, { id: string; offset: number }>();
    private known = new Set<string>();
    private readonly root = path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "sessions");
    private readonly since = Date.now() - 1000;

    /** The main thread, from `thread.started`; subagents name it as their parent. */
    threadId?: string;

    async poll(): Promise<Event[]> {
        if (!this.threadId) return [];
        this.known.add(this.threadId);
        const out: Event[] = [];
        for (const file of await this.recent()) {
            let entry = this.files.get(file);
            if (!entry) {
                const meta = await firstLine(file);
                const spawn = meta?.payload?.source?.subagent?.thread_spawn;
                const id = meta?.payload?.id;
                // Only subagents of this turn's thread, or of its own subagents.
                if (!spawn || typeof id !== "string" || !this.known.has(spawn.parent_thread_id)) continue;
                this.known.add(id);
                entry = { id, offset: 0 };
                this.files.set(file, entry);
                out.push(spawnEvent(id, spawn, spawn.parent_thread_id === this.threadId ? undefined : spawn.parent_thread_id));
            }
            const { text, end } = await readFrom(file, entry.offset);
            entry.offset = end;
            for (const line of text.split("\n")) if (line) out.push(...mapRolloutLine(line, entry.id));
        }
        return out;
    }

    private async recent(): Promise<string[]> {
        const found: string[] = [];
        const walk = async (dir: string) => {
            for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
                const p = path.join(dir, d.name);
                if (d.isDirectory()) await walk(p);
                else if (d.name.endsWith(".jsonl") && (this.files.has(p) || (await stat(p)).mtimeMs >= this.since)) found.push(p);
            }
        };
        await walk(this.root);
        return found;
    }
}

function spawnEvent(id: string, spawn: Record<string, any>, parent?: string): Event {
    const task = typeof spawn.agent_path === "string" ? spawn.agent_path.split("/").pop()! : "subagent";
    return {
        kind: "tool_call",
        data: {
            id,
            name: "Agent",
            input: {
                subagent_type: spawn.agent_role ?? spawn.agent_nickname ?? "subagent",
                description: task.replace(/_/g, " "),
            },
            ...(parent ? { parent } : {}),
        },
    };
}

/** One rollout line of a subagent's log, as tagged events. */
export function mapRolloutLine(line: string, subagentId: string): Event[] {
    let r: any;
    try {
        r = JSON.parse(line);
    } catch {
        return [];
    }
    const p = r?.payload;
    if (r?.type !== "event_msg" || !p) return [];

    if (p.type === "item_completed" && p.item?.type === "CommandExecution") {
        const it = p.item;
        const command = Array.isArray(it.command) ? it.command.at(-1) : it.command;
        return [
            { kind: "tool_call", data: { id: it.id, type: "command_execution", command, parent: subagentId } },
            {
                kind: "tool_result",
                data: { id: it.id, type: "command_execution", exit_code: it.exit_code, aggregated_output: it.aggregated_output ?? "", parent: subagentId },
            },
        ];
    }
    if (p.type === "item_completed" && p.item?.type === "FileChange") {
        const changes = p.item.changes;
        const paths = Array.isArray(changes) ? changes.map((c: any) => c?.path).filter(Boolean) : changes && typeof changes === "object" ? Object.keys(changes) : [];
        return [{ kind: "tool_result", data: { id: p.item.id, type: "file_change", changes: paths.map((path: string) => ({ path })), parent: subagentId } }];
    }
    if (p.type === "task_complete") {
        return [{ kind: "tool_result", data: { toolUseId: subagentId, content: p.last_agent_message ?? "" } }];
    }
    return [];
}

async function firstLine(file: string): Promise<any> {
    const { text } = await readFrom(file, 0);
    try {
        return JSON.parse(text.split("\n")[0]!);
    } catch {
        return null;
    }
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
