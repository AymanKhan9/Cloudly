import { test, expect } from "bun:test";
import { checkPlan, waves, taskPrompt } from "../src/plan";

const t = (key: string, dependsOn: string[] = []) => ({ key, title: `Task ${key}`, prompt: `Do ${key}`, dependsOn });

test("a plan's tasks are checked: keys, dependencies and cycles", () => {
  const ok = checkPlan({ summary: "Three steps.", tasks: [t("schema"), t("API", ["schema"]), t("ui", ["api", "API"])] });
  // Keys are lowercased (titles and prompts aren't), and repeated dependencies drop out.
  expect(ok).toEqual({ ok: true, summary: "Three steps.", tasks: [t("schema"), { ...t("API", ["schema"]), key: "api" }, t("ui", ["api"])] });
  expect(checkPlan([t("a")]).ok).toBe(true);
  expect(checkPlan({ tasks: [] })).toEqual({ ok: false, error: "The plan has no tasks." });
  expect(checkPlan({ tasks: [t("a"), t("a")] })).toMatchObject({ ok: false, error: 'Two tasks are both called "a".' });
  expect(checkPlan({ tasks: [t("a", ["b"])] })).toMatchObject({ error: '"a" waits for "b", which isn\'t in the plan.' });
  expect(checkPlan({ tasks: [t("a", ["a"])] })).toMatchObject({ error: '"a" can\'t wait for itself.' });
  expect(checkPlan({ tasks: [t("a", ["b"]), t("b", ["c"]), t("c", ["a"])] })).toMatchObject({ error: expect.stringContaining("circle") });
  expect(checkPlan({ tasks: Array.from({ length: 13 }, (_, i) => t(`t${i}`)) })).toMatchObject({ ok: false });
  expect(checkPlan({ tasks: [{ key: "bad key!", title: "x", prompt: "y" }] })).toMatchObject({ ok: false, error: expect.stringContaining("Task 1") });
});

test("tasks group into waves that can run side by side", () => {
  const w = waves([t("ui", ["api"]), t("schema"), t("docs"), t("api", ["schema"])]);
  expect(w!.map((wave) => wave.map((x) => x.key))).toEqual([["schema", "docs"], ["api"], ["ui"]]);
  expect(waves([t("a", ["b"]), t("b", ["a"])])).toBeNull();
});

test("a task's session is told its job and where it sits", () => {
  const all = [t("schema"), t("api", ["schema"])];
  const p = taskPrompt("Add multi-currency billing", all[1]!, all);
  expect(p).toStartWith("Do api");
  expect(p).toContain("one task of a larger plan: Add multi-currency billing");
  expect(p).toContain("- Task schema (done already, merged into the base branch)");
  expect(p).toContain("Do only this task");
});
