import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma, budgetStatus, harnessUsesPlan, gatewayMcpServers } from "@repo/db";
import type { Run } from "@repo/shared/run";
import type { RunEvent } from "@repo/shared/run-event";

import { createRunContainer, cancelRun, type ContainerOptions } from "./docker";
import { createWorkspace, destroyWorkspace, type Workspace } from "./workspace";
import { resolveCloneSource } from "./github";
import { grantOpenWeb, revokeOpenWeb } from "./egress";
import { insertEvents } from "./events";
import { heartbeat } from "./heartbeat";
import { costFromDoneEvent } from "./cost";
import { enforceBudget } from "./budget";
import { readRegular } from "./repo-files";
import { sandboxImage } from "./sandbox-image";

// A council: several agents on one question, in rounds. Each member researches
// on its own, then reads the others' answers and cross-examines them, then gives
// a final position; the chair writes the report. Every turn is an ordinary run in
// the queue, but nothing it changes is committed: the answer is a file it writes.
// Without a repo, a council is research: open web, no repo, no secrets.

const NAMES: Record<string, string> = { "native-claude": "Claude", "native-codex": "Codex (GPT)", "gemini-acp": "Gemini" };
const SLUGS: Record<string, string> = { "native-claude": "claude", "native-codex": "codex", "gemini-acp": "gemini" };
export const memberName = (h: string) => NAMES[h] ?? h;
const slug = (h: string) => SLUGS[h] ?? h.replace(/[^a-z0-9-]/gi, "-");

/** Where the council's files are inside the sandbox: inside /workspace, so every agent may read them. */
export const COUNCIL_DIR = "/workspace/.cloudly-council";
const ANSWER_MAX = 200_000;
const ACTIVE = ["queued", "running", "finalizing"];
const BACKSTOP_USD = 20;
const OVERSHOOT_RATIO = 0.25;

export function roundName(round: number, rounds: number): string {
  if (round > rounds) return "Report";
  if (round === 1) return "Research";
  if (round === 2) return "Cross-review";
  return "Final positions";
}

interface CouncilLike {
  question: string;
  repo: string | null;
  members: string[];
  chair: string;
  rounds: number;
  guidance: unknown;
}

/** What every council turn is told about the council, before its round's instructions. */
export function councilRules(c: CouncilLike, harness: string): string {
  const others = c.members.filter((m) => m !== harness).map(memberName);
  const notes = (Array.isArray(c.guidance) ? c.guidance : []) as { text: string; round: number }[];
  return [
    `You're ${memberName(harness)}${c.members.includes(harness) ? `, one of ${c.members.length} members of a council in Cloudly, with ${others.join(" and ")}` : `, chairing a council in Cloudly of ${c.members.map(memberName).join(", ")}`}. The council answers one question in rounds; then ${memberName(c.chair)} writes its report.`,
    c.repo
      ? `- The repository ${c.repo} is checked out at /workspace. Read it as you need to. Don't change it: nothing you change is kept, and there's no pull request.`
      : "- You can search the web and open any public web page. Prefer primary and recent sources, and give each source with its date. There's no repository; /workspace is a scratch folder.",
    `- Write your answer for this round, in Markdown, to ${COUNCIL_DIR}/answer.md. That file is what the council and the user see; your chat replies aren't kept.`,
    "- Say plainly when evidence is thin or you're unsure. Don't invent sources.",
    ...notes.map((n) => `- The user added, after round ${n.round}: ${n.text}`),
  ].join("\n");
}

/** This round's instructions. `files` lists the earlier answers written for it to read. */
export function roundPrompt(c: CouncilLike, round: number, files: string[], missing: string[]): string {
  const q = `The question:\n\n${c.question.trim()}\n`;
  const read = files.length ? `\nRead these first, all of them:\n${files.map((f) => `- ${COUNCIL_DIR}/${f}`).join("\n")}\n` : "";
  const gaps = missing.length ? `\n(${missing.join("; ")}.)\n` : "";
  if (round > c.rounds) {
    return `${q}${read}${gaps}
You chair the council: write its report from the members' answers. Don't do new research beyond checking a disputed fact. Attribute views to members by name, and be fair to positions you don't share. The report, in Markdown:

# A title for the report
## Summary
A few sentences that answer the question.
## Where the council agrees
## Where it disagrees
Each disagreement: who holds which side, and why.
## Each member's take
${c.members.map((m) => `### ${memberName(m)}\nTheir final position and confidence, in their terms.`).join("\n")}
## Sources
Deduplicated, with dates.`;
  }
  if (round === 1) {
    return `${q}
Round 1 of ${c.rounds}: research, on your own. The others are doing the same; you'll see their findings ${c.rounds > 1 ? "next round" : "in the report"}. Find the strongest evidence you can. Your answer, in Markdown:

## Findings
Each finding with its source and date.
## How sure
What's solid, and what's thin.
## Open questions
## My take
Your own reading of it, with your confidence: low, medium or high.`;
  }
  if (round === 2) {
    return `${q}${read}${gaps}
Round 2 of ${c.rounds}: cross-review. Check the others' claims, and verify them where you can. Say plainly which you think are wrong, unsupported or out of date, and why; don't just agree. Add what everyone missed. Your answer, in Markdown:

## Where I agree
## Where I disagree
Each: the claim, whose it is, and why.
## What I missed or got wrong
## What changed in my view`;
  }
  return `${q}${read}${gaps}
Round 3 of ${c.rounds}: your final position, after everything you've read. Short. Your answer, in Markdown:

## Conclusion
## Confidence
Low, medium or high, and why.
## The reason that matters most
## What would change my mind`;
}

