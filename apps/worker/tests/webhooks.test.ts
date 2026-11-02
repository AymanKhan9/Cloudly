import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import { processDeliveries, handleDelivery, ciFixPrompt, mentionPattern } from "../src/webhooks";
import type { GitHubPort, FailedCheck } from "../src/github";

const stamp = Date.now();
const repo = `acme/hooks-${stamp}`;
const ALLOWED = { login: `owner-${stamp}`, id: 900_000_000 + (stamp % 1_000_000), type: "User" };
const STRANGER = { login: "stranger", id: 12345, type: "User" };
const BOT = { login: "cloudly-abc[bot]", id: 777, type: "Bot" };
const saved = process.env.ALLOWED_GITHUB_LOGINS;

beforeAll(() => {
  process.env.ALLOWED_GITHUB_LOGINS = `someone-else, ${ALLOWED.login.toUpperCase()}`;
});
afterAll(async () => {
  process.env.ALLOWED_GITHUB_LOGINS = saved;
  await prisma.thread.deleteMany({ where: { repo } });
  await prisma.user.deleteMany({ where: { githubId: ALLOWED.id } });
  await prisma.repoSettings.deleteMany({ where: { repo } });
  await prisma.webhookDelivery.deleteMany({ where: { id: { startsWith: `t-${stamp}` } } });
});

/** A stand-in for GitHub that records what Cloudly asked of it. */
function fakeGitHub(over: Partial<GitHubPort> = {}) {
  const calls: string[] = [];
  const gh: GitHubPort = {
    comment: async (_o, _r, n, body) => void calls.push(`comment #${n}: ${body}`),
    react: async (_o, _r, id, c) => void calls.push(`react ${id} ${c}`),
    pullRequest: async (_o, _r, n) => ({ number: n, url: `https://github.com/${repo}/pull/${n}`, title: "Their PR", headRef: "feature/x", headRepo: repo, baseRef: "main", state: "open" }),
    reviewComments: async () => [{ path: "src/a.ts", line: 3, body: "Use a constant here." }],
    failedChecks: async () => [],
    ...over,
  };
  return { gh, calls };
}

const base = { repository: { full_name: repo, default_branch: "main" } };
const issue = (n: number) => ({ number: n, title: `Crash on empty input ${n}`, body: "Steps: call parse('')", html_url: `https://github.com/${repo}/issues/${n}` });
let seq = 0;
const deliver = (event: string, action: string, payload: object) =>
  prisma.webhookDelivery.create({ data: { id: `t-${stamp}-${++seq}`, event, action, payload: { action, ...base, ...payload } as never } });

