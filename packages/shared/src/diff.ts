import { z } from "zod";

// A unified diff (git diff output), parsed for showing it file by file and for
// knowing which lines a comment can be attached to.

export interface DiffLine {
  type: "context" | "add" | "del";
  text: string;
  /** Line number on the old side (context and deletions). */
  oldLine?: number;
  /** Line number on the new side (context and additions). */
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** The path on the new side ("a/b.ts"), or the old one for a deletion. */
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

const unquote = (p: string) => {
  // git quotes paths with unusual characters: "a/dir/caf\303\251.txt"
  if (!p.startsWith('"')) return p;
  try {
    const bytes: number[] = [];
    const body = p.slice(1, -1);
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      if (ch !== "\\") {
        bytes.push(...new TextEncoder().encode(ch));
        continue;
      }
      const next = body[++i]!;
      if (/[0-7]/.test(next)) {
        bytes.push(parseInt(body.slice(i, i + 3), 8));
        i += 2;
      } else {
        bytes.push({ n: 10, t: 9, '"': 34, "\\": 92 }[next as "n"] ?? next.charCodeAt(0));
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch {
    return p;
  }
};
const strip = (p: string) => unquote(p).replace(/^[ab]\//, "");

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/^diff --git (\S+|"[^"]*") (\S+|"[^"]*")$/);
      const b = m ? strip(m[2]!) : raw.slice(11);
      file = { path: b, oldPath: m ? strip(m[1]!) : null, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (raw.startsWith("new file mode")) file.status = "added";
      else if (raw.startsWith("deleted file mode")) file.status = "deleted";
      else if (raw.startsWith("rename from ")) { file.status = "renamed"; file.oldPath = unquote(raw.slice(12)); }
      else if (raw.startsWith("rename to ")) file.path = unquote(raw.slice(10));
      else if (raw.startsWith("Binary files ") || raw === "GIT binary patch") file.binary = true;
      else if (raw.startsWith("--- ")) { const p = raw.slice(4); if (p !== "/dev/null") file.oldPath = strip(p); }
      else if (raw.startsWith("+++ ")) { const p = raw.slice(4); if (p !== "/dev/null") file.path = strip(p); }
    }
    const h = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("+")) {
      hunk.lines.push({ type: "add", text: raw.slice(1), newLine: newNo++ });
      file.additions++;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ type: "del", text: raw.slice(1), oldLine: oldNo++ });
      file.deletions++;
    } else if (raw.startsWith(" ")) {
      hunk.lines.push({ type: "context", text: raw.slice(1), oldLine: oldNo++, newLine: newNo++ });
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
    } else if (raw.startsWith("diff ") || raw === "") {
      hunk = raw === "" ? hunk : null;
    }
  }
  for (const f of files) if (f.status === "modified" && f.oldPath && f.oldPath !== f.path) f.status = "renamed";
  return files;
}

/** Whether a comment can be attached to this new-side line (GitHub only allows lines inside the diff). */
export function lineInDiff(files: DiffFile[], file: string, line: number): boolean {
  const f = files.find((x) => x.path === file);
  return Boolean(f?.hunks.some((h) => h.lines.some((l) => l.newLine === line && l.type !== "del")));
}

// A reviewer's findings, as the reviewer writes them. Read from a file the agent
// wrote, so every field is checked and capped.

export const SEVERITIES = ["blocking", "suggestion", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FindingSchema = z.object({
  file: z.string().trim().max(500).nullish().transform((v) => (v ? v.replace(/^\/?workspace\//, "").replace(/^\.\//, "") : null)),
  line: z.coerce.number().int().positive().max(10_000_000).nullish().catch(null).transform((v) => v ?? null),
  severity: z.string().transform((v) => {
    const s = v.toLowerCase().trim();
    if (["blocking", "blocker", "critical", "high", "bug", "error", "major"].includes(s)) return "blocking" as const;
    if (["nit", "nitpick", "style", "trivial", "minor"].includes(s)) return "nit" as const;
    return "suggestion" as const;
  }),
  title: z.string().trim().min(1).transform((v) => v.slice(0, 200)),
  body: z.string().trim().default("").transform((v) => v.slice(0, 4000)),
});
export type Finding = z.infer<typeof FindingSchema>;

/** The findings in what a reviewer wrote: a list, or {summary, findings}. Malformed entries are dropped. */
export function parseFindings(raw: unknown): { summary: string | null; findings: Finding[] } {
  const obj = Array.isArray(raw) ? { findings: raw } : raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: Finding[] = [];
  for (const item of list.slice(0, 100)) {
    const r = FindingSchema.safeParse(item);
    if (r.success) findings.push(r.data);
    if (findings.length >= 50) break;
  }
  const summary = typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim().slice(0, 4000) : null;
  return { summary, findings };
}

export interface Feedback {
  findings?: { file: string | null; line: number | null; title: string; body: string }[];
  comments?: { file: string; line: number; body: string }[];
  note?: string;
}

const where = (file: string | null, line: number | null) => (file ? ` (\`${file}${line ? `:${line}` : ""}\`)` : "");
const indent = (text: string) => text.replace(/\n/g, "\n   ");

/** The turn the user sends from the Changes tab: picked findings, line comments and a note. The first line is its title. */
export function feedbackPrompt(f: Feedback): string {
  const findings = f.findings ?? [];
  const comments = f.comments ?? [];
  const title = findings.length && !comments.length ? `Fix ${findings.length === 1 ? "this finding" : `these ${findings.length} findings`}` : "Address my comments on the changes";
  const parts = [title];
  if (f.note?.trim()) parts.push("", f.note.trim());
  if (findings.length) {
    parts.push("", ...findings.map((x, i) => `${i + 1}. **${x.title}**${where(x.file, x.line)}${x.body ? `\n   ${indent(x.body)}` : ""}`));
  }
  if (comments.length) {
    parts.push("", "Comments on lines of the change:", "", ...comments.map((c) => `- \`${c.file}:${c.line}\`: ${indent(c.body.trim())}`));
  }
  return parts.join("\n");
}