async function councilSpent(councilId: string): Promise<number> {
  const agg = await prisma.run.aggregate({ where: { councilId }, _sum: { costUsd: true } });
  return agg._sum.costUsd?.toNumber() ?? 0;
}

/** A report built from the last round, for when the chair doesn't finish. */
export function fallbackReport(c: CouncilLike, last: { harness: string; output: string | null }[], why: string): string {
  return [
    `# Council report`,
    "",
    `_${why} Below is each member's last answer, unedited._`,
    "",
    ...last.flatMap((r) => [`## ${memberName(r.harness)}`, "", (r.output ?? "_No answer._").trim(), ""]),
  ].join("\n");
}

/** Creates a round's turns. Safe to call twice: the turns are unique per council, round, role and agent. */
async function createRound(c: { id: string; userId: string; question: string; repo: string | null; baseBranch: string | null; rounds: number; chair: string }, round: number, members: string[]) {
  const chairRound = round > c.rounds;
  const who = chairRound ? [c.chair] : members;
  const label = `${roundName(round, c.rounds)}: ${c.question.trim().split("\n")[0]!.slice(0, 120)}`;
  await prisma.run.createMany({
    skipDuplicates: true,
    data: who.map((harness) => ({
      repo: c.repo ?? "",
      baseBranch: c.baseBranch ?? "",
      prompt: label,
      harness,
      status: "queued" as const,
      userId: c.userId,
      councilId: c.id,
      councilRound: round,
      councilRole: chairRound ? "chair" : "member",
    })),
  });
}

/**
 * Moves a council on once every turn of its round has ended: the next round for
 * the members who finished, then the chair's report, then done. Fenced on the
 * round number, so two workers (or the sweep and a turn) can't both move it.
 */
export async function advanceCouncil(id: string): Promise<void> {
  const c = await prisma.council.findUnique({ where: { id }, include: { runs: true } });
  if (!c || c.status !== "running") return;
  const R = c.round;
  const current = c.runs.filter((r) => r.councilRound === R);
  if (current.length === 0) return createRound(c, R, c.members);
  if (current.some((r) => ACTIVE.includes(r.status))) return;

  const reportRound = c.rounds + 1;
  if (R === reportRound) {
    const chair = current[0]!;
    const last = c.runs.filter((r) => r.councilRound === c.rounds && r.output);
    const report = chair.status === "succeeded" && chair.output ? chair.output : fallbackReport(c, last, `${memberName(c.chair)} didn't finish the report.`);
    await prisma.council.updateMany({ where: { id, round: R, status: "running" }, data: { status: "done", report } });
    return;
  }

  const finished = current.filter((r) => r.status === "succeeded" && r.output);
  if (finished.length === 0) {
    await prisma.council.updateMany({ where: { id, round: R, status: "running" }, data: { status: "failed", error: `No member finished round ${R}.` } });
    return;
  }
  const cap = c.budgetUsd?.toNumber();
  if (cap && (await councilSpent(id)) >= cap) {
    const report = fallbackReport(c, finished, `The council stopped at its $${cap} spending cap after round ${R}.`);
    await prisma.council.updateMany({ where: { id, round: R, status: "running" }, data: { status: "stopped", report, error: `Stopped at the $${cap} spending cap after round ${R}.` } });
    return;
  }
  const moved = await prisma.council.updateMany({ where: { id, round: R, status: "running" }, data: { round: R + 1 } });
  if (moved.count === 0) return;
  await createRound(c, R + 1, finished.map((r) => r.harness));
}

export async function runCouncilLoop(signal: AbortSignal, intervalMs = 3000): Promise<void> {
  while (!signal.aborted) {
    try {
      for (const c of await prisma.council.findMany({ where: { status: "running" }, select: { id: true } })) await advanceCouncil(c.id);
    } catch (err) {
      console.error("[council] sweep failed:", err);
    }
    await Bun.sleep(intervalMs);
  }
}

type RunContainer = (ws: Workspace, task: string, harness: string, runId: string, options?: ContainerOptions) => AsyncIterable<RunEvent>;

