import { prisma, config, budgetStatus, harnessUsesPlan } from "@repo/db";

import { github as realGitHub, type GitHubPort, type FailedCheck } from "./github";
import { repoSettings } from "./checks";
import { maybeMerge } from "./merge";
import { notify } from "./notify";
import { onSentry } from "./sentry";
import { pause } from "./pause";

// GitHub triggers. The API stores each signed webhook delivery; this turns them
// into sessions and turns:
//
//   issues.labeled          the repo's label on an issue: a new session for it
//   issue_comment.created   "@cloudly ..." on an issue or pull request: a new
//                           session, or the next turn of the one already there
//   pull_request_review     a review on a pull request Cloudly opened: the
//                           session's next turn addresses it
//   check_suite.completed   failing CI on a pull request Cloudly opened: a fix
//                           turn, a couple of times at most
//   pull_request.closed     how a pull request Cloudly opened ended: merged or
//                           not (for the agent scorecard)
//
// Only people on this Cloudly's sign-in list can start anything, and never a bot
// (Cloudly's own reviews and comments come from its bot). Everything a turn is
// started for has a unique key, so a redelivered webhook can't start it twice.

type Payload = Record<string, any>;
export interface Delivery {
  id: string;
  event: string;
  action: string | null;
  payload: Payload;
}
export type Outcome = { status: "done" | "ignored"; note: string };

const ACTIVE = ["queued", "running", "finalizing"];
const DEFAULT_HARNESS = "native-claude";
const MAX_TEXT = 8000;
const clip = (s: string | null | undefined, n = MAX_TEXT) => {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}\n[…cut]` : t;
};

function sessionLink(threadId: string): string {
  const web = process.env.WEB_ORIGIN?.replace(/\/$/, "");
  return web ? `${web}/app/s/${threadId}` : `session ${threadId}`;
}

/** "@cloudly", and "@<the app's slug>" when it has one. */
export async function mentionPattern(): Promise<RegExp> {
  const names = [process.env.CLOUDLY_MENTION ?? "@cloudly"];
  const slug = await config("GITHUB_APP_SLUG");
  if (slug) names.push(`@${slug}`);
  const alternatives = names.map((n) => n.replace(/^@?/, "@").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(^|\\s)(${alternatives})(\\[bot\\])?(?![\\w-])`, "i");
}

/** The Cloudly user a GitHub account is, if it's allowed to use this Cloudly. */
async function authorize(sender: Payload | undefined): Promise<{ id: string } | string> {
  if (!sender?.login || typeof sender.id !== "number") return "no sender";
  if (sender.type === "Bot") return `@${sender.login} is a bot`;
  const allowed = ((await config("ALLOWED_GITHUB_LOGINS")) ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(String(sender.login).toLowerCase())) return `@${sender.login} isn't on this Cloudly's sign-in list`;
  return prisma.user.upsert({
    where: { githubId: sender.id },
    update: {},
    create: { githubId: sender.id, login: sender.login, avatarUrl: sender.avatar_url ?? null },
    select: { id: true },
  });
}

const repoParts = (fullName: string) => {
  const [owner, repo] = fullName.split("/");
  return { owner: owner!, repo: repo! };
};

/** Whether a turn may start for this user on this agent now. */
export async function overBudget(userId: string, harness: string): Promise<boolean> {
  return !(await harnessUsesPlan(harness)) && (await budgetStatus(userId)).state === "storm";
}

/** Creates a run, unless one for the same GitHub event exists already. */
async function createRun(data: Parameters<typeof prisma.run.create>[0]["data"]): Promise<boolean> {
  try {
    await prisma.run.create({ data });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return false;
    throw err;
  }
}

function issuePrompt(issue: Payload, instruction: string | null): string {
  return [
    instruction || "Resolve this GitHub issue.",
    "",
    `GitHub issue #${issue.number}: ${issue.title}`,
    issue.html_url,
    "",
    clip(issue.body) || "(no description)",
  ].join("\n");
}

