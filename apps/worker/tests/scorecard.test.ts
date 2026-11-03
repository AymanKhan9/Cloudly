import { test, expect } from "bun:test";
import { prisma, agentScorecard, pickAgent } from "@repo/db";
import { outcomeSweep } from "../src/merge";
import { handleDelivery } from "../src/webhooks";
import { fakeGitHub } from "./fake-github";

const DAY = 24 * 3600_000;

test("the scorecard: merges by anyone, costs, first-try checks, fixes, findings; and Auto's pick", async () => {
  const repo = `acme/score-${Date.now()}`;
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `score-${Date.now()}` } });
  const now = Date.now();
  let n = 0;
  const session = async (harness: string, o: { merged?: boolean; closed?: boolean; ageDays?: number; cost?: number; checks?: ("passed" | "failed")[]; fixes?: number; blocking?: number; pr?: boolean }) => {
    const created = new Date(now - (o.ageDays ?? 2) * DAY);
    const t = await prisma.thread.create({
      data: {
        userId: user.id, repo, baseBranch: "main", harness, title: `s${n}`, branch: `b${n}`, createdAt: created,
        prUrl: o.pr === false ? null : `https://github.com/${repo}/pull/${++n}`,
        mergedAt: o.merged ? new Date(created.getTime() + 5 * 3600_000) : null,
        prClosedAt: o.closed ? new Date(created.getTime() + 3600_000) : null,
      },
    });
    const base = { userId: user.id, threadId: t.id, repo, baseBranch: "main", harness, prompt: "x", status: "succeeded" as const };
    for (const [i, c] of (o.checks ?? ["passed"]).entries()) await prisma.run.create({ data: { ...base, kind: "turn", checkStatus: c, costUsd: i === 0 ? o.cost ?? 1 : 0 } });
    for (let i = 0; i < (o.fixes ?? 0); i++) await prisma.run.create({ data: { ...base, kind: "fix", costUsd: 0.5 } });
    // A review by another agent: its cost isn't the author's.
    const review = await prisma.run.create({ data: { ...base, harness: "native-codex", kind: "review", costUsd: 9 } });
    for (let i = 0; i < (o.blocking ?? 0); i++) {
      await prisma.reviewFinding.create({ data: { runId: review.id, threadId: t.id, severity: "blocking", title: "bug", body: "b", file: "a.ts", line: 1 } });
    }
    return t;
  };
  try {
    // Claude: 4 merged of 5 decided (one open but stale); Codex: 2 of 2; Pi: just one session.
    for (let i = 0; i < 4; i++) await session("native-claude", { merged: true, cost: 2 });
    await session("native-claude", { closed: true, checks: ["failed", "passed"], fixes: 2, blocking: 2 });
    await session("native-claude", { ageDays: 20 });
    await session("native-claude", { ageDays: 1 });
    await session("native-claude", { pr: false });
    await session("native-codex", { merged: true, cost: 1 });
    await session("native-codex", { merged: true, cost: 3 });
    await session("acp-pi", { merged: true });
    // Another repo's sessions don't count.
    await prisma.thread.create({ data: { userId: user.id, repo: `${repo}-other`, baseBranch: "main", harness: "native-codex", title: "o", branch: "o", prClosedAt: new Date() } });

    const scores = await agentScorecard({ repo, now });
    const claude = scores.find((s) => s.harness === "native-claude")!;
    expect(claude).toMatchObject({ sessions: 8, prs: 7, merged: 4, notMerged: 2, open: 1, rewinds: 0 });
    expect(claude.mergeRate).toBeCloseTo(4 / 6);
    expect(claude.costPerMerged).toBe(2);
    expect(claude.checksFirstTry).toBeCloseTo(8 / 9);
    expect(claude.fixTurnsPerPr).toBeCloseTo(2 / 7);
    expect(claude.blockingPerReview).toBeCloseTo(2 / 8);
    expect(claude.hoursToMerge).toBeCloseTo(5);
    const codex = scores.find((s) => s.harness === "native-codex")!;
    expect(codex).toMatchObject({ merged: 2, notMerged: 0, costPerMerged: 2 });

    // Codex has 2 of 2: not enough history to beat Claude's 4 of 6. Pi: 1 of 1.
    expect(pickAgent(scores, ["native-claude", "native-codex", "acp-pi"])).toEqual({ harness: "native-claude", reason: "4 of 6 pull requests merged", score: 5 / 8 });
    // Only agents that can run here count.
    expect(pickAgent(scores, ["native-codex", "acp-pi"])).toBeNull();
  } finally {
    await prisma.thread.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("how pull requests ended up: the webhook, and the sweep for the rest", async () => {
  const repo = `acme/outcome-${Date.now()}`;
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `outcome-${Date.now()}` } });
  const mk = (n: number) => prisma.thread.create({ data: { userId: user.id, repo, baseBranch: "main", harness: "native-claude", title: `t${n}`, branch: `b${n}`, prUrl: `https://github.com/${repo}/pull/${n}` } });
  try {
    const [a, b, c] = [await mk(1), await mk(2), await mk(3)];
    const out = await handleDelivery({
      id: "d1", event: "pull_request", action: "closed",
      payload: { repository: { full_name: repo }, pull_request: { html_url: a.prUrl, merged: true, merged_at: "2026-11-01T10:00:00Z", closed_at: "2026-11-01T10:00:00Z" } },
    });
    expect(out).toEqual({ status: "done", note: "merged" });
    expect((await prisma.thread.findUniqueOrThrow({ where: { id: a.id } })).mergedAt?.toISOString()).toBe("2026-11-01T10:00:00.000Z");

    // The sweep asks GitHub about the others: #2 was closed, #3 is still open.
    const { gh } = fakeGitHub(repo, {
      prStatus: async (_o, _r, num) => ({ state: num === 2 ? "closed" : "open", merged: false, draft: false, mergeable: true, mergeableState: "clean", headSha: "a".repeat(40), baseRef: "main" }),
    });
    const now = Date.now();
    expect(await outcomeSweep(gh, now, 50)).toBe(1);
    const [b2, c2] = await Promise.all([prisma.thread.findUniqueOrThrow({ where: { id: b.id } }), prisma.thread.findUniqueOrThrow({ where: { id: c.id } })]);
    expect(b2.prClosedAt).not.toBeNull();
    expect(c2.prClosedAt).toBeNull();
    expect(c2.prCheckedAt?.getTime()).toBe(now);
    // Checked a moment ago: not asked again until hours later.
    let asked = 0;
    const counting = fakeGitHub(repo, { prStatus: async () => (asked++, { state: "open", merged: false, draft: false, mergeable: true, mergeableState: "clean", headSha: "a".repeat(40), baseRef: "main" }) });
    await prisma.thread.updateMany({ where: { userId: { not: user.id }, prUrl: { not: null }, mergedAt: null, prClosedAt: null }, data: { prCheckedAt: new Date(now) } });
    await outcomeSweep(counting.gh, now + 60_000, 50);
    expect(asked).toBe(0);
    await outcomeSweep(counting.gh, now + 7 * 3600_000, 50);
    expect(asked).toBeGreaterThanOrEqual(1);
  } finally {
    await prisma.thread.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});
