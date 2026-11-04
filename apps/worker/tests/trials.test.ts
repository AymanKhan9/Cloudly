import { test, expect, afterAll } from "bun:test";
import { prisma, checkProviderUpdates, type UpdateSources } from "@repo/db";
import { trialInstall, type RegistryAgent } from "@repo/shared/providers";
import { advanceTrials, judgeTrial, overlap, type TrialSide } from "../src/trials";

const stamp = Date.now();
const ids: string[] = [];
const users: string[] = [];
afterAll(async () => {
  await prisma.agentTrial.deleteMany({ where: { providerId: { in: ids } } });
  await prisma.run.deleteMany({ where: { harness: { in: ids } } });
  await prisma.thread.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.provider.deleteMany({ where: { id: { in: ids } } });
});

const piRegistry = (v: string): RegistryAgent => ({ id: "pi-acp", name: "pi ACP", version: v, distribution: { npx: { package: `pi-acp@${v}` } } });
const src = (v: string): UpdateSources => ({ registry: async () => [piRegistry(v)], npmLatest: async () => "1.5.0" });
async function addPi(suffix: string) {
  const id = `acp-trial-${stamp}-${suffix}`;
  ids.push(id);
  return prisma.provider.create({
    data: {
      id, name: "Pi", source: "catalog", sourceId: "acp-pi", version: "0.0.34", testUpdates: true,
      spec: { launch: { install: { kind: "npm", packages: ["pi-acp@0.0.34", "@earendil-works/pi-coding-agent"] }, args: [], env: {}, homeFiles: {} }, credentials: [], hosts: [] },
    },
  });
}
const side = (o: Partial<TrialSide>): TrialSide => ({ status: "succeeded", checks: "passed", costUsd: 0.5, files: ["a.ts"], ...o });

test("the verdict: not worse at finishing, checks, closeness to what merged, or cost", () => {
  expect(overlap(["a.ts", "b.ts"], ["a.ts"])).toBe(0.5);
  expect(overlap([], [])).toBe(1);
  const same = judgeTrial([{ merged: ["a.ts"], current: side({}), candidate: side({ costUsd: 0.6 }) }]);
  expect(same.passed).toBe(true);
  expect(same.reason).toContain("As good on 1 past task");
  const worse = judgeTrial([
    { merged: ["a.ts"], current: side({}), candidate: side({ checks: "failed" }) },
    { merged: ["b.ts"], current: side({ files: ["b.ts"] }), candidate: side({ status: "failed", files: [] }) },
  ]);
  expect(worse.passed).toBe(false);
  expect(worse.reason).toContain("it finished 1 of 2 tasks to the current version's 2");
  expect(worse.reason).toContain("the checks passed on 1 of 2 tasks, to the current version's 2");
  expect(judgeTrial([{ merged: ["a.ts"], current: side({ costUsd: 1 }), candidate: side({ costUsd: 2 }) }]).reason).toContain("it cost $2.00 to $1.00");
  // Neither side finished anything: no evidence, so no switch.
  const failedBoth = side({ status: "failed", files: [], checks: null, costUsd: null });
  const nothing = judgeTrial([{ merged: ["a.ts"], current: failedBoth, candidate: failedBoth }, { merged: ["b.ts"], current: failedBoth, candidate: failedBoth }]);
  expect(nothing.passed).toBe(false);
  expect(nothing.reason).toBe("Neither version finished any of the 2 past tasks, so the trial shows nothing either way.");
});

test("a trial installs under /tmp, away from the image's copy", () => {
  const t = trialInstall("acp-pi", { install: { kind: "npm", packages: ["pi-acp@0.0.35"] }, args: ["--acp"], env: {}, homeFiles: {} } as never);
  expect(t.run).toBe("/tmp/cloudly-trial/acp-pi/run");
  expect(t.block).toContain("npm install --prefix '/tmp/cloudly-trial/acp-pi'");
  expect(t.block).not.toContain("/opt/cloudly/agents");
  // A failed install fails the trial run (the image's own block carries on instead).
  expect(t.block.startsWith("set -eux\n")).toBe(true);
  expect(t.block).not.toContain("the rest of the image is unaffected");
  const r = Bun.spawnSync(["bash", "-c", trialInstall("acp-x", { install: { kind: "binary", builds: { x86_64: { url: "http://127.0.0.1:1/none.tar.gz", cmd: "./x" }, aarch64: { url: "http://127.0.0.1:1/none.tar.gz", cmd: "./x" } } }, args: [] } as never).block.replaceAll("/tmp/cloudly-trial", `/tmp/cloudly-trial-test-${stamp}`)]);
  expect(r.exitCode).not.toBe(0);
});

