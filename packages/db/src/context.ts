import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./client";

// Shared context for a repo (opt-in). Every agent working on the repo reads the
// same notes and the same log of recent work, whichever agent it is, and adds to
// it: Cloudly's own sessions automatically, and local editors (Cursor, Claude
// Code) through the context MCP endpoint with a personal token.

export const CONTEXT_LIMITS = {
  notes: 20_000,
  title: 200,
  body: 4_000,
  /** What a turn's preamble or a tool call gets back, at most. */
  snapshot: 8_000,
  /** Notes an agent may add in one turn. */
  notesPerTurn: 20,
};

const HARNESS_NAMES: Record<string, string> = {
  "native-claude": "Claude Agent",
  "native-codex": "Codex",
  "gemini-acp": "Gemini CLI",
};
export const authorName = (author: string) => HARNESS_NAMES[author] ?? author;

export async function contextEnabled(repo: string): Promise<boolean> {
  return Boolean((await prisma.repoContext.findUnique({ where: { repo } }))?.enabled);
}

export interface ContextSnapshot {
  repo: string;
  notes: string;
  entries: {
    id: string;
    kind: string;
    author: string;
    source: string;
    title: string;
    body: string;
    threadId: string | null;
    prUrl: string | null;
    createdAt: Date;
  }[];
}

/** The repo's notes and its latest entries, newest first. A session's own turns can be left out: it already has them. */
export async function contextSnapshot(repo: string, opts: { excludeThreadId?: string; limit?: number } = {}): Promise<ContextSnapshot> {
  const [row, entries] = await Promise.all([
    prisma.repoContext.findUnique({ where: { repo } }),
    prisma.contextEntry.findMany({
      where: { repo, ...(opts.excludeThreadId ? { OR: [{ threadId: null }, { threadId: { not: opts.excludeThreadId } }] } : {}) },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(opts.limit ?? 12, 1), 50),
    }),
  ]);
  return {
    repo,
    notes: row?.notes ?? "",
    entries: entries.map(({ id, kind, author, source, title, body, threadId, prUrl, createdAt }) => ({ id, kind, author, source, title, body, threadId, prUrl, createdAt })),
  };
}

const day = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

/**
 * The snapshot as Markdown, for an agent to read: notes first (they're the
 * rules), then recent work. Cut to `maxChars`, dropping the oldest work first.
 */
export function contextMarkdown(snap: ContextSnapshot, maxChars = CONTEXT_LIMITS.snapshot): string {
  const head = [`# Shared context for ${snap.repo}`, "", "## Notes", "", snap.notes.trim() || "_No notes yet._", "", "## Recent work", ""];
  let text = head.join("\n");
  if (text.length > maxChars) return `${text.slice(0, maxChars - 20)}\n\n_(cut short)_\n`;
  const lines: string[] = [];
  for (const e of snap.entries) {
    const label = e.kind === "turn" ? "Turn" : e.kind === "decision" ? "Decision" : "Note";
    const where = e.source === "mcp" ? ` (from ${e.author})` : ` (${authorName(e.author)})`;
    const pr = e.prUrl ? ` · ${e.prUrl}` : "";
    const body = e.body.trim() ? `\n  ${e.body.trim().replace(/\n/g, "\n  ")}` : "";
    const item = `- **${label}**${where}, ${day(e.createdAt)} UTC: ${e.title}${pr}${body}\n`;
    if (text.length + lines.join("").length + item.length > maxChars) {
      lines.push(`- _…and older entries, not shown._\n`);
      break;
    }
    lines.push(item);
  }
  return text + (lines.length ? lines.join("") : "_Nothing yet._\n");
}

export async function addContextEntry(entry: {
  repo: string;
  kind: "turn" | "note" | "decision";
  author: string;
  source: "cloudly" | "mcp";
  title: string;
  body?: string;
  threadId?: string | null;
  runId?: string | null;
  prUrl?: string | null;
}): Promise<string> {
  const row = await prisma.contextEntry.create({
    data: {
      ...entry,
      title: entry.title.trim().slice(0, CONTEXT_LIMITS.title) || "(untitled)",
      body: (entry.body ?? "").trim().slice(0, CONTEXT_LIMITS.body),
    },
  });
  return row.id;
}

export async function setContextNotes(repo: string, notes: string): Promise<void> {
  const clipped = notes.slice(0, CONTEXT_LIMITS.notes);
  await prisma.repoContext.upsert({ where: { repo }, update: { notes: clipped }, create: { repo, notes: clipped } });
}

// ---------- Personal tokens for local tools ----------

export const hashAccessToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** A new token. The raw value is shown once; only its hash is kept. */
export async function createAccessToken(userId: string, name: string): Promise<{ id: string; token: string }> {
  const token = `cly_${randomBytes(24).toString("base64url")}`;
  const row = await prisma.accessToken.create({ data: { userId, name: name.trim().slice(0, 80) || "Editor", hash: hashAccessToken(token) } });
  return { id: row.id, token };
}

export async function accessTokenOwner(raw: string | null | undefined): Promise<{ userId: string; name: string } | null> {
  if (!raw?.startsWith("cly_")) return null;
  const row = await prisma.accessToken.findUnique({ where: { hash: hashAccessToken(raw) } });
  if (!row) return null;
  // At most once a minute, so a busy editor isn't a write per call.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await prisma.accessToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return { userId: row.userId, name: row.name };
}
