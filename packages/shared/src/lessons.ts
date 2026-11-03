import { z } from "zod";

// Lessons: patterns in what went wrong on a repo (the reviewer's findings, turns
// the user rewound, their corrections, checks that kept failing) written up as
// short rules for its notes. An agent proposes them; the user approves.

export const LESSONS_MAX = 6;

const LessonSchema = z.object({
  title: z.string().trim().min(3).max(100),
  rule: z.string().trim().min(10).max(600),
  why: z.string().trim().max(600).optional().default(""),
  evidence: z.array(z.string().trim().regex(/^[A-Z]\d{1,4}$/)).max(20).optional().default([]),
});
export type LessonDraft = z.infer<typeof LessonSchema>;

export function checkLessons(raw: unknown): { ok: true; lessons: LessonDraft[] } | { ok: false; error: string } {
  const list = Array.isArray(raw) ? raw : (raw as { lessons?: unknown } | null)?.lessons;
  if (!Array.isArray(list)) return { ok: false, error: "No list of lessons in it." };
  const lessons: LessonDraft[] = [];
  for (const item of list.slice(0, LESSONS_MAX)) {
    const r = LessonSchema.safeParse(item);
    if (r.success) lessons.push(r.data);
  }
  return { ok: true, lessons };
}

/** How accepted lessons read in the repo's notes, which every agent on it gets. */
export const LESSONS_HEADING = "## Learned from earlier sessions";

export function notesWithLesson(notes: string, lesson: { title: string; rule: string }): string {
  const line = `- **${lesson.title.replace(/\*\*/g, "")}**: ${lesson.rule.replace(/\s+/g, " ").trim()}`;
  if (notes.includes(line)) return notes;
  const i = notes.indexOf(LESSONS_HEADING);
  if (i < 0) return `${notes.trimEnd()}${notes.trim() ? "\n\n" : ""}${LESSONS_HEADING}\n\n${line}\n`;
  // At the end of that section.
  const after = notes.indexOf("\n## ", i + LESSONS_HEADING.length);
  const end = after < 0 ? notes.length : after;
  return `${notes.slice(0, end).trimEnd()}\n${line}\n${notes.slice(end)}`;
}
