import { prisma } from "@repo/db";

import { github as realGitHub, type GitHubPort } from "./github";
import { repoSettings } from "./checks";
import { notify } from "./notify";

// Merge when ready: a session with it on gets its pull request merged once
// nothing stands in the way. Cloudly's side first (no turn running, nothing
// waiting on the user, its checks passing, the reviewer's latest look at the
// latest commit finding nothing blocking), then GitHub's (every check on the
// head commit passing, and GitHub saying it can merge). The merge names the
// head commit it checked, so a push in between makes GitHub refuse it.
// A branch that's only behind its base is brought up to date; one with
// conflicts goes to the user.

const ACTIVE = ["queued", "running", "finalizing"];
/** No checks at all on a commit this new may only mean CI hasn't started yet. */
const CI_GRACE_MS = 2 * 60_000;

export type MergeOutcome = { merged: boolean; status: string };

const prRef = (prUrl: string) => {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
};

/** Checks one session, and merges its pull request if it's ready. Returns why not, otherwise. */
export async function maybeMerge(threadId: string, gh: GitHubPort = realGitHub, now = Date.now()): Promise<MergeOutcome | null> {
  const thread = await prisma.thread.findUnique({ where: { id: threadId } });
  if (!thread || !thread.autoMerge || thread.mergedAt || !thread.prUrl || thread.archivedAt) return null;
  const ref = prRef(thread.prUrl);
  if (!ref) return null;

  const say = async (status: string, extra: Record<string, unknown> = {}) => {
    if (status !== thread.mergeStatus || Object.keys(extra).length) {
      await prisma.thread.update({ where: { id: thread.id }, data: { mergeStatus: status, ...extra } });
    }
    return { merged: Boolean(extra.mergedAt), status };
  };

  // Cloudly's side.
  if (await prisma.run.count({ where: { threadId: thread.id, status: { in: ACTIVE as never } } })) return say("Waiting for the current turn");
  if (thread.needsInput) return say("Waiting for you");
  const last = await prisma.run.findFirst({ where: { threadId: thread.id, commitSha: { not: null } }, orderBy: { createdAt: "desc" } });
  if (!last) return say("Nothing committed yet");
  if (last.checkStatus === "failed") return say("Cloudly's checks fail");
  const settings = await repoSettings(thread.repo);
  if (settings.reviewer) {
    const review = await prisma.run.findFirst({ where: { threadId: thread.id, kind: "review", createdAt: { gt: last.createdAt } }, orderBy: { createdAt: "desc" } });
    if (!review) return say("Waiting for the review");
    if (review.status !== "succeeded") return say("The review didn't finish");
    const blocking = await prisma.reviewFinding.count({ where: { runId: review.id, severity: "blocking", status: { not: "dismissed" } } });
    if (blocking) return say("The review found blocking problems");
  }

  // GitHub's side.
  const pr = await gh.prStatus(ref.owner, ref.repo, ref.number);
  if (pr.merged) return say("Merged", { mergedAt: new Date(now) });
  if (pr.state !== "open") return say("The pull request is closed");
  if (pr.draft) return say("The pull request is a draft");
  const checks = await gh.commitChecks(ref.owner, ref.repo, pr.headSha);
  if (checks.failed.length) return say(`CI fails: ${checks.failed.slice(0, 3).join(", ")}`);
  if (checks.pending.length) return say(`Waiting for CI: ${checks.pending.slice(0, 3).join(", ")}`);
  if (checks.passed === 0 && now - last.updatedAt.getTime() < CI_GRACE_MS) return say("Waiting for CI to start");
  if (pr.mergeable === null || pr.mergeableState === "unknown") return say("GitHub is still checking whether it can merge");
  if (pr.mergeableState === "dirty") {
    if (thread.mergeStatus !== `Conflicts with ${pr.baseRef}`) {
      await prisma.thread.update({
        where: { id: thread.id },
        data: { needsInput: `The pull request conflicts with ${pr.baseRef}, so it can't be merged. Reply "merge ${pr.baseRef} and resolve the conflicts" to have the agent do it.`, settledAt: null },
      });
      await notify({ userId: thread.userId, threadId: thread.id, kind: "needs_you", title: thread.title, body: `The pull request conflicts with ${pr.baseRef}. Reply "merge ${pr.baseRef} and resolve the conflicts" to have the agent do it.`, key: `conflict:${thread.id}:${pr.headSha}` });
    }
    return say(`Conflicts with ${pr.baseRef}`);
  }
  if (pr.mergeableState === "behind") {
    await gh.updateBranch(ref.owner, ref.repo, ref.number, pr.headSha);
    return say(`Updating the branch from ${pr.baseRef}`);
  }
  if (pr.mergeableState === "blocked") return say("Blocked by the branch's rules: it needs an approval or a required check");
  if (pr.mergeableState === "draft") return say("The pull request is a draft");

  const result = await gh.merge(ref.owner, ref.repo, ref.number, pr.headSha, settings.mergeMethod);
  if (!result.merged) return say(`GitHub didn't merge it: ${result.message}`.slice(0, 300));
  await notify({ userId: thread.userId, threadId: thread.id, kind: "merged", title: thread.title, body: `Cloudly merged the pull request into ${pr.baseRef} (${settings.mergeMethod}).`, key: `merged:${thread.id}` });
  return say("Merged", { mergedAt: new Date(now) });
}

