import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { addContextEntry, contextEnabled, contextMarkdown, contextSnapshot, CONTEXT_LIMITS } from "@repo/db";
import { readRegular } from "./repo-files";

// A repo's shared context in a run (see @repo/db context): the snapshot goes in
// at /context/context.md and in front of the task; notes the agent adds through
// its context tools come back from /context/new-notes.jsonl, read the way the
// patch is, since the agent could have left anything there.

export interface ContextDir {
  dir: string;
  markdown: string;
}

/** Null when the repo hasn't turned shared context on. */
export async function prepareContext(repo: string, threadId?: string | null): Promise<ContextDir | null> {
  if (!(await contextEnabled(repo))) return null;
  const markdown = contextMarkdown(await contextSnapshot(repo, { excludeThreadId: threadId ?? undefined }));
  const dir = await mkdtemp(path.join(tmpdir(), "run-context-"));
  await writeFile(path.join(dir, "context.md"), markdown);
  await writeFile(path.join(dir, "new-notes.jsonl"), "");
  return { dir, markdown };
}

export interface AgentNote {
  kind: "note" | "decision";
  title: string;
  text: string;
}

/** Notes the agent added this turn. Malformed lines, and anything past the limits, are dropped. */
export async function collectNotes(ctx: ContextDir): Promise<AgentNote[]> {
  const bytes = await readRegular(path.join(ctx.dir, "new-notes.jsonl"), 256 * 1024);
  if (!bytes) return [];
  const notes: AgentNote[] = [];
  for (const line of new TextDecoder().decode(bytes).split("\n")) {
    if (!line.trim() || notes.length >= CONTEXT_LIMITS.notesPerTurn) continue;
    try {
      const n = JSON.parse(line);
      if (typeof n?.title !== "string" || !n.title.trim()) continue;
      notes.push({ kind: n.kind === "decision" ? "decision" : "note", title: n.title, text: typeof n.text === "string" ? n.text : "" });
    } catch {}
  }
  return notes;
}

/** Saves the agent's notes and a record of the turn itself. */
export async function recordTurn(
  ctx: ContextDir,
  turn: { repo: string; harness: string; threadId?: string | null; runId: string; prompt: string; summary?: string; prUrl?: string | null; stats?: { filesChanged: number; additions: number; deletions: number } },
): Promise<void> {
  for (const n of await collectNotes(ctx)) {
    await addContextEntry({ repo: turn.repo, kind: n.kind, author: turn.harness, source: "cloudly", title: n.title, body: n.text, threadId: turn.threadId, runId: turn.runId });
  }
  const changed = turn.stats?.filesChanged
    ? `Changed ${turn.stats.filesChanged} file${turn.stats.filesChanged === 1 ? "" : "s"} (+${turn.stats.additions} −${turn.stats.deletions}).`
    : "Changed no files.";
  await addContextEntry({
    repo: turn.repo,
    kind: "turn",
    author: turn.harness,
    source: "cloudly",
    title: turn.prompt.trim().split("\n")[0]!.slice(0, 160),
    body: [changed, turn.summary?.trim().slice(0, 1500)].filter(Boolean).join("\n"),
    threadId: turn.threadId,
    runId: turn.runId,
    prUrl: turn.prUrl,
  });
}

export async function destroyContext(ctx: ContextDir): Promise<void> {
  await rm(ctx.dir, { recursive: true, force: true });
}
