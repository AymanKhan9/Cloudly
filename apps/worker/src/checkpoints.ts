import { prisma } from "@repo/db";
import type { Run } from "@repo/shared/run";

import { createWorkspace, destroyWorkspace, type Workspace } from "./workspace";
import { resolveCloneSource } from "./github";
import { insertEvents } from "./events";
import { branchDiff, baseRef } from "./review";

// Checkpoints. Every turn that changes code is a commit on the session's
// branch, so each one is a point to go back to:
//
//   rewind  resets the branch to just after a turn (force-with-lease, so a
//           push nobody expected makes it fail instead of being lost), and
//           marks the later turns rewound: they leave the agent's history, and
//           the agent's own session (which remembers them) is dropped.
//   fork    starts a new session whose branch begins at a turn's checkpoint,
//           with the conversation up to there as its history.
//
// Both are queued turns of their own, so they wait for the session's running
// turn and never race it.

/** The commit a session was at just after a turn: its latest commit up to then, or the base. */
async function checkpoint(threadId: string, at: { createdAt: Date }, ws: Workspace, baseBranch: string) {
  const commit = await prisma.run.findFirst({
    where: { threadId, commitSha: { not: null }, rewoundAt: null, createdAt: { lte: at.createdAt } },
    orderBy: { createdAt: "desc" },
    select: { commitSha: true },
  });
  if (commit?.commitSha) return { sha: commit.commitSha, isBase: false };
  const ref = await baseRef(ws.mirrorDir, baseBranch, true);
  const sha = (await Bun.$`git --git-dir=${ws.mirrorDir} rev-parse ${ref}`.quiet().text()).trim();
  return { sha, isBase: true };
}

/** "turn 3": where a turn sits in its session. */
async function turnNumber(threadId: string, runId: string): Promise<number> {
  const runs = await prisma.run.findMany({ where: { threadId, kind: { notIn: ["rewind", "fork", "import", "screenshots"] } }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return runs.findIndex((r) => r.id === runId) + 1;
}

const hasCommit = async (ws: Workspace, sha: string) =>
  (await Bun.$`git --git-dir=${ws.mirrorDir} cat-file -e ${`${sha}^{commit}`}`.nothrow().quiet()).exitCode === 0;

export async function processCheckpoint(run: Run, workerId: string): Promise<void> {
  const fenced = { id: run.id, workerId, leaseGen: run.leaseGen };
  let ws: Workspace | undefined;
  const say = async (text: string) => {
    await insertEvents(run.id, [
      { seq: 0, ts: Date.now(), kind: "text", data: text },
      { seq: 1, ts: Date.now(), kind: "done", data: { result: text } },
    ]);
  };
  try {
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: run.threadId! } });
    const source = await resolveCloneSource(run.repo);

    if (run.kind === "rewind") {
      const target = await prisma.run.findFirstOrThrow({ where: { id: run.targetRunId ?? "", threadId: thread.id } });
      ws = await createWorkspace(source, { branch: thread.branch, baseBranch: run.baseBranch });
      const to = await checkpoint(thread.id, target, ws, run.baseBranch);
      if (!(await hasCommit(ws, to.sha))) throw new Error("That turn's commit isn't on the branch any more, so the session can't go back to it.");

      // Reset the branch, unless it was never pushed (nothing to reset) or is there already.
      const onRemote = (await Bun.$`git --git-dir=${ws.mirrorDir} rev-parse --verify --quiet refs/heads/${thread.branch}`.nothrow().quiet()).exitCode === 0;
      if (onRemote) {
        const current = (await Bun.$`git --git-dir=${ws.mirrorDir} rev-parse refs/heads/${thread.branch}`.quiet().text()).trim();
        if (current !== to.sha) {
          const lease = `--force-with-lease=refs/heads/${thread.branch}:${current}`;
          const pushed = await Bun.$`git --git-dir=${ws.mirrorDir} push --quiet ${lease} ${source} ${`${to.sha}:refs/heads/${thread.branch}`}`.nothrow().quiet();
          if (pushed.exitCode !== 0) throw new Error("The branch changed while rewinding (someone pushed to it), so it was left as it is.");
        }
      }

      const diff = to.isBase ? null : await branchDiff(ws.mirrorDir, await baseRef(ws.mirrorDir, run.baseBranch, true), to.sha);
      const n = await turnNumber(thread.id, target.id);
      const moved = await prisma.$transaction(async (tx) => {
        const r = await tx.run.updateMany({ where: fenced, data: { status: "succeeded", output: `Rewound to after turn ${n}.` } });
        if (r.count === 0) return false;
        await tx.run.updateMany({
          where: { threadId: thread.id, createdAt: { gt: target.createdAt }, id: { not: run.id }, rewoundAt: null },
          data: { rewoundAt: new Date() },
        });
        // The agent's own session remembers the rewound turns: the next turn starts clean.
        await tx.thread.update({
          where: { id: thread.id },
          data: { agentSessionId: null, agentSessionCost: null, needsInput: null, diff: diff?.diff ?? "", diffBase: diff?.base ?? null, updatedAt: new Date() },
        });
        return true;
      });
      if (moved) await say(`Rewound to after turn ${n}. The branch is back where it was then${to.isBase ? " (before any change)" : ""}, and the later turns are left out of the agent's history.`);
      return;
    }

    if (run.kind === "fork") {
      const parent = await prisma.thread.findUniqueOrThrow({ where: { id: thread.forkOfThreadId ?? "" } });
      const target = await prisma.run.findFirstOrThrow({ where: { id: run.targetRunId ?? "", threadId: parent.id } });
      ws = await createWorkspace(source, { branch: parent.branch, baseBranch: run.baseBranch });
      const to = await checkpoint(parent.id, target, ws, run.baseBranch);
      if (!(await hasCommit(ws, to.sha))) throw new Error("That turn's commit isn't on the branch any more, so the session can't be forked from it.");
      // The new branch starts there. At the base there's nothing to push: it starts from the base branch.
      if (!to.isBase) {
        const pushed = await Bun.$`git --git-dir=${ws.mirrorDir} push --quiet ${source} ${`${to.sha}:refs/heads/${thread.branch}`}`.nothrow().quiet();
        if (pushed.exitCode !== 0) throw new Error(`Couldn't make the branch ${thread.branch}: ${pushed.stderr.toString().split("\n")[0]}`);
      }
      const diff = to.isBase ? null : await branchDiff(ws.mirrorDir, await baseRef(ws.mirrorDir, run.baseBranch, true), to.sha);
      const n = await turnNumber(parent.id, target.id);
      const r = await prisma.run.updateMany({ where: fenced, data: { status: "succeeded", output: `Forked from "${parent.title}" after turn ${n}.` } });
      if (r.count === 0) return;
      await prisma.thread.update({ where: { id: thread.id }, data: { diff: diff?.diff ?? "", diffBase: diff?.base ?? null } });
      await say(`Forked from "${parent.title}" after turn ${n}. This session's branch starts there, and the agent has the conversation up to that turn.`);
      return;
    }
    throw new Error(`Not a checkpoint turn: ${run.kind}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.run.updateMany({ where: fenced, data: { status: "failed", error: message } });
  } finally {
    if (ws) await destroyWorkspace(ws);
  }
}
