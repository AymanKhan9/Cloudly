import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma, Prisma, budgetStatus, harnessUsesPlan } from "@repo/db";
import type { Run } from "@repo/shared/run";
import { checkLessons } from "@repo/shared/lessons";

import { createWorkspace, destroyWorkspace, type Workspace } from "./workspace";
import { resolveCloneSource } from "./github";
import { createRunContainer, cancelRun, type ContainerOptions } from "./docker";
import { insertEvents } from "./events";
import { heartbeat } from "./heartbeat";
import { costFromDoneEvent } from "./cost";
import { enforceBudget } from "./budget";
import { readRegular } from "./repo-files";
import { sandboxImage } from "./sandbox-image";
import { repoSettings } from "./checks";
import { pause } from "./pause";

// Lessons from a repo's sessions. Cloudly sees what went wrong: the reviewer's
// findings (and which the user dismissed), turns the user rewound, what they
// said after a turn, checks that kept failing, CI it had to fix. A lessons turn
// (Run.kind "lessons", no session) gives an agent all of that, numbered, with the
// repo to check it against; the agent writes the patterns worth a rule in the
// repo's notes. They wait for the user: accepted ones go into the shared notes,
// which every agent working on the repo reads.

export const LESSONS_DIR = "/workspace/.cloudly-lessons";
const MAX_FILE = 64 * 1024;
const WINDOW_DAYS = 60;
/** Fewer signals than this isn't enough to see a pattern in. */
export const MIN_SIGNALS = 3;
const BACKSTOP_USD = 5;

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Messages that read like a correction come first. */
const CORRECTION = /\b(no[,.!]|not (what|that|like)|don'?t|do not|instead|wrong|actually|revert|undo|you (broke|missed|forgot)|should(n'?t| not)? have|why did you|again|stop)\b/i;

export interface Signal {
  ref: string;
  text: string;
  threadId?: string | null;
}

