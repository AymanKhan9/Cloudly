import { test, expect, afterAll } from "bun:test";
import { prisma } from "@repo/db";
import { maybeMerge, mergeSweep } from "../src/merge";
import { fakeGitHub } from "./fake-github";

const stamp = Date.now();
const repo = `acme/merge-${stamp}`;
const users: string[] = [];
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.repoSettings.deleteMany({ where: { repo } });
});

const SHA = "a".repeat(40);
async function session(extra: { reviewer?: string } = {}) {
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `merge-${Date.now()}-${users.length}` } });
  users.push(user.id);
  if (extra.reviewer) await prisma.repoSettings.upsert({ where: { repo }, update: { reviewer: extra.reviewer }, create: { repo, reviewer: extra.reviewer } });
  const n = users.length;
  const thread = await prisma.thread.create({
    data: { userId: user.id, repo, baseBranch: "main", harness: "native-claude", title: "t", branch: `agent/m-${stamp}-${n}`, autoMerge: true, prUrl: `https://github.com/${repo}/pull/${n}` },
  });
  const turn = await prisma.run.create({
    data: { userId: user.id, threadId: thread.id, repo, baseBranch: "main", harness: "native-claude", prompt: "x", status: "succeeded", commitSha: SHA, checkStatus: "passed", updatedAt: new Date(Date.now() - 10 * 60_000) },
  });
  return { thread, turn, user };
}
const status = async (id: string) => prisma.thread.findUniqueOrThrow({ where: { id }, select: { mergeStatus: true, mergedAt: true, needsInput: true } });

test("a ready pull request is merged with the repo's method, at the head commit that was checked", async () => {
  const { thread } = await session();
  const { gh, calls } = fakeGitHub(repo);
  const r = await maybeMerge(thread.id, gh);
  expect(r).toEqual({ merged: true, status: "Merged" });
  expect(calls).toEqual([`merge #${users.length} aaaaaaa squash`]);
  expect((await status(thread.id)).mergedAt).toBeInstanceOf(Date);
  // Merged sessions are left alone after that.
  expect(await maybeMerge(thread.id, gh)).toBeNull();
});

test("Cloudly's side waits: a running turn, a question, failing checks, a review with blocking findings", async () => {
  const { thread, turn, user } = await session({ reviewer: "native-codex" });
  const { gh, calls } = fakeGitHub(repo);
  // No review after the latest commit yet.
  expect((await maybeMerge(thread.id, gh))!.status).toBe("Waiting for the review");
  const review = await prisma.run.create({ data: { userId: user.id, threadId: thread.id, repo, baseBranch: "main", harness: "native-codex", prompt: "Review the changes", kind: "review", status: "succeeded" } });
  const finding = await prisma.reviewFinding.create({ data: { runId: review.id, threadId: thread.id, severity: "blocking", title: "Bug", body: "" } });
  expect((await maybeMerge(thread.id, gh))!.status).toBe("The review found blocking problems");
  // Dismissed by the user: no longer in the way.
  await prisma.reviewFinding.update({ where: { id: finding.id }, data: { status: "dismissed" } });

  await prisma.thread.update({ where: { id: thread.id }, data: { needsInput: "Which one?" } });
  expect((await maybeMerge(thread.id, gh))!.status).toBe("Waiting for you");
  await prisma.thread.update({ where: { id: thread.id }, data: { needsInput: null } });

  const busy = await prisma.run.create({ data: { userId: user.id, threadId: thread.id, repo, baseBranch: "main", harness: "native-claude", prompt: "more", status: "queued" } });
  expect((await maybeMerge(thread.id, gh))!.status).toBe("Waiting for the current turn");
  await prisma.run.delete({ where: { id: busy.id } });

  await prisma.run.update({ where: { id: turn.id }, data: { checkStatus: "failed" } });
  expect((await maybeMerge(thread.id, gh))!.status).toBe("Cloudly's checks fail");
  await prisma.run.update({ where: { id: turn.id }, data: { checkStatus: "passed" } });
  expect(calls).toEqual([]);

  expect((await maybeMerge(thread.id, gh))!.merged).toBe(true);
  await prisma.repoSettings.update({ where: { repo }, data: { reviewer: null } });
});

test("GitHub's side waits for CI and for GitHub, updates a branch that's behind, and hands conflicts to the user", async () => {
  const { thread, turn } = await session();
  const base = fakeGitHub(repo);
  const pr = await base.gh.prStatus("", "", 0);
  const at = (over: Partial<typeof pr>, checks = { pending: [] as string[], failed: [] as string[], passed: 2 }) => fakeGitHub(repo, { prStatus: async () => ({ ...pr, ...over }), commitChecks: async () => checks });

  expect((await maybeMerge(thread.id, at({}, { pending: ["test"], failed: [], passed: 1 }).gh))!.status).toBe("Waiting for CI: test");
  expect((await maybeMerge(thread.id, at({}, { pending: [], failed: ["lint", "e2e"], passed: 1 }).gh))!.status).toBe("CI fails: lint, e2e");
  expect((await maybeMerge(thread.id, at({ mergeable: null, mergeableState: "unknown" }).gh))!.status).toBe("GitHub is still checking whether it can merge");
  expect((await maybeMerge(thread.id, at({ mergeableState: "blocked" }).gh))!.status).toContain("Blocked by the branch's rules");
  expect((await maybeMerge(thread.id, at({ draft: true }).gh))!.status).toBe("The pull request is a draft");

  const behind = at({ mergeableState: "behind" });
  expect((await maybeMerge(thread.id, behind.gh))!.status).toBe("Updating the branch from main");
  expect(behind.calls).toEqual([`update-branch #${users.length}`]);

  // A brand-new commit with no checks yet may just be CI not having started.
  await prisma.run.update({ where: { id: turn.id }, data: { updatedAt: new Date() } });
  expect((await maybeMerge(thread.id, at({}, { pending: [], failed: [], passed: 0 }).gh))!.status).toBe("Waiting for CI to start");

  const dirty = at({ mergeableState: "dirty" });
  expect((await maybeMerge(thread.id, dirty.gh))!.status).toBe("Conflicts with main");
  expect((await status(thread.id)).needsInput).toContain("conflicts with main");
  expect(dirty.calls).toEqual([]);

  // GitHub refusing the merge (the head moved) is reported, not retried blindly.
  await prisma.thread.update({ where: { id: thread.id }, data: { needsInput: null } });
  await prisma.run.update({ where: { id: turn.id }, data: { updatedAt: new Date(Date.now() - 10 * 60_000) } });
  const moved = fakeGitHub(repo, { merge: async () => ({ merged: false, message: "Head branch was modified" }) });
  expect((await maybeMerge(thread.id, moved.gh))!.status).toBe("GitHub didn't merge it: Head branch was modified");
  expect((await status(thread.id)).mergedAt).toBeNull();
});

test("a pull request merged by hand is recorded, and the sweep only looks at sessions with it on", async () => {
  const { thread } = await session();
  const off = await session();
  await prisma.thread.update({ where: { id: off.thread.id }, data: { autoMerge: false } });
  const { gh, calls } = fakeGitHub(repo, { prStatus: async () => ({ state: "closed", merged: true, draft: false, mergeable: null, mergeableState: "unknown", headSha: SHA, baseRef: "main" }) });
  await mergeSweep(gh);
  expect(await status(thread.id)).toMatchObject({ mergeStatus: "Merged" });
  expect((await status(off.thread.id)).mergeStatus).toBeNull();
  expect(calls).toEqual([]);
});
