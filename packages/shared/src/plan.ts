import { z } from "zod";

// A plan: a big task broken into smaller ones, each its own session and pull
// request, with the order between them. The planner agent writes it; the user
// can edit it before it starts.

export const MAX_TASKS = 12;

export const PlanTaskSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,23}$/i, "A task's key is a short name: letters, digits and dashes."),
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(6000),
  dependsOn: z.array(z.string().trim()).max(MAX_TASKS).default([]),
});
export type PlanTaskInput = z.infer<typeof PlanTaskSchema>;

export type PlanCheck = { ok: true; summary: string | null; tasks: PlanTaskInput[] } | { ok: false; error: string };

/**
 * The tasks of a plan, checked: one to twelve, unique keys, dependencies on
 * tasks that exist, and no cycles. Accepts { summary, tasks } or a bare list.
 */
export function checkPlan(raw: unknown): PlanCheck {
  const obj = Array.isArray(raw) ? { tasks: raw } : raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!obj || !Array.isArray(obj.tasks)) return { ok: false, error: "The plan has no list of tasks." };
  if (obj.tasks.length === 0) return { ok: false, error: "The plan has no tasks." };
  if (obj.tasks.length > MAX_TASKS) return { ok: false, error: `A plan can have at most ${MAX_TASKS} tasks.` };
  const tasks: PlanTaskInput[] = [];
  for (const [i, t] of obj.tasks.entries()) {
    const r = PlanTaskSchema.safeParse(t);
    if (!r.success) return { ok: false, error: `Task ${i + 1}: ${r.error.issues[0]?.message ?? "isn't valid"}` };
    tasks.push({ ...r.data, key: r.data.key.toLowerCase(), dependsOn: [...new Set(r.data.dependsOn.map((d) => d.toLowerCase()))] });
  }
  const keys = new Set<string>();
  for (const t of tasks) {
    if (keys.has(t.key)) return { ok: false, error: `Two tasks are both called "${t.key}".` };
    keys.add(t.key);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d === t.key) return { ok: false, error: `"${t.key}" can't wait for itself.` };
      if (!keys.has(d)) return { ok: false, error: `"${t.key}" waits for "${d}", which isn't in the plan.` };
    }
  }
  if (waves(tasks) === null) return { ok: false, error: "The tasks wait for each other in a circle, so none of them could start." };
  const summary = typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim().slice(0, 4000) : null;
  return { ok: true, summary, tasks };
}

/**
 * The tasks in waves: the first wave waits for nothing, each later one only for
 * earlier waves. Null when there's a cycle.
 */
export function waves<T extends { key: string; dependsOn: string[] }>(tasks: T[]): T[][] | null {
  const done = new Set<string>();
  const left = [...tasks];
  const out: T[][] = [];
  while (left.length) {
    const wave = left.filter((t) => t.dependsOn.every((d) => done.has(d)));
    if (wave.length === 0) return null;
    out.push(wave);
    for (const t of wave) {
      done.add(t.key);
      left.splice(left.indexOf(t), 1);
    }
  }
  return out;
}

/** What a task's session is told: its own job, and where it sits in the plan. */
export function taskPrompt(goal: string, task: PlanTaskInput, all: PlanTaskInput[]): string {
  const others = all.filter((t) => t.key !== task.key).map((t) => `- ${t.title}${task.dependsOn.includes(t.key) ? " (done already, merged into the base branch)" : ""}`);
  return [
    task.prompt,
    "",
    "---",
    `This is one task of a larger plan: ${goal.trim().split("\n")[0]!.slice(0, 300)}`,
    others.length ? `The plan's other tasks, each done in its own session and pull request:\n${others.join("\n")}` : "",
    "Do only this task, so its pull request stays focused. Don't start the others.",
  ].filter(Boolean).join("\n");
}