/** A new session for an issue (or a pull request), with its first turn. */
export async function startSession(opts: {
  userId: string;
  /** The agent; the repo's GitHub-trigger agent when left out. */
  harness?: string | null;
  repo: string;
  baseBranch: string;
  title: string;
  prompt: string;
  issueNumber?: number;
  branch?: string;
  prUrl?: string;
  trigger: Record<string, unknown>;
  triggerKey: string;
}): Promise<string | null> {
  const settings = await repoSettings(opts.repo);
  const harness = opts.harness ?? settings.triggerHarness ?? DEFAULT_HARNESS;
  const id = crypto.randomUUID();
  try {
    await prisma.thread.create({
      data: {
        id, userId: opts.userId, repo: opts.repo, baseBranch: opts.baseBranch, harness,
        title: opts.title.replace(/\s+/g, " ").slice(0, 120) || "GitHub issue",
        branch: opts.branch ?? (opts.issueNumber ? `agent/issue-${opts.issueNumber}-${id.slice(0, 6)}` : `agent/thread-${id.slice(0, 8)}`),
        issueNumber: opts.issueNumber ?? null,
        autoMerge: settings.autoMerge,
        prUrl: opts.prUrl ?? null,
        runs: {
          create: {
            repo: opts.repo, baseBranch: opts.baseBranch, harness, userId: opts.userId, status: "queued",
            prompt: opts.prompt, trigger: opts.trigger as never, triggerKey: opts.triggerKey,
          },
        },
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return null;
    throw err;
  }
  return id;
}

/** The session's next turn, from GitHub. Clears what it was waiting on. */
async function continueSession(thread: { id: string; repo: string; baseBranch: string; harness: string; userId: string }, prompt: string, trigger: Record<string, unknown>, triggerKey: string, kind = "turn") {
  const created = await createRun({
    repo: thread.repo, baseBranch: thread.baseBranch, harness: thread.harness, userId: thread.userId, threadId: thread.id,
    status: "queued", kind, prompt, trigger: trigger as never, triggerKey,
  });
  if (created) {
    await prisma.thread.update({
      where: { id: thread.id },
      data: { updatedAt: new Date(), settledAt: null, snoozedUntil: null, archivedAt: null, ...(kind === "turn" ? { needsInput: null } : {}) },
    });
  }
  return created;
}

async function onIssueLabeled(d: Delivery, gh: GitHubPort): Promise<Outcome> {
  const p = d.payload;
  const repo: string = p.repository?.full_name;
  const issue = p.issue;
  const settings = await repoSettings(repo);
  if (!settings.onIssueLabel) return { status: "ignored", note: "issue labels are off for this repo" };
  if (String(p.label?.name ?? "").toLowerCase() !== settings.issueLabel.toLowerCase()) return { status: "ignored", note: `label "${p.label?.name}" isn't "${settings.issueLabel}"` };
  const user = await authorize(p.sender);
  if (typeof user === "string") return { status: "ignored", note: user };
  const existing = await prisma.thread.findFirst({ where: { repo, issueNumber: issue.number, archivedAt: null } });
  if (existing) return { status: "ignored", note: `issue #${issue.number} already has a session` };
  const harness = settings.triggerHarness ?? DEFAULT_HARNESS;
  const { owner, repo: name } = repoParts(repo);
  if (await overBudget(user.id, harness)) {
    await gh.comment(owner, name, issue.number, "Cloudly can't start on this: the monthly spend limit is reached.").catch(() => {});
    return { status: "ignored", note: "the monthly spend limit is reached" };
  }
  const id = await startSession({
    userId: user.id, repo, baseBranch: p.repository.default_branch ?? "main", title: issue.title, prompt: issuePrompt(issue, null),
    issueNumber: issue.number,
    trigger: { type: "issue", by: p.sender.login, url: issue.html_url, number: issue.number },
    triggerKey: `issue:${repo}#${issue.number}:${d.id}`,
  });
  if (!id) return { status: "ignored", note: "already started" };
  await gh.comment(owner, name, issue.number, `Cloudly is on it: ${sessionLink(id)}. The pull request will link back here.`).catch((err) => console.error("[webhooks] comment:", err));
  return { status: "done", note: `started session ${id} for issue #${issue.number}` };
}

async function onComment(d: Delivery, gh: GitHubPort): Promise<Outcome> {
  const p = d.payload;
  const repo: string = p.repository?.full_name;
  const issue = p.issue;
  const comment = p.comment;
  const body: string = comment?.body ?? "";
  const mention = await mentionPattern();
  if (!mention.test(body)) return { status: "ignored", note: "no mention" };
  const settings = await repoSettings(repo);
  if (!settings.onMention) return { status: "ignored", note: "mentions are off for this repo" };
  const user = await authorize(p.sender);
  if (typeof user === "string") return { status: "ignored", note: user };
  const { owner, repo: name } = repoParts(repo);
  const instruction = clip(body.replace(new RegExp(mention.source, "gi"), " ").replace(/[ \t]+/g, " ").trim(), 6000) || "Take a look at this.";
  const trigger = { type: "mention", by: p.sender.login, url: comment.html_url, number: issue.number };
  const triggerKey = `comment:${repo}:${comment.id}`;
  const ack = () => gh.react(owner, name, comment.id, "eyes").catch(() => {});

  if (issue.pull_request) {
    const pr = await gh.pullRequest(owner, name, issue.number);
    const thread = await prisma.thread.findFirst({ where: { repo, branch: pr.headRef }, orderBy: { updatedAt: "desc" } });
    if (thread) {
      if (await overBudget(thread.userId, thread.harness)) return { status: "ignored", note: "the monthly spend limit is reached" };
      const ok = await continueSession(thread, `${instruction}\n\n(From @${p.sender.login} on pull request #${pr.number}: ${comment.html_url})`, trigger, triggerKey);
      if (ok) await ack();
      return ok ? { status: "done", note: `next turn in session ${thread.id}` } : { status: "ignored", note: "already queued" };
    }
    // Someone's own pull request: Cloudly can work on its branch, unless it's a fork's.
    if (pr.headRepo !== repo) {
      await gh.comment(owner, name, issue.number, "Cloudly can't push to a fork's branch. Ask on an issue instead, and it will open its own pull request.").catch(() => {});
      return { status: "ignored", note: "pull request from a fork" };
    }
    if (await overBudget(user.id, settings.triggerHarness ?? DEFAULT_HARNESS)) return { status: "ignored", note: "the monthly spend limit is reached" };
    const id = await startSession({
      userId: user.id, repo, baseBranch: pr.baseRef, branch: pr.headRef, prUrl: pr.url, title: pr.title,
      prompt: `${instruction}\n\nThis is about pull request #${pr.number}: ${pr.title}\n${pr.url}\nYou're on its branch, ${pr.headRef}; what you change is pushed to it.`,
      trigger, triggerKey,
    });
    if (!id) return { status: "ignored", note: "already started" };
    await ack();
    await gh.comment(owner, name, issue.number, `Cloudly is on it: ${sessionLink(id)}`).catch(() => {});
    return { status: "done", note: `started session ${id} on pull request #${pr.number}` };
  }

  const thread = await prisma.thread.findFirst({ where: { repo, issueNumber: issue.number, archivedAt: null }, orderBy: { updatedAt: "desc" } });
  if (thread) {
    if (await overBudget(thread.userId, thread.harness)) return { status: "ignored", note: "the monthly spend limit is reached" };
    const ok = await continueSession(thread, `${instruction}\n\n(From @${p.sender.login} on issue #${issue.number}: ${comment.html_url})`, trigger, triggerKey);
    if (ok) await ack();
    return ok ? { status: "done", note: `next turn in session ${thread.id}` } : { status: "ignored", note: "already queued" };
  }
  if (await overBudget(user.id, settings.triggerHarness ?? DEFAULT_HARNESS)) return { status: "ignored", note: "the monthly spend limit is reached" };
  const id = await startSession({
    userId: user.id, repo, baseBranch: p.repository.default_branch ?? "main", title: issue.title,
    prompt: issuePrompt(issue, instruction), issueNumber: issue.number, trigger, triggerKey,
  });
  if (!id) return { status: "ignored", note: "already started" };
  await ack();
  await gh.comment(owner, name, issue.number, `Cloudly is on it: ${sessionLink(id)}. The pull request will link back here.`).catch(() => {});
  return { status: "done", note: `started session ${id} for issue #${issue.number}` };
}

async function onReview(d: Delivery, gh: GitHubPort): Promise<Outcome> {
  const p = d.payload;
  const repo: string = p.repository?.full_name;
  const review = p.review;
  const pr = p.pull_request;
  const settings = await repoSettings(repo);
  if (!settings.onPrReview) return { status: "ignored", note: "acting on reviews is off for this repo" };
  const thread = await prisma.thread.findFirst({ where: { repo, branch: pr?.head?.ref }, orderBy: { updatedAt: "desc" } });
  if (!thread) return { status: "ignored", note: "not a Cloudly pull request" };
  const user = await authorize(p.sender);
  if (typeof user === "string") return { status: "ignored", note: user };
  const { owner, repo: name } = repoParts(repo);
  const comments = await gh.reviewComments(owner, name, pr.number, review.id);
  const said = (review.body ?? "").trim();
  if (!said && comments.length === 0) return { status: "ignored", note: review.state === "approved" ? "an approval with nothing to address" : "an empty review" };
  if (await overBudget(thread.userId, thread.harness)) return { status: "ignored", note: "the monthly spend limit is reached" };
  const prompt = [
    `Address @${p.sender.login}'s review of the pull request (#${pr.number})`,
    "",
    ...(said ? [clip(said, 6000), ""] : []),
    ...(comments.length
      ? ["Comments on lines:", "", ...comments.slice(0, 50).map((c) => `- \`${c.path}${c.line ? `:${c.line}` : ""}\`: ${clip(c.body, 2000).replace(/\n/g, "\n  ")}`), ""]
      : []),
    "If you disagree with a comment, leave that code as it is and say why in your reply.",
  ].join("\n");
  const ok = await continueSession(thread, prompt, { type: "pr_review", by: p.sender.login, url: review.html_url, number: pr.number, state: review.state }, `review:${repo}:${review.id}`);
  return ok ? { status: "done", note: `next turn in session ${thread.id}` } : { status: "ignored", note: "already queued" };
}

export function ciFixPrompt(checks: FailedCheck[], sha: string, attempt: number, of: number): string {
  const parts = [
    `Fix the failing CI (attempt ${attempt} of ${of})`,
    "",
    `CI failed on the pull request's latest commit (${sha.slice(0, 7)}). Fix the code so it passes. Don't skip, delete or weaken tests or CI steps to make it pass. If the failure has nothing to do with this session's change, or you can't fix it, say so plainly and stop.`,
  ];
  for (const c of checks) {
    parts.push("", `## ${c.name}${c.url ? ` (${c.url})` : ""}`);
    if (c.title) parts.push("", c.title);
    if (c.summary) parts.push("", clip(c.summary, 2000));
    if (c.annotations.length) parts.push("", ...c.annotations.slice(0, 20).map((a) => `- \`${a.path}${a.line ? `:${a.line}` : ""}\`: ${clip(a.message, 500)}`));
    if (c.log) parts.push("", "The end of the log:", "", "```", clip(c.log.replace(/^\S+Z /gm, ""), 6000), "```");
  }
  return parts.join("\n");
}

async function onCheckSuite(d: Delivery, gh: GitHubPort): Promise<Outcome> {
  const p = d.payload;
  const repo: string = p.repository?.full_name;
  const suite = p.check_suite;
  if (!["failure", "timed_out"].includes(suite?.conclusion)) {
    // Green CI may be the last thing a session waiting to merge needed.
    if (suite?.conclusion === "success") {
      const waiting = await prisma.thread.findFirst({ where: { repo, branch: suite.head_branch, autoMerge: true, mergedAt: null } });
      if (waiting) {
        const r = await maybeMerge(waiting.id, gh);
        if (r) return { status: "done", note: `merge when ready: ${r.status}` };
      }
    }
    return { status: "ignored", note: `conclusion ${suite?.conclusion}` };
  }
  const settings = await repoSettings(repo);
  if (!settings.fixCi) return { status: "ignored", note: "CI fixes are off for this repo" };
  const thread = await prisma.thread.findFirst({ where: { repo, branch: suite.head_branch }, orderBy: { updatedAt: "desc" } });
  if (!thread) return { status: "ignored", note: "not a Cloudly branch" };
  // Only the commit Cloudly last pushed: an older one's failure may be fixed already.
  const last = await prisma.run.findFirst({ where: { threadId: thread.id, commitSha: { not: null } }, orderBy: { createdAt: "desc" }, select: { commitSha: true } });
  if (!last || last.commitSha !== suite.head_sha) return { status: "ignored", note: "not the session's latest commit" };
  if (await prisma.run.count({ where: { threadId: thread.id, status: { in: ACTIVE as never } } })) return { status: "ignored", note: "a turn is already running; its commit gets its own CI" };
  const since = (await prisma.run.findFirst({ where: { threadId: thread.id, kind: { in: ["turn", "audit"] } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }))?.createdAt ?? new Date(0);
  const done = await prisma.run.count({ where: { threadId: thread.id, kind: "ci_fix", createdAt: { gt: since } } });
  const of = settings.ciFixAttempts;
  if (done >= of) {
    const needs = `CI still fails${of ? ` after ${of} fix attempt${of === 1 ? "" : "s"}` : ""}. Look at the checks on the pull request, then reply with what to do.`;
    await prisma.thread.update({ where: { id: thread.id }, data: { needsInput: needs, settledAt: null } });
    await notify({ userId: thread.userId, threadId: thread.id, kind: "needs_you", title: thread.title, body: needs, key: `ci-gave-up:${thread.id}:${suite.head_sha}` });
    return { status: "ignored", note: "fix attempts used up" };
  }
  if (await overBudget(thread.userId, thread.harness)) {
    await prisma.thread.update({ where: { id: thread.id }, data: { needsInput: "CI fails, and the monthly spend limit is reached, so no fix was attempted.", settledAt: null } });
    return { status: "ignored", note: "the monthly spend limit is reached" };
  }
  const { owner, repo: name } = repoParts(repo);
  const checks = await gh.failedChecks(owner, name, suite.id);
  if (checks.length === 0) return { status: "ignored", note: "no failed check runs found" };
  const ok = await continueSession(
    thread,
    ciFixPrompt(checks, suite.head_sha, done + 1, of),
    { type: "ci", url: checks[0]!.url, sha: suite.head_sha, checks: checks.map((c) => c.name) },
    `ci:${repo}@${suite.head_sha}`,
    "ci_fix",
  );
  return ok ? { status: "done", note: `fix attempt ${done + 1} in session ${thread.id}` } : { status: "ignored", note: "a fix for this commit is already queued" };
}

/** A pull request Cloudly opened was merged or closed, by anyone: the session records which. */
async function onPullRequestClosed(d: Delivery): Promise<Outcome> {
  const pr = d.payload.pull_request;
  const url = typeof pr?.html_url === "string" ? pr.html_url : null;
  if (!url) return { status: "ignored", note: "no pull request" };
  const at = new Date(typeof pr.closed_at === "string" ? pr.closed_at : Date.now());
  const r = await prisma.thread.updateMany({
    where: { prUrl: url, mergedAt: null, prClosedAt: null },
    data: pr.merged ? { mergedAt: new Date(typeof pr.merged_at === "string" ? pr.merged_at : at), prCheckedAt: new Date() } : { prClosedAt: at, prCheckedAt: new Date() },
  });
  return r.count ? { status: "done", note: pr.merged ? "merged" : "closed without merging" } : { status: "ignored", note: "not a session's pull request, or already recorded" };
}

export async function handleDelivery(d: Delivery, gh: GitHubPort = realGitHub): Promise<Outcome> {
  if (d.event.startsWith("sentry.")) return onSentry(d);
  if (!d.payload?.repository?.full_name) return { status: "ignored", note: "no repository" };
  if (d.event === "issues" && d.action === "labeled") return onIssueLabeled(d, gh);
  if (d.event === "issue_comment" && d.action === "created") return onComment(d, gh);
  if (d.event === "pull_request_review" && d.action === "submitted") return onReview(d, gh);
  if (d.event === "check_suite" && d.action === "completed") return onCheckSuite(d, gh);
  if (d.event === "pull_request" && d.action === "closed") return onPullRequestClosed(d);
  return { status: "ignored", note: `${d.event}.${d.action ?? ""} isn't handled` };
}

const MAX_ATTEMPTS = 3;

/** Claims the next delivery to handle; one stuck in processing for 10 minutes counts as pending. */
async function claimDelivery(): Promise<(Delivery & { attempts: number }) | null> {
  const rows = await prisma.$queryRaw<(Delivery & { attempts: number })[]>`
    UPDATE "WebhookDelivery" SET status = 'processing', attempts = attempts + 1, "updatedAt" = now()
    WHERE id = (
      SELECT id FROM "WebhookDelivery"
      WHERE status = 'pending' OR (status = 'processing' AND "updatedAt" < now() - interval '10 minutes')
      ORDER BY "receivedAt" LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id, event, action, payload, attempts`;
  return rows[0] ?? null;
}

/** Handles every delivery waiting. Returns how many it handled. */
export async function processDeliveries(gh: GitHubPort = realGitHub): Promise<number> {
  let n = 0;
  for (let d = await claimDelivery(); d; d = await claimDelivery()) {
    n++;
    try {
      const outcome = await handleDelivery(d, gh);
      await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: outcome.status, note: outcome.note.slice(0, 500) } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[webhooks] ${d.event} ${d.id}:`, err);
      await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: d.attempts >= MAX_ATTEMPTS ? "failed" : "pending", note: message.slice(0, 500) } });
    }
  }
  return n;
}

export async function runWebhookLoop(signal: AbortSignal, intervalMs = 2000): Promise<void> {
  while (!signal.aborted) {
    try {
      await processDeliveries();
    } catch (err) {
      console.error("[webhooks] loop:", err);
    }
    await pause(intervalMs, signal);
  }
}
