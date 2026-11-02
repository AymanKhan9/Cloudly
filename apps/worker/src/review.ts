import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma, budgetStatus, harnessUsesPlan } from "@repo/db";
import type { Run } from "@repo/shared/run";
import type { RunEvent } from "@repo/shared/run-event";
import { parseDiff, lineInDiff, parseFindings, type DiffFile, type Finding } from "@repo/shared/diff";

import { createRunContainer, cancelRun, type ContainerOptions } from "./docker";
import { createWorkspace, destroyWorkspace, type Workspace } from "./workspace";
import { resolveCloneSource, isRepoSlug, parseRepoSlug, postPullRequestReview } from "./github";
import { insertEvents } from "./events";
import { heartbeat } from "./heartbeat";
import { costFromDoneEvent } from "./cost";
import { enforceBudget } from "./budget";
import { readRegular } from "./repo-files";
import { sandboxImage } from "./sandbox-image";
import { repoSettings } from "./checks";
import { memberName } from "./council";

// The reviewer: after a turn changes code (and its checks pass), a second agent
// reviews the session's change, from the base branch to the session's branch,
// and writes its findings to a file. Blocking findings go back to the author as
// a turn of their own, a couple of rounds at most; the rest wait for the user.
// An audit is the same turn over the whole repo, started by the user.
// Like a council turn, nothing a review turn changes is committed.

/** Where the review's files are inside the sandbox. */
export const REVIEW_DIR = "/workspace/.cloudly-review";
const FINDINGS_MAX = 512 * 1024;
const DIFF_MAX = 1024 * 1024;
const BACKSTOP_USD = 20;
const OVERSHOOT_RATIO = 0.25;
const ACTIVE = ["queued", "running", "finalizing"];

type RunContainer = (ws: Workspace, task: string, harness: string, runId: string, options?: ContainerOptions) => AsyncIterable<RunEvent>;

/** A diff capped at a whole file, so what's kept still parses. */
export function capDiff(diff: string, max = DIFF_MAX): string {
  if (diff.length <= max) return diff;
  const cut = diff.lastIndexOf("\ndiff --git ", max);
  return diff.slice(0, cut > 0 ? cut + 1 : max);
}

/**
 * What a branch changes against the base branch, from a git dir the host owns
 * (the turn's mirror or the publish clone, never the agent's clone). The base is
 * the merge base, so commits that landed on the base branch since don't show up.
 */
export async function branchDiff(gitDir: string, baseRef: string, headRef: string): Promise<{ base: string; diff: string } | null> {
  const git = (args: string[]) => Bun.$`git --git-dir=${gitDir} ${args}`.nothrow().quiet();
  const head = await git(["rev-parse", "--verify", "--quiet", `${headRef}^{commit}`]);
  if (head.exitCode !== 0) return null;
  let base = await git(["merge-base", baseRef, headRef]);
  if (base.exitCode !== 0) base = await git(["merge-base", "HEAD", headRef]);
  if (base.exitCode !== 0) return null;
  const baseSha = base.text().trim();
  const diff = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", baseSha, headRef]);
  if (diff.exitCode !== 0) return null;
  return { base: baseSha, diff: capDiff(diff.text()) };
}

/** The base branch's ref in a git dir: a bare mirror has it as a branch, a clone as origin's. */
export async function baseRef(gitDir: string, baseBranch: string, bare: boolean): Promise<string> {
  const ref = bare ? `refs/heads/${baseBranch}` : `refs/remotes/origin/${baseBranch}`;
  const ok = (await Bun.$`git --git-dir=${gitDir} rev-parse --verify --quiet ${ref}`.nothrow().quiet()).exitCode === 0;
  return ok ? ref : bare ? "HEAD" : "refs/remotes/origin/HEAD";
}

