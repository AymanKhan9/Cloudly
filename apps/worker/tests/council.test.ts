import { test, expect } from "bun:test";
import { readdir, readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@repo/db";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { advanceCouncil, roundPrompt } from "../src/council";
import { OPEN_TOKENS_FILE } from "../src/egress";
import { type ContainerOptions } from "../src/docker";

type Seen = { harness: string; round: number; role: string; task: string; system?: string; files: string[]; env?: Record<string, string>; research?: boolean; liveTokens: string[] };

/** Runs every queued turn with a stand-in agent until the queue is empty. */
async function drain(agent: (s: Seen, dir: string) => Promise<void>, seen: Seen[]) {
  for (let i = 0; i < 30; i++) {
    const run = await claimRun("worker-c");
    if (!run) {
      // The sweep, as the worker runs it, in case a turn finished without advancing.
      for (const c of await prisma.council.findMany({ where: { status: "running" } })) await advanceCouncil(c.id);
      if (!(await prisma.run.count({ where: { status: "queued", councilId: { not: null } } }))) return;
      continue;
    }
    async function* stub(_ws: unknown, task: string, harness: string, _id: string, options: ContainerOptions = {}) {
      const dir = options.mounts![0]![0];
      const files: string[] = [];
      for (const d of await readdir(dir)) if (d.startsWith("round-")) for (const f of await readdir(path.join(dir, d))) files.push(`${d}/${f}`);
      const liveTokens = JSON.parse(await readFile(OPEN_TOKENS_FILE, "utf8")) as string[];
      const s: Seen = { harness, round: run!.councilRound!, role: run!.councilRole!, task, system: options.systemAppend, files: files.sort(), env: options.env, research: options.research, liveTokens };
      seen.push(s);
      await agent(s, dir);
      yield { seq: 0, ts: Date.now(), kind: "text" as const, data: "chat text that isn't the answer" };
      yield { seq: 1, ts: Date.now(), kind: "done" as const, data: { result: "done" } };
    }
    await processRun(run, "worker-c", stub as never);
  }
}

async function user() {
  return prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `council-${Date.now()}` } });
}

async function council(userId: string, members: string[], extra: object = {}) {
  const c = await prisma.council.create({
    data: { userId, question: "What's the state of the software job market right now?", members, chair: "native-claude", rounds: 3, ...extra },
  });
  await prisma.run.createMany({
    data: members.map((harness) => ({ repo: "", baseBranch: "", prompt: "Research", harness, status: "queued" as const, userId, councilId: c.id, councilRound: 1, councilRole: "member" })),
  });
  return c;
}

test("a research council runs its rounds, passes answers between them, and ends with the chair's report", async () => {
  const u = await user();
  const seen: Seen[] = [];
  try {
    const c = await council(u.id, ["native-claude", "gemini-acp"]);
    await drain(async (s, dir) => {
      await writeFile(path.join(dir, "answer.md"), s.role === "chair" ? "# Report\n\nThe council agrees hiring is slower." : `${s.harness} round ${s.round}: hiring is slower.`);
    }, seen);

    const done = await prisma.council.findUniqueOrThrow({ where: { id: c.id }, include: { runs: true } });
    expect(done.status).toBe("done");
    expect(done.report).toBe("# Report\n\nThe council agrees hiring is slower.");
    expect(done.runs).toHaveLength(7); // 2 members x 3 rounds + the chair

    // Round 1: on its own. Round 2: everyone's round 1. Round 3: everyone's round 2. Chair: all rounds.
    const g = (h: string, r: number) => seen.find((s) => s.harness === h && s.round === r && s.role === "member")!;
    expect(g("gemini-acp", 1).files).toEqual([]);
    expect(g("gemini-acp", 2).files).toEqual(["round-1/claude.md", "round-1/gemini.md"]);
    expect(g("native-claude", 3).files).toEqual(["round-2/claude.md", "round-2/gemini.md"]);
    const chair = seen.find((s) => s.role === "chair")!;
    expect(chair.files).toHaveLength(6);
    expect(chair.task).toContain("## Where it disagrees");
    expect(g("gemini-acp", 2).task).toContain("cross-review");
    // The answer is the file, not the chat.
    expect(done.runs.find((r) => r.harness === "gemini-acp" && r.councilRound === 1)!.output).toBe("gemini-acp round 1: hiring is slower.");

    // Research: the open web, through the proxy with a credential of its own; Claude gets the rules as its system prompt.
    expect(g("gemini-acp", 1).research).toBe(true);
    expect(g("gemini-acp", 1).env!.HTTPS_PROXY).toMatch(/^http:\/\/council:[\w-]+@cloudly-egress:3128$/);
    expect(g("native-claude", 1).system).toContain("search the web");
    expect(g("gemini-acp", 1).task).toContain("search the web");
    // The credential is live for the proxy while the turn runs, and gone once it ends.
    const token = /^http:\/\/council:([\w-]+)@/.exec(g("gemini-acp", 1).env!.HTTPS_PROXY!)![1]!;
    expect(g("gemini-acp", 1).liveTokens).toEqual([token]);
    expect(JSON.parse(await readFile(OPEN_TOKENS_FILE, "utf8"))).toEqual([]);
  } finally {
    await prisma.user.delete({ where: { id: u.id } });
  }
}, 120000);

test("a member that doesn't answer drops out; a symlinked answer isn't followed; the cap stops the council", async () => {
  const u = await user();
  const seen: Seen[] = [];
  try {
    const c = await council(u.id, ["native-claude", "native-codex", "gemini-acp"]);
    await drain(async (s, dir) => {
      if (s.harness === "native-codex") return symlink("/etc/passwd", path.join(dir, "answer.md")); // falls back to its chat text
      if (s.harness === "gemini-acp" && s.round === 1) return; // writes nothing; its chat text is the answer
      await writeFile(path.join(dir, "answer.md"), `${s.harness} ${s.round}`);
    }, seen);
    const done = await prisma.council.findUniqueOrThrow({ where: { id: c.id }, include: { runs: true } });
    expect(done.status).toBe("done");
    expect(JSON.stringify(done.runs)).not.toContain("root:");
    expect(done.runs.find((r) => r.harness === "native-codex" && r.councilRound === 1)!.output).toBe("done");

    // With a cap already spent after round 1, the council stops with what it has.
    const capped = await council(u.id, ["native-claude", "gemini-acp"], { budgetUsd: 0.5 });
    await drain(async (s, dir) => {
      await writeFile(path.join(dir, "answer.md"), `${s.harness} answer`);
      await prisma.run.updateMany({ where: { councilId: capped.id, harness: s.harness, councilRound: s.round }, data: { costUsd: 0.4 } });
    }, seen);
    const stopped = await prisma.council.findUniqueOrThrow({ where: { id: capped.id }, include: { runs: true } });
    expect(stopped.status).toBe("stopped");
    expect(stopped.runs).toHaveLength(2);
    expect(stopped.report).toContain("spending cap");
    expect(stopped.report).toContain("gemini-acp answer");
  } finally {
    await prisma.user.delete({ where: { id: u.id } });
  }
}, 120000);

test("round instructions", () => {
  const c = { question: "Q?", repo: null, members: ["native-claude", "gemini-acp"], chair: "native-claude", rounds: 2, guidance: [] };
  expect(roundPrompt(c, 1, [], [])).toContain("Round 1 of 2: research, on your own");
  expect(roundPrompt(c, 2, ["round-1/claude.md"], ["Gemini has no answer for round 1"])).toContain("/workspace/.cloudly-council/round-1/claude.md");
  expect(roundPrompt(c, 3, [], [])).toContain("You chair the council");
});
