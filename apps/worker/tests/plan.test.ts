import { test, expect } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Keep the Codex home and master key away from the real ~/.cloudly.
process.env.CLOUDLY_DATA_DIR = await mkdtemp(path.join(tmpdir(), "plan-test-"));
process.env.CLOUDLY_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { credentialFlags, saveCodexAuth } = await import("../src/docker");
const { prisma, deleteSetting, getSetting } = await import("@repo/db");
const { claimRun } = await import("../src/claim");
const { processRun } = await import("../src/process-run");
const { createFixtureRepo } = await import("./test-helpers");

test("a Claude plan token is used instead of the API key", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-api";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-plan";
  try {
    const { flags, env } = await credentialFlags("native-claude");
    expect(flags).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(flags).not.toContain("ANTHROPIC_API_KEY");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-plan");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
});

test("a ChatGPT sign-in is mounted as CODEX_HOME, private, and a refreshed copy is kept", async () => {
  await deleteSetting("CODEX_AUTH_JSON");
  process.env.CODEX_AUTH_JSON = '{"tokens":{"access_token":"old"}}';
  try {
    const { flags, env, codexHome } = await credentialFlags("native-codex");
    expect(flags).toContain("CODEX_HOME=/codex-home");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    const file = path.join(codexHome!, "auth.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    await writeFile(file, '{"tokens":{"access_token":"refreshed"}}');
    await saveCodexAuth(codexHome!);
    expect(await getSetting("CODEX_AUTH_JSON")).toContain("refreshed");
  } finally {
    delete process.env.CODEX_AUTH_JSON;
    await deleteSetting("CODEX_AUTH_JSON");
  }
});

test("a run on the plan goes ahead at the spend limit and records no cost", async () => {
  const fixture = await createFixtureRepo();
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `plan-${Date.now()}` } });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-plan";
  try {
    await prisma.budget.create({ data: { userId: user.id, monthlyLimitUsd: 1 } });
    const base = { repo: fixture.repoPath, baseBranch: "main", prompt: "t", harness: "native-claude", userId: user.id };
    await prisma.run.create({ data: { ...base, status: "succeeded", costUsd: 5 } });
    const queued = await prisma.run.create({ data: { ...base, status: "queued" } });

    let cap: number | undefined = -1;
    async function* stub(_w: unknown, _t: string, _h: string, _id: string, o?: { maxBudgetUsd?: number }) {
      cap = o?.maxBudgetUsd;
      yield { seq: 0, ts: Date.now(), kind: "done" as const, data: { totalCostUsd: 0.4 } };
    }
    await processRun((await claimRun("worker-1"))!, "worker-1", stub as any);

    const final = await prisma.run.findUniqueOrThrow({ where: { id: queued.id } });
    expect(final.status).toBe("succeeded");
    expect(final.onPlan).toBe(true);
    expect(final.costUsd?.toNumber()).toBe(0);
    expect(cap).toBeUndefined();
  } finally {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    await prisma.run.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
  }
}, 30000);
