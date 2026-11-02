import { test, expect } from "bun:test";
import { symlink } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@repo/db";
import { parseDiff } from "@repo/shared/diff";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { githubReview, reviewFixPrompt, capDiff } from "../src/review";
import { createFixtureRepo } from "./test-helpers";

type Opts = { mounts?: [string, string][] };
type Agent = (ws: { runDir: string }, task: string, opts: Opts) => Promise<void>;

async function session(reviewer: string | null, extra: { reviewRounds?: number } = {}) {
  const fixture = await createFixtureRepo();
  const repo = fixture.repoPath;
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `review-${Date.now()}` } });
  const thread = await prisma.thread.create({ data: { userId: user.id, repo, baseBranch: "main", harness: "gemini-acp", title: "t", branch: `agent/review-${Date.now()}` } });
  await prisma.repoSettings.create({ data: { repo, checks: "off", reviewer, reviewRounds: extra.reviewRounds ?? 2 } });
  const seen: { harness: string; task: string }[] = [];
  const next = async (agent: Agent) => {
    const run = await claimRun("worker-review");
    if (!run) return null;
    async function* stub(ws: { runDir: string }, task: string, harness: string, _id: string, opts: Opts = {}) {
      seen.push({ harness, task });
      await agent(ws, task, opts);
      yield { seq: 0, ts: Date.now(), kind: "text" as const, data: "done" };
      yield { seq: 1, ts: Date.now(), kind: "done" as const, data: { result: "ok" } };
    }
    await processRun(run, "worker-review", stub as never);
    return prisma.run.findUniqueOrThrow({ where: { id: run.id } });
  };
  const ask = (prompt: string, kind = "turn") =>
    prisma.run.create({ data: { status: "queued", repo, baseBranch: "main", prompt, harness: "gemini-acp", userId: user.id, threadId: thread.id, kind } });
  const cleanup = async () => {
    await prisma.repoSettings.deleteMany({ where: { repo } });
    await prisma.run.deleteMany({ where: { threadId: thread.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
  };
  return { thread, next, ask, seen, cleanup };
}

const write = (name: string): Agent => async (ws) => {
  await Bun.write(path.join(ws.runDir, name), `${name}\n`);
};
/** A reviewer that reads the change and writes these findings. */
const reviewer = (findings: object[], check?: (diff: string, task: string) => void): Agent => async (_ws, _task, opts) => {
  const dir = opts.mounts!.find(([, inside]) => inside === "/workspace/.cloudly-review")![0];
  check?.(await Bun.file(path.join(dir, "changes.diff")).text(), await Bun.file(path.join(dir, "task.md")).text());
  await Bun.write(path.join(dir, "findings.json"), JSON.stringify({ summary: "Looked at it.", findings }));
};
const BUG = { file: "feature.txt", line: 1, severity: "blocking", title: "Wrong value", body: "Should be 2." };
const NIT = { file: "feature.txt", line: 1, severity: "nit", title: "Name it better" };

test("a reviewer reviews the change; blocking findings go back to the author for two rounds, then the user decides", async () => {
  const s = await session("native-codex");
  try {
    await s.ask("Add the feature");
    const turn = (await s.next(write("feature.txt")))!;
    expect(turn.status).toBe("succeeded");
    const t1 = await prisma.thread.findUniqueOrThrow({ where: { id: s.thread.id } });
    expect(t1.diff).toContain("+++ b/feature.txt");
    expect(t1.diffBase).toMatch(/^[0-9a-f]{40}$/);

    // Round 1: the reviewer is the repo's, not the session's agent, and sees the change and the ask.
    const review = (await s.next(reviewer([BUG, NIT], (diff, task) => {
      expect(diff).toContain("+feature.txt");
      expect(task).toContain("Add the feature");
    })))!;
    expect(review.kind).toBe("review");
    expect(review.harness).toBe("native-codex");
    expect(s.seen.at(-1)!.task).toStartWith("Review the changes in this session (round 1)");
    expect(review.status).toBe("succeeded");
    expect(review.commitSha).toBeNull();
    expect(review.output).toContain("1 blocking, 0 suggestions, 1 nit");
    const findings = await prisma.reviewFinding.findMany({ where: { runId: review.id }, orderBy: { severity: "asc" } });
    expect(findings.map((f) => [f.severity, f.status])).toEqual([["blocking", "sent"], ["nit", "open"]]);

    // The author fixes it, with the finding in its prompt and the review in its history.
    const fix1 = (await s.next(write("fix1.txt")))!;
    expect(fix1.kind).toBe("review_fix");
    expect(fix1.harness).toBe("gemini-acp");
    expect(fix1.prompt).toStartWith("Fix the reviewer's findings (round 1 of 2)");
    expect(fix1.prompt).toContain("Wrong value");
    expect(s.seen.at(-1)!.task).toContain("1 blocking, 0 suggestions, 1 nit");

    // Round 2 still blocking, then round 3: no third fix, the session asks the user.
    const review2 = (await s.next(reviewer([BUG])))!;
    expect(s.seen.at(-1)!.task).toContain("(round 2)");
    expect(review2.kind).toBe("review");
    expect((await s.next(write("fix2.txt")))!.prompt).toStartWith("Fix the reviewer's findings (round 2 of 2)");
    expect((await s.next(reviewer([BUG])))!.kind).toBe("review");
    expect(await s.next(write("never.txt"))).toBeNull();
    const t2 = await prisma.thread.findUniqueOrThrow({ where: { id: s.thread.id } });
    expect(t2.needsInput).toContain("still finds 1 blocking problem after 2 rounds");
    expect(t2.diff).toContain("fix2.txt");

    // A new message starts over; a clean review queues nothing.
    await s.ask("Now add docs");
    expect((await s.next(write("docs.md")))!.status).toBe("succeeded");
    const clean = (await s.next(reviewer([NIT])))!;
    expect(clean.output).toContain("0 blocking");
    expect(await s.next(write("never.txt"))).toBeNull();
  } finally {
    await s.cleanup();
  }
}, 240000);

test("without a reviewer nothing is reviewed; a reviewer that writes nothing fails without a fix", async () => {
  const off = await session(null);
  try {
    await off.ask("Change it");
    await off.next(write("a.txt"));
    expect(await off.next(write("b.txt"))).toBeNull();
  } finally {
    await off.cleanup();
  }

  const silent = await session("native-codex");
  try {
    await silent.ask("Change it");
    await silent.next(write("a.txt"));
    // A symlink to a host file isn't read as findings.
    const review = (await silent.next(async (_ws, _t, opts) => {
      await symlink("/etc/hostname", path.join(opts.mounts![0]![0], "findings.json"));
    }))!;
    expect(review.status).toBe("failed");
    expect(review.error).toContain("didn't write its findings");
    expect(await silent.next(write("b.txt"))).toBeNull();
  } finally {
    await silent.cleanup();
  }
}, 120000);

test("an audit reviews the whole repo and lists findings for the user to pick", async () => {
  const s = await session(null);
  try {
    await s.ask("Audit the repository: focus on error handling", "audit");
    const audit = (await s.next(async (_ws, task, opts) => {
      expect(task).toStartWith("Audit this repository");
      const dir = opts.mounts![0]![0];
      expect(await Bun.file(path.join(dir, "task.md")).text()).toContain("error handling");
      expect(await Bun.file(path.join(dir, "changes.diff")).exists()).toBe(false);
      await Bun.write(path.join(dir, "findings.json"), JSON.stringify([{ file: "README.md", severity: "blocking", title: "No error handling" }]));
    }))!;
    expect(audit.status).toBe("succeeded");
    expect(audit.output).toContain("No error handling");
    const findings = await prisma.reviewFinding.findMany({ where: { threadId: s.thread.id } });
    expect(findings.map((f) => [f.status, f.severity])).toEqual([["open", "blocking"]]);
    // Audit findings wait for the user, blocking or not.
    expect(await s.next(write("x.txt"))).toBeNull();
  } finally {
    await s.cleanup();
  }
}, 120000);

test("on GitHub, findings on changed lines are line comments and the rest go in the body", () => {
  const files = parseDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n x\n+y\n z\n");
  const r = githubReview("Codex (GPT)", "Overall fine.", [
    { file: "a.ts", line: 2, severity: "blocking", title: "Bug", body: "Details." },
    { file: "a.ts", line: 90, severity: "nit", title: "Far away", body: "" },
    { file: null, line: null, severity: "suggestion", title: "General", body: "Think." },
  ], files);
  expect(r.comments).toEqual([{ path: "a.ts", line: 2, side: "RIGHT", body: "**🔴 Blocking: Bug**\n\nDetails." }]);
  expect(r.body).toContain("**Cloudly review** by Codex (GPT): 1 blocking, 1 suggestions, 1 nits.");
  expect(r.body).toContain("Far away");
  expect(r.body).toContain("General** — Think.");
  expect(reviewFixPrompt("Codex", [{ file: "a.ts", line: 2, title: "Bug", body: "x\ny" }], 1, 2)).toContain("1. **Bug** (`a.ts:2`)\n   x\n   y");
  const big = "diff --git a/a b/a\n" + "+x\n".repeat(10) + "diff --git a/b b/b\n" + "+y\n".repeat(10);
  expect(capDiff(big, 60)).toBe("diff --git a/a b/a\n" + "+x\n".repeat(10));
});