/** One member's (or the chair's) turn in a council round. */
export async function processCouncilTurn(run: Run, workerId: string, runContainer: RunContainer = createRunContainer, heartbeatIntervalMs = 20_000): Promise<void> {
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
  let scratch: string | undefined;
  let councilDir: string | undefined;
  let openToken: string | undefined;
  let agentError: string | undefined;
  try {
    const c = await prisma.council.findUniqueOrThrow({ where: { id: run.councilId! }, include: { runs: true } });
    const round = run.councilRound ?? 1;

    // Spend: the council's own cap, then the monthly limit, as for any turn.
    const onPlan = await harnessUsesPlan(run.harness);
    if (onPlan) await prisma.run.updateMany({ where: fenced, data: { onPlan: true } });
    const options: ContainerOptions = { image: await sandboxImage(), mcpServers: Object.keys(await gatewayMcpServers()) };
    if (!onPlan) {
      const caps: number[] = [BACKSTOP_USD];
      const cap = c.budgetUsd?.toNumber();
      if (cap) {
        const left = cap - (await councilSpent(c.id));
        if (left <= 0) throw new Error(`The council's $${cap} spending cap is reached.`);
        caps.push(left);
      }
      const budget = run.userId ? await budgetStatus(run.userId) : null;
      if (budget?.limitUsd != null) {
        const left = budget.limitUsd - budget.spentUsd;
        if (left <= 0) throw new Error("Monthly spend limit reached");
        caps.push(left + budget.limitUsd * OVERSHOOT_RATIO);
      }
      options.maxBudgetUsd = Math.min(...caps);
    }

    // The workspace: the repo, read-only in spirit, or an empty scratch folder.
    if (c.repo) {
      ws = await createWorkspace(await resolveCloneSource(c.repo), { baseBranch: c.baseBranch ?? undefined });
    } else {
      scratch = await mkdtemp(path.join(tmpdir(), "council-scratch-"));
      const runDir = path.join(scratch, "run");
      await mkdir(runDir);
      ws = { scratchDir: scratch, mirrorDir: "", runDir, baseSha: "" };
      const grant = await grantOpenWeb();
      openToken = grant.token;
      options.env = grant.env;
      options.research = true;
    }

    // Earlier rounds' answers, as files to read. The chair reads every round.
    councilDir = await mkdtemp(path.join(tmpdir(), "council-"));
    const earlier = run.councilRole === "chair" ? [...Array(c.rounds).keys()].map((i) => i + 1) : round > 1 ? [round - 1] : [];
    const files: string[] = [];
    const missing: string[] = [];
    for (const r of earlier) {
      for (const m of c.members) {
        const prev = c.runs.find((x) => x.councilRound === r && x.councilRole === "member" && x.harness === m);
        if (!prev?.output) {
          missing.push(`${memberName(m)} has no answer for round ${r}`);
          continue;
        }
        const rel = `round-${r}/${slug(m)}.md`;
        await mkdir(path.join(councilDir, `round-${r}`), { recursive: true });
        await writeFile(path.join(councilDir, rel), prev.output);
        files.push(rel);
      }
    }
    await writeFile(path.join(councilDir, "question.md"), c.question);
    options.mounts = [[councilDir, COUNCIL_DIR]];

    const rules = councilRules(c, run.harness);
    const prompt = roundPrompt(c, round, files, missing);
    let task: string;
    if (run.harness === "native-claude") {
      options.systemAppend = rules;
      task = prompt;
    } else {
      task = `${rules}\n\n${prompt}`;
    }

    let lastText: string | undefined;
    let doneResult: string | undefined;
    try {
      for await (const event of runContainer(ws, task, run.harness, run.id, options)) {
        await insertEvents(run.id, [event]);
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

    // The answer file, read the way the patch is (the agent could have left anything there).
    const bytes = await readRegular(path.join(councilDir, "answer.md"), ANSWER_MAX);
    const written = bytes ? new TextDecoder().decode(bytes).trim() : "";
    const output = written || doneResult?.trim() || lastText?.trim() || null;
    await prisma.run.updateMany({
      where: fenced,
      data: { status: cancelled ? "cancelled" : output ? "succeeded" : "failed", output, error: output ? null : agentError ?? "The agent didn't write an answer." },
    });
  } catch (err) {
    await prisma.run.updateMany({ where: fenced, data: { status: "failed", error: agentError ?? (err instanceof Error ? err.message : String(err)) } });
  } finally {
    clearInterval(timer);
    if (openToken) await revokeOpenWeb(openToken).catch(() => {});
    if (ws && !scratch) await destroyWorkspace(ws);
    if (scratch) await rm(scratch, { recursive: true, force: true });
    if (councilDir) await rm(councilDir, { recursive: true, force: true });
  }
  if (!leaseLost && run.councilId) await advanceCouncil(run.councilId).catch((err) => console.error(`council ${run.councilId}: couldn't advance:`, err));
}