export function reviewPrompt(mode: "review" | "audit", round: number): string {
  const format = [
    `Write your findings to ${REVIEW_DIR}/findings.json, even when there are none:`,
    "",
    "```json",
    '{ "summary": "One or two sentences overall.", "findings": [',
    '  { "file": "src/app.ts", "line": 42, "severity": "blocking", "title": "Short title", "body": "What is wrong, why it matters, and how to fix it." }',
    "] }",
    "```",
    "",
    'severity is "blocking" for a real defect that has to be fixed before this is merged: a bug, wrong behaviour, a security hole, lost data, a broken build or test, or not doing what was asked. "suggestion" is worth changing but isn\'t wrong. "nit" is style and naming. Never mark style as blocking, and don\'t pad the list: no findings is a fine answer.',
    "file is relative to /workspace and line is a line number in the file as it is now. Leave them out for something that isn't about one place.",
  ];
  if (mode === "audit") {
    return [
      "Audit this repository",
      "",
      `You're auditing the whole repository at /workspace for the user. What they want you to focus on, if anything, is in ${REVIEW_DIR}/task.md.`,
      "",
      "Look for bugs, security problems, missing error handling, dead or duplicated code, and missing tests, most important first. Read the code, and run the tests if that helps. Don't change any files: nothing you change is kept. At most 30 findings.",
      "",
      ...format,
    ].join("\n");
  }
  return [
    `Review the changes in this session (round ${round})`,
    "",
    "You're reviewing another agent's work for the user. /workspace is the repo on the session's branch, with the change in it.",
    `The change, from the base branch, is in ${REVIEW_DIR}/changes.diff. What the user asked for is in ${REVIEW_DIR}/task.md.`,
    "",
    "Review the change, not the rest of the repo: bugs, wrong behaviour, security problems, missing error handling, broken or missing tests, and anything that doesn't do what the user asked. Read the code around it to be sure, and run the tests if that helps. Don't change any files: nothing you change is kept.",
    "",
    ...format,
  ].join("\n");
}

/** What the author is told to fix. The first line is the turn's title. */
export function reviewFixPrompt(reviewer: string, findings: Pick<Finding, "file" | "line" | "title" | "body">[], attempt: number, of: number): string {
  const items = findings.map((f, i) => {
    const where = f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ""}\`)` : "";
    const body = f.body ? `\n   ${f.body.replace(/\n/g, "\n   ")}` : "";
    return `${i + 1}. **${f.title}**${where}${body}`;
  });
  return [
    `Fix the reviewer's findings (round ${attempt} of ${of})`,
    "",
    `${reviewer} reviewed your change and found ${findings.length === 1 ? "a problem" : "problems"} to fix before it's merged:`,
    "",
    ...items,
    "",
    "Fix these. If you think a finding is wrong, leave that code as it is and say why in your reply.",
  ].join("\n");
}

const COUNTS = (f: { severity: string }[]) => ({
  blocking: f.filter((x) => x.severity === "blocking").length,
  suggestions: f.filter((x) => x.severity === "suggestion").length,
  nits: f.filter((x) => x.severity === "nit").length,
});

/** The review as text: what later turns see of it, and the PR review's body. */
export function reviewSummary(summary: string | null, findings: Finding[], mode: "review" | "audit"): string {
  const c = COUNTS(findings);
  const head = findings.length === 0
    ? mode === "audit" ? "The audit found nothing to fix." : "The review found nothing to fix."
    : `${c.blocking} blocking, ${c.suggestions} suggestion${c.suggestions === 1 ? "" : "s"}, ${c.nits} nit${c.nits === 1 ? "" : "s"}.`;
  const lines = findings.map((f) => `- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`);
  return [summary, head, ...lines].filter(Boolean).join("\n");
}

/**
 * The review GitHub gets: a line comment for each finding on a line inside the
 * diff (GitHub refuses the rest), and everything else in the body.
 */