/** What went wrong on a repo's sessions since `since`, each with a reference (F1, R2, C3, K4, I5). */
export async function collectSignals(repo: string, since: Date): Promise<Signal[]> {
  const out: Signal[] = [];
  const threads = await prisma.thread.findMany({ where: { repo, createdAt: { gte: new Date(Date.now() - WINDOW_DAYS * 86400_000) } }, select: { id: true } });
  const ids = threads.map((t) => t.id);
  if (!ids.length) return out;

  // The reviewer's findings, and which the user waved away.
  const findings = await prisma.reviewFinding.findMany({
    where: { threadId: { in: ids }, createdAt: { gte: since }, severity: { in: ["blocking", "suggestion"] } },
    orderBy: { createdAt: "desc" }, take: 40,
  });
  findings.forEach((f, i) => out.push({
    ref: `F${i + 1}`, threadId: f.threadId,
    text: `Reviewer (${f.severity}${f.file ? `, ${f.file}${f.line ? `:${f.line}` : ""}` : ""}): ${clip(f.title, 120)}. ${clip(f.body, 300)}${f.status === "dismissed" ? " [The user dismissed this one.]" : ""}`,
  }));

  // Rewinds: what was undone, and what the user asked for instead.
  const rewinds = await prisma.run.findMany({ where: { threadId: { in: ids }, kind: "rewind", createdAt: { gte: since }, status: "succeeded" }, orderBy: { createdAt: "desc" }, take: 15 });
  for (const [i, r] of rewinds.entries()) {
    const undone = await prisma.run.findMany({ where: { threadId: r.threadId, rewoundAt: { not: null }, createdAt: { lt: r.createdAt }, kind: { in: ["turn", "fix"] } }, orderBy: { createdAt: "asc" }, take: 3, select: { prompt: true } });
    const next = await prisma.run.findFirst({ where: { threadId: r.threadId, createdAt: { gt: r.createdAt }, kind: "turn" }, orderBy: { createdAt: "asc" }, select: { prompt: true } });
    out.push({
      ref: `R${i + 1}`, threadId: r.threadId,
      text: `The user rewound turns that were asked: ${undone.map((u) => `"${clip(u.prompt, 150)}"`).join("; ") || "(unknown)"}.${next ? ` Then asked: "${clip(next.prompt, 300)}"` : ""}`,
    });
  }

  // What the user said after the agent's turns: corrections first.
  const followUps = await prisma.run.findMany({
    where: { threadId: { in: ids }, kind: "turn", trigger: { equals: Prisma.DbNull }, createdAt: { gte: since }, rewoundAt: null },
    orderBy: { createdAt: "desc" }, take: 200, select: { threadId: true, prompt: true, createdAt: true },
  });
  const firsts = new Set(
    (await prisma.run.groupBy({ by: ["threadId"], where: { threadId: { in: ids } }, _min: { createdAt: true } })).map((g) => `${g.threadId}@${g._min.createdAt?.getTime()}`),
  );
  const later = followUps.filter((r) => !firsts.has(`${r.threadId}@${r.createdAt.getTime()}`) && !r.prompt.trim().startsWith("/"));
  const ranked = [...later.filter((r) => CORRECTION.test(r.prompt)), ...later.filter((r) => !CORRECTION.test(r.prompt))].slice(0, 30);
  ranked.forEach((r, i) => out.push({ ref: `C${i + 1}`, threadId: r.threadId, text: `After a turn, the user said: "${clip(r.prompt, 400)}"` }));

  // Checks that failed after a change, by command.
  const failed = await prisma.run.findMany({ where: { repo, checkStatus: "failed", createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 15, select: { threadId: true, checkCommand: true, checkOutput: true } });
  failed.forEach((r, i) => {
    const lines = (r.checkOutput ?? "").split("\n").filter((l) => /error|fail|expected|cannot|not found/i.test(l)).slice(0, 3);
    out.push({ ref: `K${i + 1}`, threadId: r.threadId, text: `Checks failed after a change (${clip(r.checkCommand, 80)}): ${clip(lines.join(" | "), 300) || "(no error lines)"}` });
  });

  // CI Cloudly had to fix on its own pull requests.
  const ci = await prisma.run.findMany({ where: { repo, kind: "ci_fix", createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 10, select: { threadId: true, trigger: true } });
  ci.forEach((r, i) => {
    const checks = ((r.trigger as { checks?: string[] } | null)?.checks ?? []).join(", ");
    out.push({ ref: `I${i + 1}`, threadId: r.threadId, text: `CI failed on a pull request Cloudly opened${checks ? `: ${clip(checks, 200)}` : ""}.` });
  });
  return out;
}

export function lessonsPrompt(): string {
  return [
    `Find lessons in what went wrong on this repository's recent coding sessions. ${LESSONS_DIR}/signals.md lists it, each item with a reference like F3 or C12: the reviewer's findings, turns the user undid, what the user said after a turn, checks and CI that failed. ${LESSONS_DIR}/known.md has the repo's notes and lessons already accepted or turned down.`,
    "",
    "Look for patterns: the same kind of mistake more than once, or one costly enough that a rule would clearly have prevented it. Check each against the code, so the rule names the real files, commands and conventions. Leave out generic good practice (\"write tests\", \"handle errors\"), one-off requests, anything known.md already says or turned down, and findings the user dismissed.",
    "",
    `Write ${LESSONS_DIR}/lessons.json:`,
    "",
    "```json",
    '{ "lessons": [ { "title": "Short name", "rule": "What to do, as an instruction to the next agent: specific, one or two sentences.", "why": "What went wrong without it.", "evidence": ["F3", "C12"] } ] }',
    "```",
    "",
    "At most 6, the most useful first; an empty list is a fine answer. Don't change any other file.",
  ].join("\n");
}

/** A repo's lessons turn. */
export async function processLessonsTurn(run: Run, workerId: string, heartbeatIntervalMs = 20_000): Promise<void> {
  let cancelled = false;
  let leaseLost = false;
  const fenced = { id: run.id, workerId, leaseGen: run.leaseGen };
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
  let ws: Workspace | undefined;
  let dir: string | undefined;
  let agentError: string | undefined;
  const fail = (message: string) => prisma.run.updateMany({ where: fenced, data: { status: cancelled ? "cancelled" : "failed", error: message } });
  try {
    const last = await prisma.run.findFirst({ where: { repo: run.repo, kind: "lessons", status: "succeeded", id: { not: run.id } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const since = last?.createdAt ?? new Date(Date.now() - 60 * 86400_000);
    const signals = await collectSignals(run.repo, since);
    if (signals.length < MIN_SIGNALS) {
      const said = `Not enough to learn from yet: ${signals.length} thing${signals.length === 1 ? "" : "s"} went wrong on ${run.repo} since ${last ? "the last look" : "the last 60 days"}. Lessons need at least ${MIN_SIGNALS}.`;
      await prisma.run.updateMany({ where: fenced, data: { status: "succeeded", output: said } });
      await insertEvents(run.id, [{ seq: 0, ts: Date.now(), kind: "text", data: said }]);
      return;
    }
    const ctx = await prisma.repoContext.findUnique({ where: { repo: run.repo }, select: { notes: true } });
    const known = await prisma.lesson.findMany({ where: { repo: run.repo, status: { in: ["accepted", "dismissed"] } }, select: { title: true, rule: true, status: true } });

    ws = await createWorkspace(await resolveCloneSource(run.repo), { baseBranch: run.baseBranch });
    dir = await mkdtemp(path.join(tmpdir(), "lessons-"));
    await writeFile(path.join(dir, "signals.md"), signals.map((s) => `- [${s.ref}] ${s.text}`).join("\n") + "\n");
    await writeFile(path.join(dir, "known.md"), [
      "# The repo's notes", "", ctx?.notes?.trim() || "(none)", "",
      "# Lessons already decided", "",
      ...(known.length ? known.map((k) => `- (${k.status}) ${k.title}: ${k.rule}`) : ["(none)"]),
    ].join("\n"));

    const onPlan = await harnessUsesPlan(run.harness);
    if (onPlan) await prisma.run.updateMany({ where: fenced, data: { onPlan: true } });
    const options: ContainerOptions = { image: await sandboxImage(), mounts: [[dir, LESSONS_DIR]] };
    if (!onPlan) {
      const budget = run.userId ? await budgetStatus(run.userId) : null;
      if (budget?.limitUsd != null && budget.limitUsd - budget.spentUsd <= 0) throw new Error("Monthly spend limit reached");
      options.maxBudgetUsd = BACKSTOP_USD;
    }

    let lastText: string | undefined;
    try {
      for await (const event of createRunContainer(ws, lessonsPrompt(), run.harness, run.id, options)) {
        await insertEvents(run.id, [event]);
        if (event.kind === "text" && typeof event.data === "string" && event.data.trim()) lastText = event.data;
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
    if (cancelled) return void (await fail("Cancelled."));
    await saveLessons(run, fenced, dir, lastText, signals, agentError);
  } catch (err) {
    await fail(agentError ?? (err instanceof Error ? err.message : String(err)));
  } finally {
    clearInterval(timer);
    if (ws) await destroyWorkspace(ws);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/** lessons.json (or a JSON block in the agent's reply), checked, as proposals. */
export async function saveLessons(
  run: Pick<Run, "id" | "repo">,
  fenced: { id: string; workerId: string; leaseGen: number },
  dir: string,
  lastText: string | undefined,
  signals: Signal[],
  agentError?: string,
): Promise<void> {
  const bytes = await readRegular(path.join(dir, "lessons.json"), MAX_FILE);
  const candidates = [bytes ? new TextDecoder().decode(bytes) : null, lastText?.match(/```(?:json)?\s*\n([\s\S]*?)```/)?.[1] ?? null];
  let found: ReturnType<typeof checkLessons> | null = null;
  for (const text of candidates) {
    if (!text) continue;
    try {
      found = checkLessons(JSON.parse(text));
      if (found.ok) break;
    } catch {}
  }
  if (!found?.ok) {
    await prisma.run.updateMany({ where: fenced, data: { status: "failed", error: agentError ?? "The agent didn't write lessons.json." } });
    return;
  }
  const byRef = new Map(signals.map((s) => [s.ref, s]));
  // Not the same lesson twice.
  const existing = new Set((await prisma.lesson.findMany({ where: { repo: run.repo }, select: { title: true } })).map((l) => l.title.toLowerCase()));
  const fresh = found.lessons.filter((l) => !existing.has(l.title.toLowerCase()));
  await prisma.$transaction(async (tx) => {
    const moved = await tx.run.updateMany({
      where: fenced,
      data: { status: "succeeded", output: fresh.length ? `${fresh.length} lesson${fresh.length === 1 ? "" : "s"} to look over:\n\n${fresh.map((l, i) => `${i + 1}. ${l.title}`).join("\n")}` : "No new lessons: nothing came up often enough to be worth a rule." },
    });
    if (!moved.count) return;
    for (const l of fresh) {
      await tx.lesson.create({
        data: {
          repo: run.repo, runId: run.id, title: l.title, rule: l.rule, why: l.why,
          evidence: l.evidence.map((ref) => ({ ref, text: byRef.get(ref)?.text ?? "", threadId: byRef.get(ref)?.threadId ?? null })).filter((e) => e.text) as never,
        },
      });
    }
  });
}

/** Repos that look for lessons on their own: once a week, when enough has gone wrong since. */
export async function queueWeeklyLessons(now = Date.now()): Promise<number> {
  const repos = await prisma.repoSettings.findMany({ where: { autoLessons: true }, select: { repo: true } });
  let queued = 0;
  for (const { repo } of repos) {
    const last = await prisma.run.findFirst({ where: { repo, kind: "lessons" }, orderBy: { createdAt: "desc" }, select: { createdAt: true, status: true } });
    if (last && (["queued", "running"].includes(last.status) || now - last.createdAt.getTime() < 7 * 86400_000)) continue;
    const signals = await collectSignals(repo, last?.createdAt ?? new Date(now - 60 * 86400_000));
    if (signals.length < 5) continue;
    const thread = await prisma.thread.findFirst({ where: { repo }, orderBy: { createdAt: "desc" }, select: { userId: true, baseBranch: true } });
    if (!thread) continue;
    const settings = await repoSettings(repo);
    const harness = settings.reviewer ?? settings.triggerHarness ?? "native-claude";
    if (!(await harnessUsesPlan(harness)) && (await budgetStatus(thread.userId)).state === "storm") continue;
    await prisma.run.create({ data: { repo, baseBranch: thread.baseBranch, harness, userId: thread.userId, status: "queued", kind: "lessons", prompt: `Lessons from ${repo}'s sessions` } });
    queued++;
  }
  return queued;
}

export async function runLessonsLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await queueWeeklyLessons().catch((err) => console.error("lessons:", err));
    await pause(3600_000, signal);
  }
}