test("a labelled issue starts a session from an allowed person; strangers, bots and other labels don't", async () => {
  const { gh, calls } = fakeGitHub();
  await deliver("issues", "labeled", { label: { name: "Cloudly" }, issue: issue(1), sender: ALLOWED });
  await deliver("issues", "labeled", { label: { name: "cloudly" }, issue: issue(2), sender: STRANGER });
  await deliver("issues", "labeled", { label: { name: "bug" }, issue: issue(3), sender: ALLOWED });
  await deliver("issues", "labeled", { label: { name: "cloudly" }, issue: issue(4), sender: BOT });
  // Labelled again: the issue already has a session.
  await deliver("issues", "labeled", { label: { name: "cloudly" }, issue: issue(1), sender: ALLOWED });
  expect(await processDeliveries(gh)).toBe(5);

  const threads = await prisma.thread.findMany({ where: { repo }, include: { runs: true } });
  expect(threads).toHaveLength(1);
  const t = threads[0]!;
  expect(t.issueNumber).toBe(1);
  expect(t.harness).toBe("native-claude");
  expect(t.branch).toStartWith("agent/issue-1-");
  expect(t.runs[0]!.prompt).toContain("GitHub issue #1: Crash on empty input 1");
  expect(t.runs[0]!.prompt).toContain("Steps: call parse('')");
  expect(t.runs[0]!.trigger).toMatchObject({ type: "issue", by: ALLOWED.login, number: 1 });
  expect(calls).toEqual([expect.stringMatching(/^comment #1: Cloudly is on it/)]);
  const notes = (await prisma.webhookDelivery.findMany({ where: { id: { startsWith: `t-${stamp}` } }, orderBy: { receivedAt: "asc" } })).map((d) => [d.status, d.note]);
  expect(notes).toEqual([
    ["done", expect.stringContaining("started session")],
    ["ignored", "@stranger isn't on this Cloudly's sign-in list"],
    ["ignored", 'label "bug" isn\'t "cloudly"'],
    ["ignored", "@cloudly-abc[bot] is a bot"],
    ["ignored", "issue #1 already has a session"],
  ]);
});

test("@cloudly continues the issue's session, starts one on a new issue, and works on someone's pull request", async () => {
  const { gh, calls } = fakeGitHub();
  const comment = (id: number, body: string) => ({ id, body, html_url: `https://github.com/${repo}/issues/1#issuecomment-${id}` });
  const thread = (await prisma.thread.findFirst({ where: { repo, issueNumber: 1 } }))!;

  // A comment without the mention, and the same comment delivered twice.
  await deliver("issue_comment", "created", { issue: issue(1), comment: comment(10, "Thanks, looks fine"), sender: ALLOWED });
  await deliver("issue_comment", "created", { issue: issue(1), comment: comment(11, "@cloudly also handle whitespace-only input"), sender: ALLOWED });
  await deliver("issue_comment", "created", { issue: issue(1), comment: comment(11, "@cloudly also handle whitespace-only input"), sender: ALLOWED });
  await deliver("issue_comment", "created", { issue: issue(5), comment: comment(12, "@Cloudly please look into this one"), sender: ALLOWED });
  await deliver("issue_comment", "created", { issue: { ...issue(6), pull_request: {} }, comment: comment(13, "hey @cloudly fix the lint errors here"), sender: ALLOWED });
  await deliver("issue_comment", "created", { issue: issue(1), comment: comment(14, "@cloudly delete everything"), sender: STRANGER });
  await processDeliveries(gh);

  const turns = await prisma.run.findMany({ where: { threadId: thread.id }, orderBy: { createdAt: "asc" } });
  expect(turns).toHaveLength(2);
  expect(turns[1]!.prompt).toStartWith("also handle whitespace-only input");
  expect(turns[1]!.trigger).toMatchObject({ type: "mention", by: ALLOWED.login });

  const onFive = await prisma.thread.findFirstOrThrow({ where: { repo, issueNumber: 5 }, include: { runs: true } });
  expect(onFive.runs[0]!.prompt).toStartWith("please look into this one");
  expect(onFive.runs[0]!.prompt).toContain("GitHub issue #5");

  // Their pull request: the session works on its branch and its PR.
  const onPr = await prisma.thread.findFirstOrThrow({ where: { repo, branch: "feature/x" }, include: { runs: true } });
  expect(onPr.prUrl).toBe(`https://github.com/${repo}/pull/6`);
  expect(onPr.baseBranch).toBe("main");
  expect(onPr.runs[0]!.prompt).toStartWith("hey fix the lint errors here");

  expect(calls.filter((c) => c.startsWith("react"))).toEqual(["react 11 eyes", "react 12 eyes", "react 13 eyes"]);
  expect(calls.filter((c) => c.startsWith("comment"))).toHaveLength(2);
});

test("a fork's pull request is refused, since Cloudly can't push there", async () => {
  const { gh, calls } = fakeGitHub({
    pullRequest: async (_o, _r, n) => ({ number: n, url: "u", title: "t", headRef: "patch-1", headRepo: "someone/fork", baseRef: "main", state: "open" }),
  });
  const r = await handleDelivery({ id: "x", event: "issue_comment", action: "created", payload: { ...base, issue: { ...issue(7), pull_request: {} }, comment: { id: 70, body: "@cloudly fix" }, sender: ALLOWED } }, gh);
  expect(r).toEqual({ status: "ignored", note: "pull request from a fork" });
  expect(calls[0]).toContain("can't push to a fork");
});

test("a review on Cloudly's pull request becomes the next turn; its own bot's reviews don't", async () => {
  const { gh } = fakeGitHub();
  const t = await prisma.thread.findFirstOrThrow({ where: { repo, issueNumber: 1 } });
  await prisma.thread.update({ where: { id: t.id }, data: { needsInput: "waiting" } });
  const pr = { number: 9, head: { ref: t.branch } };
  const review = (id: number, body: string, state = "changes_requested") => ({ id, body, state, html_url: `https://github.com/${repo}/pull/9#pullrequestreview-${id}` });
  await deliver("pull_request_review", "submitted", { pull_request: pr, review: review(100, "Close, but see the comment."), sender: ALLOWED });
  await deliver("pull_request_review", "submitted", { pull_request: pr, review: review(101, "Cloudly review: 1 blocking", "commented"), sender: BOT });
  await deliver("pull_request_review", "submitted", { pull_request: { number: 3, head: { ref: "someone/else" } }, review: review(102, "lgtm"), sender: ALLOWED });
  await processDeliveries(gh);

  const last = await prisma.run.findFirstOrThrow({ where: { threadId: t.id }, orderBy: { createdAt: "desc" } });
  expect(last.prompt).toStartWith(`Address @${ALLOWED.login}'s review of the pull request (#9)`);
  expect(last.prompt).toContain("Close, but see the comment.");
  expect(last.prompt).toContain("- `src/a.ts:3`: Use a constant here.");
  expect(last.trigger).toMatchObject({ type: "pr_review", state: "changes_requested" });
  expect((await prisma.thread.findUniqueOrThrow({ where: { id: t.id } })).needsInput).toBeNull();
  const notes = (await prisma.webhookDelivery.findMany({ where: { event: "pull_request_review", id: { startsWith: `t-${stamp}` } }, orderBy: { receivedAt: "asc" } })).map((d) => d.note);
  expect(notes.slice(1)).toEqual([`@${BOT.login} is a bot`, "not a Cloudly pull request"]);
});

test("failing CI on the latest commit gets fix turns, a couple at most; old commits and passing CI don't", async () => {
  const checks: FailedCheck[] = [{ name: "test", url: "https://ci/1", title: "1 failing", summary: "parse.test.ts failed", annotations: [{ path: "src/parse.ts", line: 4, message: "Expected 0, got NaN" }], log: "2026-11-02T10:00:00.000Z FAIL parse.test.ts\n" }];
  const { gh } = fakeGitHub({ failedChecks: async () => checks });
  const t = await prisma.thread.findFirstOrThrow({ where: { repo, issueNumber: 5 } });
  await prisma.run.updateMany({ where: { threadId: t.id }, data: { status: "succeeded" } });
  const commit = async (sha: string) => {
    await prisma.run.create({ data: { repo, baseBranch: "main", harness: t.harness, userId: t.userId, threadId: t.id, status: "succeeded", prompt: "x", kind: "ci_fix", commitSha: sha } });
  };
  // The session's first commit (from its user turn).
  await prisma.run.updateMany({ where: { threadId: t.id }, data: { commitSha: "a".repeat(40) } });
  const suite = (sha: string, conclusion = "failure") => ({ check_suite: { id: 5, conclusion, head_branch: t.branch, head_sha: sha } });

  await deliver("check_suite", "completed", suite("b".repeat(40)));
  await deliver("check_suite", "completed", suite("a".repeat(40), "success"));
  await deliver("check_suite", "completed", suite("a".repeat(40)));
  await deliver("check_suite", "completed", suite("a".repeat(40))); // a second suite on the same commit
  await processDeliveries(gh);
  const fixes = await prisma.run.findMany({ where: { threadId: t.id, kind: "ci_fix", status: "queued" } });
  expect(fixes).toHaveLength(1);
  expect(fixes[0]!.prompt).toStartWith("Fix the failing CI (attempt 1 of 2)");
  expect(fixes[0]!.prompt).toContain("`src/parse.ts:4`: Expected 0, got NaN");
  expect(fixes[0]!.prompt).toContain("FAIL parse.test.ts");
  expect(fixes[0]!.prompt).not.toContain("2026-11-02T10:00:00.000Z");

  // Attempt 2 on the fix's commit, then no third: the session asks the user.
  await prisma.run.update({ where: { id: fixes[0]!.id }, data: { status: "succeeded", commitSha: "c".repeat(40) } });
  await deliver("check_suite", "completed", suite("c".repeat(40)));
  await processDeliveries(gh);
  const second = await prisma.run.findFirstOrThrow({ where: { threadId: t.id, kind: "ci_fix", status: "queued" } });
  expect(second.prompt).toStartWith("Fix the failing CI (attempt 2 of 2)");
  await prisma.run.update({ where: { id: second.id }, data: { status: "succeeded", commitSha: "d".repeat(40) } });
  await deliver("check_suite", "completed", suite("d".repeat(40)));
  await processDeliveries(gh);
  expect(await prisma.run.count({ where: { threadId: t.id, kind: "ci_fix", status: "queued" } })).toBe(0);
  expect((await prisma.thread.findUniqueOrThrow({ where: { id: t.id } })).needsInput).toContain("CI still fails after 2 fix attempts");
  void commit;
});

test("settings turn triggers off, and a failing handler is retried, then given up", async () => {
  await prisma.repoSettings.upsert({ where: { repo }, update: { onIssueLabel: false, onMention: false }, create: { repo, onIssueLabel: false, onMention: false } });
  const { gh } = fakeGitHub();
  expect(await handleDelivery({ id: "x", event: "issues", action: "labeled", payload: { ...base, label: { name: "cloudly" }, issue: issue(20), sender: ALLOWED } }, gh)).toEqual({ status: "ignored", note: "issue labels are off for this repo" });
  expect((await handleDelivery({ id: "x", event: "issue_comment", action: "created", payload: { ...base, issue: issue(20), comment: { id: 1, body: "@cloudly go" }, sender: ALLOWED } }, gh)).note).toBe("mentions are off for this repo");
  await prisma.repoSettings.update({ where: { repo }, data: { onIssueLabel: true, onMention: true } });

  const broken = fakeGitHub({ pullRequest: async () => { throw new Error("GitHub is down"); } });
  const d = await deliver("issue_comment", "created", { issue: { ...issue(21), pull_request: {} }, comment: { id: 2100, body: "@cloudly hi" }, sender: ALLOWED });
  for (let i = 0; i < 3; i++) await processDeliveries(broken.gh);
  const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } });
  expect(row).toMatchObject({ status: "failed", attempts: 3, note: "GitHub is down" });
});

test("the mention matches @cloudly and the app's name, not words that merely start with it", async () => {
  const m = await mentionPattern();
  expect(m.test("@cloudly do it")).toBe(true);
  expect(m.test("ping\n@Cloudly")).toBe(true);
  expect(m.test("email me@cloudly.dev")).toBe(false);
  expect(m.test("@cloudly-bot nope")).toBe(false);
  expect(ciFixPrompt([], "f".repeat(40), 1, 2)).toContain("(fffffff)");
});
