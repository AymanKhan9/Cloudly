import { test, expect } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Keep the Codex home and master key away from the real ~/.cloudly.
process.env.CLOUDLY_DATA_DIR = await mkdtemp(path.join(tmpdir(), "plan-test-"));
process.env.CLOUDLY_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { credentialFlags } = await import("../src/docker");
const { prisma, deleteSetting } = await import("@repo/db");
const { claimRun } = await import("../src/claim");
const { processRun } = await import("../src/process-run");
const { createFixtureRepo } = await import("./test-helpers");

test("a Claude plan token is used instead of the API key", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-api";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-plan";
  try {
    const { flags, env } = await credentialFlags("native-claude");
    expect(flags).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-cloudly-placeholder");
    expect(flags.some((f) => f.startsWith("ANTHROPIC_API_KEY"))).toBe(false);
    expect(flags.join(" ") + JSON.stringify(env)).not.toContain("sk-ant-oat-plan");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
});

test("a ChatGPT sign-in reaches the sandbox only as a placeholder, with Codex pointed at the gateway", async () => {
  await deleteSetting("CODEX_AUTH_JSON");
  const realAccess = "eyJhbGciOiAiUlMyNTYifQ.eyJleHAiOiA0MTAyNDQ0ODAwLCAiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS9hdXRoIjogeyJjaGF0Z3B0X2FjY291bnRfaWQiOiAiYWNjdF8xIn19.REALSIGNATURE";
  process.env.CODEX_AUTH_JSON = JSON.stringify({ auth_mode: "chatgpt", last_refresh: "2026-10-14T00:00:00Z", tokens: { id_token: realAccess, access_token: realAccess, refresh_token: "rt_REAL_SECRET", account_id: "acct_1" } });
  try {
    const { flags, env, codexHome } = await credentialFlags("native-codex");
    expect(flags).toContain("CODEX_HOME=/codex-home");
    expect(flags).toContain("CODEX_REFRESH_TOKEN_URL_OVERRIDE=https://cloudly-egress:3130/codex-refresh");
    expect(env.OPENAI_API_KEY).toBeUndefined();

    const file = path.join(codexHome!, "auth.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const inSandbox = await Bun.file(file).text();
    expect(inSandbox).not.toContain("rt_REAL_SECRET");
    expect(inSandbox).not.toContain("REALSIGNATURE");
    const placeholder = JSON.parse(inSandbox);
    expect(placeholder.tokens.account_id).toBe("acct_1"); // claims Codex needs survive
    expect(placeholder.tokens.access_token.endsWith(".cloudly-placeholder")).toBe(true);
    expect(flags).toContain("CODEX_CA_CERTIFICATE=/cloudly-ca/bundle.pem");
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