/** Every session waiting to merge, once. */
export async function mergeSweep(gh: GitHubPort = realGitHub): Promise<void> {
  const waiting = await prisma.thread.findMany({
    where: { autoMerge: true, mergedAt: null, prUrl: { not: null }, archivedAt: null },
    select: { id: true },
    take: 200,
  });
  for (const t of waiting) {
    await maybeMerge(t.id, gh).catch((err) => console.error(`[merge] session ${t.id}:`, err));
  }
}

/**
 * How each session's pull request ended up, merged or closed, whoever did it
 * (for the agent scorecard). The pull_request webhook usually says first; this
 * catches the rest, a few sessions a minute, each at most every 6 hours.
 */
export async function outcomeSweep(gh: GitHubPort = realGitHub, now = Date.now(), batch = 10): Promise<number> {
  const due = await prisma.thread.findMany({
    where: {
      prUrl: { not: null }, mergedAt: null, prClosedAt: null,
      OR: [{ prCheckedAt: null }, { prCheckedAt: { lt: new Date(now - 6 * 3600_000) } }],
    },
    orderBy: [{ prCheckedAt: { sort: "asc", nulls: "first" } }],
    select: { id: true, prUrl: true },
    take: batch,
  });
  let decided = 0;
  for (const t of due) {
    const ref = prRef(t.prUrl!);
    if (!ref) {
      await prisma.thread.update({ where: { id: t.id }, data: { prCheckedAt: new Date(now) } });
      continue;
    }
    try {
      const pr = await gh.prStatus(ref.owner, ref.repo, ref.number);
      const data = pr.merged ? { mergedAt: new Date(now) } : pr.state !== "open" ? { prClosedAt: new Date(now) } : {};
      if (Object.keys(data).length) decided++;
      await prisma.thread.update({ where: { id: t.id }, data: { ...data, prCheckedAt: new Date(now) } });
    } catch (err) {
      console.error(`[merge] outcome of session ${t.id}:`, err);
      await prisma.thread.update({ where: { id: t.id }, data: { prCheckedAt: new Date(now) } });
    }
  }
  return decided;
}

export async function runMergeLoop(signal: AbortSignal, intervalMs = 60_000): Promise<void> {
  while (!signal.aborted) {
    await mergeSweep().catch((err) => console.error("[merge] sweep:", err));
    await outcomeSweep().catch((err) => console.error("[merge] outcomes:", err));
    await Bun.sleep(intervalMs);
  }
}
