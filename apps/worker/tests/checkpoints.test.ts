import { test, expect } from "bun:test";
import path from "node:path";

import { prisma } from "@repo/db";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { promptWithHistory } from "../src/transcript";
import { createFixtureRepo } from "./test-helpers";

const git = (repo: string, ...args: string[]) => Bun.$`git -C ${repo} ${args}`.quiet().text().then((s) => s.trim());

/** A session whose branch has three turns' commits, A, B and C, in a fixture repo. */
async function sessionWithTurns() {
  const fixture = await createFixtureRepo();
  const repo = fixture.repoPath;
  const branch = `agent/cp-${Date.now()}`;
  await git(repo, "checkout", "-q", "-b", branch);
  const shas: string[] = [];
  for (const f of ["a", "b", "c"]) {
    await Bun.write(path.join(repo, `${f}.txt`), `${f}\n`);
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", f);
    shas.push(await git(repo, "rev-parse", "HEAD"));
  }
  // Back on the default branch, so the session branch isn't checked out (it can be pushed to).
  await git(repo, "checkout", "-q", "-");
  const base = await git(repo, "rev-parse", "HEAD");
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `cp-${Date.now()}` } });
  const thread = await prisma.thread.create({
    data: { userId: user.id, repo, baseBranch: "main", harness: "native-claude", title: "Billing", branch, agentSessionId: "agent-session-1" },
  });
  const t0 = Date.now() - 60_000;
  const turns = [];
  // A question first (no commit), then three turns that each committed.
  turns.push(await prisma.run.create({ data: { userId: user.id, threadId: thread.id, repo, baseBranch: "main", harness: "native-claude", prompt: "How is billing laid out?", status: "succeeded", createdAt: new Date(t0) } }));
  for (const [i, sha] of shas.entries()) {
    turns.push(await prisma.run.create({ data: { userId: user.id, threadId: thread.id, repo, baseBranch: "main", harness: "native-claude", prompt: `step ${i + 1}`, status: "succeeded", commitSha: sha, createdAt: new Date(t0 + (i + 1) * 1000) } }));
  }
  const run = async () => processRun((await claimRun("worker-cp"))!, "worker-cp");
  const cleanup = async () => {
    await prisma.thread.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
  };
  return { repo, branch, shas, base, user, thread, turns, run, cleanup };
}

test("rewinding resets the branch to that turn's commit and takes the later turns out of the agent's history", async () => {
  const s = await sessionWithTurns();
  try {
    const rewind = await prisma.run.create({
      data: { userId: s.user.id, threadId: s.thread.id, repo: s.repo, baseBranch: "main", harness: "native-claude", status: "queued", kind: "rewind", targetRunId: s.turns[1]!.id, prompt: "Rewind to after turn 2" },
    });
    await s.run();
    const done = await prisma.run.findUniqueOrThrow({ where: { id: rewind.id } });
    expect(done.status).toBe("succeeded");
    expect(done.output).toBe("Rewound to after turn 2.");
    expect(await git(s.repo, "rev-parse", s.branch)).toBe(s.shas[0]!);

    const turns = await prisma.run.findMany({ where: { threadId: s.thread.id, kind: "turn" }, orderBy: { createdAt: "asc" } });
    expect(turns.map((t) => Boolean(t.rewoundAt))).toEqual([false, false, true, true]);
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: s.thread.id } });
    expect(thread.agentSessionId).toBeNull();
    expect(thread.diff).toContain("+++ b/a.txt");
    expect(thread.diff).not.toContain("b.txt");

    const history = await promptWithHistory(s.thread.id, "none", "native-claude", "next");
    expect(history).toContain("step 1");
    expect(history).not.toContain("step 2");
    expect(history).not.toContain("Rewind to after");

    // Back to before any change: the branch goes back to the base.
    await prisma.run.create({
      data: { userId: s.user.id, threadId: s.thread.id, repo: s.repo, baseBranch: "main", harness: "native-claude", status: "queued", kind: "rewind", targetRunId: s.turns[0]!.id, prompt: "Rewind to after turn 1" },
    });
    await s.run();
    expect(await git(s.repo, "rev-parse", s.branch)).toBe(s.base);
    expect((await prisma.thread.findUniqueOrThrow({ where: { id: s.thread.id } })).diff).toBe("");
  } finally {
    await s.cleanup();
  }
}, 120000);

test("a fork gets a branch at the checkpoint and the conversation up to it", async () => {
  const s = await sessionWithTurns();
  try {
    const fork = await prisma.thread.create({
      data: { userId: s.user.id, repo: s.repo, baseBranch: "main", harness: "native-codex", title: "Billing (fork)", branch: `agent/fork-${Date.now()}`, forkOfThreadId: s.thread.id, forkAtRunId: s.turns[2]!.id },
    });
    const forkRun = await prisma.run.create({
      data: { userId: s.user.id, threadId: fork.id, repo: s.repo, baseBranch: "main", harness: "native-codex", status: "queued", kind: "fork", targetRunId: s.turns[2]!.id, prompt: "Fork" },
    });
    await s.run();
    expect((await prisma.run.findUniqueOrThrow({ where: { id: forkRun.id } })).output).toBe('Forked from "Billing" after turn 3.');
    expect(await git(s.repo, "rev-parse", fork.branch)).toBe(s.shas[1]!);
    // The parent is untouched.
    expect(await git(s.repo, "rev-parse", s.branch)).toBe(s.shas[2]!);
    const forked = await prisma.thread.findUniqueOrThrow({ where: { id: fork.id } });
    expect(forked.diff).toContain("b.txt");
    expect(forked.diff).not.toContain("c.txt");

    const history = await promptWithHistory(fork.id, "none", "native-codex", "try it another way");
    expect(history).toContain("How is billing laid out?");
    expect(history).toContain("step 2");
    expect(history).not.toContain("step 3");
  } finally {
    await s.cleanup();
  }
}, 120000);
