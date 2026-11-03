import { test, expect } from "bun:test";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { prisma } from "@repo/db";
import { collectSignals, saveLessons } from "../src/lessons";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";

test("what went wrong on a repo, as numbered signals; the agent's lessons saved as proposals", async () => {
  const repo = `acme/lessons-${Date.now()}`;
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `lessons-${Date.now()}` } });
  const t0 = Date.now() - 3600_000;
  const at = (s: number) => new Date(t0 + s * 1000);
  const base = { userId: user.id, repo, baseBranch: "main", harness: "native-claude" };
  try {
    const thread = await prisma.thread.create({ data: { ...base, title: "t", branch: "b" } });
    const run = (data: Record<string, unknown>) => prisma.run.create({ data: { ...base, threadId: thread.id, status: "succeeded", prompt: "x", ...data } as never });
    await run({ prompt: "Add a billing page", createdAt: at(1) });
    const turn2 = await run({ prompt: "Make it faster", createdAt: at(2), checkStatus: "failed", checkCommand: "bun test", checkOutput: "ok 1\nerror: expected 2 to be 3\nmore" });
    await run({ prompt: "No, don't edit the generated client in src/gen, change the schema instead", createdAt: at(3), rewoundAt: at(5) });
    await run({ kind: "rewind", prompt: "Rewind to after turn 2", targetRunId: turn2.id, createdAt: at(4) });
    await run({ prompt: "Use the schema and regenerate", createdAt: at(6) });
    await run({ prompt: "/compact", createdAt: at(7) });
    await run({ kind: "ci_fix", prompt: "Fix CI", createdAt: at(8), trigger: { type: "ci", checks: ["lint", "typecheck"] } });
    const review = await run({ kind: "review", prompt: "Review", createdAt: at(9) });
    await prisma.reviewFinding.create({ data: { runId: review.id, threadId: thread.id, severity: "blocking", title: "Edits generated code", body: "src/gen is generated.", file: "src/gen/client.ts", line: 3 } });
    await prisma.reviewFinding.create({ data: { runId: review.id, threadId: thread.id, severity: "suggestion", title: "Rename", body: "nit", status: "dismissed" } });
    await prisma.reviewFinding.create({ data: { runId: review.id, threadId: thread.id, severity: "nit", title: "Spacing", body: "nit" } });

    const signals = await collectSignals(repo, new Date(t0 - 1000));
    const byRef = Object.fromEntries(signals.map((s) => [s.ref, s.text]));
    expect(byRef.F1).toContain("Reviewer (suggestion): Rename. nit [The user dismissed this one.]");
    expect(byRef.F2).toBe("Reviewer (blocking, src/gen/client.ts:3): Edits generated code. src/gen is generated.");
    expect(Object.keys(byRef).filter((k) => k.startsWith("F"))).toHaveLength(2);
    expect(byRef.R1).toBe(`The user rewound turns that were asked: "No, don't edit the generated client in src/gen, change the schema instead". Then asked: "Use the schema and regenerate"`);
    // Corrections first; the first message and /commands aren't follow-ups; rewound turns are left out.
    expect(byRef.C1).toBe(`After a turn, the user said: "Use the schema and regenerate"`);
    expect(Object.values(byRef).some((t) => t.includes("Add a billing page") && t.startsWith("After a turn"))).toBe(false);
    expect(Object.values(byRef).some((t) => t.includes("/compact"))).toBe(false);
    expect(byRef.K1).toBe("Checks failed after a change (bun test): error: expected 2 to be 3");
    expect(byRef.I1).toBe("CI failed on a pull request Cloudly opened: lint, typecheck.");

    // The agent's answer.
    const lessonsRun = await prisma.run.create({ data: { ...base, status: "running", kind: "lessons", prompt: "Lessons", workerId: "w", leaseGen: 1 } });
    const dir = await mkdtemp(path.join(tmpdir(), "lessons-test-"));
    await writeFile(path.join(dir, "lessons.json"), JSON.stringify({ lessons: [
      { title: "Generated code", rule: "Never edit src/gen; change prisma/schema.prisma and run bun db:generate.", why: "The agent edited generated files twice.", evidence: ["F2", "R1", "Z9"] },
    ] }));
    await saveLessons(lessonsRun, { id: lessonsRun.id, workerId: "w", leaseGen: 1 }, dir, undefined, signals);
    const saved = await prisma.lesson.findMany({ where: { repo } });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ title: "Generated code", status: "proposed", runId: lessonsRun.id });
    expect((saved[0]!.evidence as { ref: string }[]).map((e) => e.ref)).toEqual(["F2", "R1"]);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: lessonsRun.id } })).output).toBe("1 lesson to look over:\n\n1. Generated code");
    await rm(dir, { recursive: true, force: true });

    // Too little since the last look: no agent turn at all.
    await prisma.run.update({ where: { id: lessonsRun.id }, data: { status: "succeeded", createdAt: new Date() } });
    const again = await prisma.run.create({ data: { ...base, status: "queued", kind: "lessons", prompt: "Lessons" } });
    await processRun((await claimRun("worker-lessons"))!, "worker-lessons");
    const quiet = await prisma.run.findUniqueOrThrow({ where: { id: again.id } });
    expect(quiet.status).toBe("succeeded");
    expect(quiet.output).toStartWith("Not enough to learn from yet: 0 things went wrong");
  } finally {
    await prisma.lesson.deleteMany({ where: { repo } });
    await prisma.run.deleteMany({ where: { repo } });
    await prisma.thread.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});