test("while an update is tried, its download host is reachable from the sandbox", async () => {
  const { providerHosts } = await import("@repo/db");
  const p = await addPi("hosts");
  const trial = await prisma.agentTrial.create({
    data: { providerId: p.id, fromVersion: "1", toVersion: "2", status: "running", launch: { install: { kind: "binary", builds: { x86_64: { url: "https://downloads.example-agent.dev/a-2.tar.gz", cmd: "./a" } } }, args: [] } },
  });
  expect(await providerHosts()).toContain("downloads.example-agent.dev");
  await prisma.agentTrial.update({ where: { id: trial.id }, data: { status: "installed" } });
  expect(await providerHosts()).not.toContain("downloads.example-agent.dev");
  await prisma.agentTrial.delete({ where: { id: trial.id } });
  await prisma.provider.delete({ where: { id: p.id } });
});

test("an update with testing on is tried on merged tasks, then installed if it holds up or kept back if not", async () => {
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `trial-${stamp}` } });
  users.push(user.id);
  const pass = await addPi("pass");
  const fail = await addPi("fail");
  const none = await addPi("none");
  for (const p of [pass, fail]) {
    const t = await prisma.thread.create({
      data: { userId: user.id, repo: "acme/t", baseBranch: "main", harness: p.id, title: `Merged task ${p.id}`, branch: "b", mergedAt: new Date(), diffBase: "c".repeat(40), diff: "diff --git a/src/a.ts b/src/a.ts\n" },
    });
    await prisma.run.create({ data: { userId: user.id, threadId: t.id, repo: "acme/t", baseBranch: "main", harness: p.id, prompt: "Add the cart", status: "succeeded" } });
  }

  // The check opens trials instead of installing.
  const results = (await checkProviderUpdates(src("0.0.35"))).filter((r) => ids.includes(r.id));
  expect(results.map((r) => r.outcome)).toEqual(["testing", "testing", "testing"]);
  expect((await prisma.provider.findUniqueOrThrow({ where: { id: pass.id } })).updateState).toBe("testing");
  expect((await checkProviderUpdates(src("0.0.36"))).filter((r) => ids.includes(r.id))).toEqual([]);

  await advanceTrials();
  // No merged tasks to try it on: installed as usual.
  expect(await prisma.provider.findUniqueOrThrow({ where: { id: none.id } })).toMatchObject({ updateState: "updating", version: "0.0.35 · pi-coding-agent 1.5.0" });
  // Two runs per task, from the commit the task started on.
  const runs = await prisma.run.findMany({ where: { harness: { in: [pass.id, fail.id] }, kind: "trial" } });
  expect(runs).toHaveLength(4);
  expect(runs.every((r) => r.status === "queued" && r.prompt === "Add the cart" && (r.trigger as any).base === "c".repeat(40))).toBe(true);

  // What each side did.
  const done = async (providerId: string, sideName: string, data: object) => {
    const r = runs.find((x) => x.harness === providerId && (x.trigger as any).side === sideName)!;
    await prisma.run.update({ where: { id: r.id }, data: { status: "succeeded", output: JSON.stringify({ files: ["src/a.ts"] }), checkStatus: "passed", costUsd: 0.4, ...data } });
  };
  await done(pass.id, "current", {});
  await done(pass.id, "candidate", { costUsd: 0.45 });
  await done(fail.id, "current", {});
  await advanceTrials();
  // One side still running: not judged yet.
  expect((await prisma.agentTrial.findFirstOrThrow({ where: { providerId: fail.id } })).status).toBe("running");
  await done(fail.id, "candidate", { checkStatus: "failed" });
  await advanceTrials();

  const passed = await prisma.provider.findUniqueOrThrow({ where: { id: pass.id } });
  expect(passed).toMatchObject({ updateState: "updating", version: "0.0.35 · pi-coding-agent 1.5.0" });
  expect(passed.updateNote).toStartWith("Updated to 0.0.35 · pi-coding-agent 1.5.0 after trying it: As good on 1 past task");
  expect((await prisma.agentTrial.findFirstOrThrow({ where: { providerId: pass.id } })).status).toBe("installed");

  const kept = await prisma.provider.findUniqueOrThrow({ where: { id: fail.id } });
  expect(kept).toMatchObject({ updateState: "failed", version: "0.0.34", skipVersion: "0.0.35 · pi-coding-agent 1.5.0", availableVersion: "0.0.35 · pi-coding-agent 1.5.0" });
  expect(kept.updateNote).toContain("the checks passed on 0 of 1 tasks, to the current version's 1");
  const trial = await prisma.agentTrial.findFirstOrThrow({ where: { providerId: fail.id } });
  expect(trial.status).toBe("failed");
  expect((trial.results as any).judged[0].title).toBe(`Merged task ${fail.id}`);
});