export function githubReview(reviewer: string, summary: string | null, findings: Finding[], files: DiffFile[]) {
  const label = { blocking: "🔴 Blocking", suggestion: "🟡 Suggestion", nit: "⚪ Nit" } as const;
  const comments: { path: string; line: number; side: "RIGHT"; body: string }[] = [];
  const rest: string[] = [];
  for (const f of findings) {
    const text = `**${label[f.severity]}: ${f.title}**${f.body ? `\n\n${f.body}` : ""}`;
    if (f.file && f.line && lineInDiff(files, f.file, f.line)) comments.push({ path: f.file, line: f.line, side: "RIGHT", body: text });
    else rest.push(`- ${text.replace(/\n\n/, " — ").replace(/\n/g, " ")}${f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ""}\`)` : ""}`);
  }
  const c = COUNTS(findings);
  const body = [
    `**Cloudly review** by ${reviewer}: ${findings.length === 0 ? "nothing to fix." : `${c.blocking} blocking, ${c.suggestions} suggestions, ${c.nits} nits.`}`,
    summary ?? "",
    rest.length ? `\n${rest.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return { body, comments };
}

/** Reads the findings the reviewer wrote; falls back to a JSON block in its last reply. */
async function readFindings(dir: string, reply: string | undefined) {
  const bytes = await readRegular(path.join(dir, "findings.json"), FINDINGS_MAX);
  const candidates = [bytes ? new TextDecoder().decode(bytes) : null, reply?.match(/```(?:json)?\s*\n([\s\S]*?)```/)?.[1] ?? null];
  for (const text of candidates) {
    if (!text) continue;
    try {
      return { ...parseFindings(JSON.parse(text)), written: true };
    } catch {}
  }
  return { summary: null, findings: [] as Finding[], written: false };
}

/** The user's requests in this session, for the reviewer to judge the change against. */
async function sessionTask(threadId: string): Promise<string> {
  const asks = await prisma.run.findMany({
    where: { threadId, kind: { in: ["turn", "audit"] } },
    orderBy: { createdAt: "asc" },
    select: { prompt: true },
    take: 20,
  });
  return asks.map((a, i) => `## Request ${i + 1}\n\n${a.prompt.slice(0, 6000)}`).join("\n\n") || "(no request recorded)";
}

/** A review or audit turn. */
export async function processReviewTurn(run: Run, workerId: string, runContainer: RunContainer = createRunContainer, heartbeatIntervalMs = 20_000): Promise<void> {
  const mode = run.kind === "audit" ? "audit" : "review";
  let cancelled = false;
  let leaseLost = false;
  const timer = setInterval(() => {
    heartbeat(run.id, workerId).then((ok) => {
      if (!ok) leaseLost = true;
    });
    prisma.run.findUnique({ where: { id: run.id }, select: { cancelRequested: true } }).then((r) => {
      if (r?.cancelRequested && !cancelled) {
        cancelled = true;
        cancelRun(run.id).catch(() => {});
      }
    });
  }, heartbeatIntervalMs);

  const fenced = { id: run.id, workerId, leaseGen: run.leaseGen };
  let ws: Workspace | undefined;
  let reviewDir: string | undefined;
  let agentError: string | undefined;
  let seq = 0;
  try {
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: run.threadId! } });
    ws = await createWorkspace(await resolveCloneSource(run.repo), { branch: thread.branch, baseBranch: run.baseBranch });

    reviewDir = await mkdtemp(path.join(tmpdir(), "review-"));
    let files: DiffFile[] = [];
    let headSha: string | null = null;
    if (mode === "review") {
      // The branch as it is on GitHub, when it's there; else what the session's
      // last commit recorded (a repo without a remote never gets the branch).
      const onRemote = (await Bun.$`git --git-dir=${ws.mirrorDir} rev-parse --verify --quiet refs/heads/${thread.branch}`.nothrow().quiet()).exitCode === 0;
      const fromBranch = onRemote ? await branchDiff(ws.mirrorDir, await baseRef(ws.mirrorDir, run.baseBranch, true), `refs/heads/${thread.branch}`) : null;
      const result = fromBranch ?? (thread.diff ? { base: thread.diffBase ?? "", diff: thread.diff } : null);
      if (!result || !result.diff.trim()) {
        const output = "Nothing to review: the session hasn't changed anything yet.";
        await prisma.run.updateMany({ where: fenced, data: { status: "succeeded", output } });
        await insertEvents(run.id, [{ seq: 0, ts: Date.now(), kind: "text", data: output }, { seq: 1, ts: Date.now(), kind: "done", data: { result: output } }]);
        return;
      }
      if (fromBranch) headSha = (await Bun.$`git --git-dir=${ws.mirrorDir} rev-parse refs/heads/${thread.branch}`.quiet().text()).trim();
      files = parseDiff(result.diff);
      await writeFile(path.join(reviewDir, "changes.diff"), result.diff);
    }
    await writeFile(path.join(reviewDir, "task.md"), mode === "audit" ? run.prompt : await sessionTask(thread.id));

    // Spend: the monthly limit, as for any turn.
    const onPlan = await harnessUsesPlan(run.harness);
    if (onPlan) await prisma.run.updateMany({ where: fenced, data: { onPlan: true } });
    const options: ContainerOptions = { image: await sandboxImage(), mounts: [[reviewDir, REVIEW_DIR]] };
    if (!onPlan) {
      const budget = run.userId ? await budgetStatus(run.userId) : null;
      if (budget?.limitUsd != null) {
        const left = budget.limitUsd - budget.spentUsd;
        if (left <= 0) throw new Error("Monthly spend limit reached");
        options.maxBudgetUsd = Math.min(BACKSTOP_USD, left + budget.limitUsd * OVERSHOOT_RATIO);
      } else {
        options.maxBudgetUsd = BACKSTOP_USD;
      }
    }
    // The session's model is the author's; a reviewer of another kind uses its own default.
    if (thread.model && run.harness === thread.harness) options.model = thread.model;

    const round = mode === "review" ? (await prisma.run.count({ where: { threadId: thread.id, kind: "review_fix", createdAt: { gt: (await lastUserTurn(thread.id))?.createdAt ?? new Date(0) } } })) + 1 : 1;
    const task = reviewPrompt(mode, round);

    let lastText: string | undefined;
    let doneResult: string | undefined;
    try {
      for await (const event of runContainer(ws, task, run.harness, run.id, options)) {
        await insertEvents(run.id, [event]);
        seq = Math.max(seq, event.seq + 1);
        if (event.kind === "text" && typeof event.data === "string" && event.data.trim()) lastText = event.data;
        if (event.kind === "done") {
          const r = (event.data as { result?: unknown } | null)?.result;
          if (typeof r === "string") doneResult = r;
        }
        if (event.kind === "error") {
          const d = event.data as { message?: unknown } | string | null;
          agentError = typeof d === "string" ? d : typeof d?.message === "string" ? d.message : agentError;
        }
        const cost = onPlan ? null : costFromDoneEvent(run.harness, event);
        if (cost) {
          await prisma.run.updateMany({ where: fenced, data: { costUsd: cost.usd } });
          if (run.userId) await enforceBudget(run.userId);
        }
      }
    } catch (err) {
      if (!cancelled) throw err;
    }
    if (leaseLost) return;

    const read = await readFindings(reviewDir, doneResult ?? lastText);
    if (!read.written && !cancelled) {
      await prisma.run.updateMany({
        where: fenced,
        data: { status: "failed", output: doneResult?.trim() || lastText?.trim() || null, error: agentError ?? "The reviewer didn't write its findings." },
      });
      return;
    }
    const output = reviewSummary(read.summary, read.findings, mode);
    const saved = await prisma.$transaction(async (tx) => {
      const moved = await tx.run.updateMany({ where: fenced, data: { status: cancelled ? "cancelled" : "succeeded", output } });
      if (moved.count === 0) return false;
      await tx.reviewFinding.createMany({
        data: read.findings.map((f) => ({ runId: run.id, threadId: thread.id, file: f.file, line: f.line, severity: f.severity, title: f.title, body: f.body })),
      });
      return true;
    });
    if (!saved) return;
    const counts = COUNTS(read.findings);
    await insertEvents(run.id, [{ seq: seq++, ts: Date.now(), kind: "status", data: { type: mode, ...counts } }]);
    if (cancelled) return;

    // The pull request gets the review too, with comments on the lines.
    const settings = await repoSettings(run.repo);
    const prNumber = thread.prUrl?.match(/\/pull\/(\d+)/)?.[1];
    if (mode === "review" && settings.reviewPostToGitHub && isRepoSlug(run.repo) && prNumber && headSha) {
      try {
        const { owner, repo } = parseRepoSlug(run.repo);
        const review = githubReview(memberName(run.harness), read.summary, read.findings, files);
        const posted = await postPullRequestReview({ owner, repo, pullNumber: Number(prNumber), commitId: headSha, ...review });
        await insertEvents(run.id, [{ seq: seq++, ts: Date.now(), kind: "status", data: { type: "review.posted", url: posted.url, lineComments: posted.lineComments } }]);
      } catch (err) {
        console.error(`run ${run.id}: couldn't post the review to GitHub:`, err);
      }
    }

    // Blocking findings go back to the author.
    if (mode === "review" && counts.blocking > 0) {
      const outcome = await queueReviewFix(run, thread.id, settings.reviewRounds).catch((err) => (console.error(`run ${run.id}: couldn't queue the fix:`, err), null));
      if (outcome?.queued) {
        await insertEvents(run.id, [{ seq: seq++, ts: Date.now(), kind: "status", data: { type: "review.fix", attempt: outcome.attempt, of: outcome.of } }]);
      } else if (outcome && outcome.reason !== "a newer message is waiting") {
        const why = outcome.reason === "attempts used up"
          ? `after ${outcome.of} round${outcome.of === 1 ? "" : "s"} of fixes`
          : outcome.reason === "off" ? "" : "and the monthly spend limit is reached";
        await prisma.thread.update({
          where: { id: thread.id },
          data: { needsInput: `The reviewer still finds ${counts.blocking} blocking problem${counts.blocking === 1 ? "" : "s"}${why ? ` ${why}` : ""}. Look at the Changes tab, then reply with what to do.`, settledAt: null },
        });
        await insertEvents(run.id, [{ seq: seq++, ts: Date.now(), kind: "status", data: { type: "review.gave_up", reason: outcome.reason } }]);
      }
    }
  } catch (err) {
    await prisma.run.updateMany({ where: fenced, data: { status: "failed", error: agentError ?? (err instanceof Error ? err.message : String(err)) } });
  } finally {
    clearInterval(timer);
    if (ws) await destroyWorkspace(ws);
    if (reviewDir) await rm(reviewDir, { recursive: true, force: true });
  }
}

