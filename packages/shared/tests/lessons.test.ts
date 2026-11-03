import { test, expect } from "bun:test";
import { checkLessons, notesWithLesson, LESSONS_HEADING } from "../src/lessons";

test("lessons: checked, capped, and added to the notes under their own heading", () => {
  const r = checkLessons({ lessons: [
    { title: "Migrations", rule: "Run migrations with bun db:migrate, never by hand.", why: "Twice the agent edited SQL directly.", evidence: ["F1", "C3"] },
    { title: "x", rule: "too short" },
    { title: "No evidence", rule: "Keep handlers in src/routes, one file per resource." },
  ] });
  expect(r.ok && r.lessons.map((l) => [l.title, l.evidence])).toEqual([["Migrations", ["F1", "C3"]], ["No evidence", []]]);
  expect(checkLessons("nope")).toEqual({ ok: false, error: "No list of lessons in it." });

  const once = notesWithLesson("Use pnpm.", { title: "Migrations", rule: "Run migrations with bun db:migrate." });
  expect(once).toBe(`Use pnpm.\n\n${LESSONS_HEADING}\n\n- **Migrations**: Run migrations with bun db:migrate.\n`);
  const twice = notesWithLesson(`${once}\n## Other\nstuff`, { title: "Routes", rule: "One file per resource." });
  expect(twice).toContain("- **Migrations**: Run migrations with bun db:migrate.\n- **Routes**: One file per resource.\n\n## Other");
  expect(notesWithLesson(once, { title: "Migrations", rule: "Run migrations with bun db:migrate." })).toBe(once);
});