/** The last turn the user (or another session) asked for: rounds count from there. */
async function lastUserTurn(threadId: string) {
  return prisma.run.findFirst({ where: { threadId, kind: { in: ["turn", "audit"] } }, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true } });
}

type QueueOutcome = { queued: boolean; attempt: number; of: number; reason?: "off" | "a newer message is waiting" | "attempts used up" | "the monthly spend limit is reached" };

/** After a review with blocking findings: the author's turn to fix them, unless the rounds are used up. */
export async function queueReviewFix(run: { id: string; repo: string; baseBranch: string; userId?: string | null; harness: string }, threadId: string, rounds: number): Promise<QueueOutcome> {
  const of = rounds;
  if (of <= 0) return { queued: false, attempt: 0, of, reason: "off" };
  const thread = await prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
  const waiting = await prisma.run.count({ where: { threadId, id: { not: run.id }, status: { in: ACTIVE as never } } });
  if (waiting) return { queued: false, attempt: 0, of, reason: "a newer message is waiting" };
  const since = (await lastUserTurn(threadId))?.createdAt ?? new Date(0);
  const done = await prisma.run.count({ where: { threadId, kind: "review_fix", createdAt: { gt: since } } });
  if (done >= of) return { queued: false, attempt: done, of, reason: "attempts used up" };
  if (run.userId && !(await harnessUsesPlan(thread.harness)) && (await budgetStatus(run.userId)).state === "storm") {
    return { queued: false, attempt: done, of, reason: "the monthly spend limit is reached" };
  }
  const blocking = await prisma.reviewFinding.findMany({ where: { runId: run.id, severity: "blocking" }, orderBy: { createdAt: "asc" } });
  const attempt = done + 1;
  await prisma.$transaction([
    prisma.run.create({
      data: {
        repo: run.repo, baseBranch: run.baseBranch, harness: thread.harness, userId: run.userId, threadId,
        status: "queued", kind: "review_fix", prompt: reviewFixPrompt(memberName(run.harness), blocking, attempt, of),
      },
    }),
    prisma.reviewFinding.updateMany({ where: { id: { in: blocking.map((b) => b.id) } }, data: { status: "sent" } }),
    prisma.thread.update({ where: { id: threadId }, data: { updatedAt: new Date() } }),
  ]);
  return { queued: true, attempt, of };
}

/**
 * After a turn committed a change whose checks didn't fail: queue the review,
 * when the repo has a reviewer. Returns whether one was queued.
 */
export async function queueReview(run: { id: string; threadId?: string | null; repo: string; baseBranch: string; userId?: string | null }): Promise<boolean> {
  if (!run.threadId) return false;
  const settings = await repoSettings(run.repo);
  if (!settings.reviewer) return false;
  const waiting = await prisma.run.count({ where: { threadId: run.threadId, id: { not: run.id }, status: { in: ACTIVE as never } } });
  if (waiting) return false;
  if (run.userId && !(await harnessUsesPlan(settings.reviewer)) && (await budgetStatus(run.userId)).state === "storm") return false;
  await prisma.run.create({
    data: {
      repo: run.repo, baseBranch: run.baseBranch, harness: settings.reviewer, userId: run.userId, threadId: run.threadId,
      status: "queued", kind: "review", prompt: "Review the changes",
    },
  });
  return true;
}
