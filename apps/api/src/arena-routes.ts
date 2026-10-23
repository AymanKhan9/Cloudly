import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma, budgetStatus, harnessUsesPlan } from "@repo/db";
import type { AuthEnv } from "./middleware/auth_middleware";
import { HarnessId, harnessName, threadTitle } from "./harnesses";
import { openPullRequest } from "./github";

// One task, several agents. Each agent gets an ordinary session on its own
// branch; none opens a pull request until the user compares the results and
// picks one. The rest stay as sessions, their branches pushed for reference.

export const arenas = new Hono<AuthEnv>();

const ArenaSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected owner/repo"),
  baseBranch: z.string().min(1).max(255),
  prompt: z.string().trim().min(1).max(8000),
  harnesses: z.array(HarnessId).min(2).max(3).refine((h) => new Set(h).size === h.length, "Pick each agent once."),
  desktop: z.boolean().optional(),
});

arenas.post("/", zValidator("json", ArenaSchema), async (c) => {
  const user = c.get("user");
  const { repo, baseBranch, prompt, harnesses, desktop } = c.req.valid("json");
  const budget = await budgetStatus(user.id);
  if (budget.state === "storm") {
    const paid = [];
    for (const h of harnesses) if (!(await harnessUsesPlan(h))) paid.push(harnessName(h));
    if (paid.length) return c.json({ message: `Monthly spend limit reached, so ${paid.join(" and ")} can't run. Raise it in Settings.`, budget }, 402);
  }
  const arena = await prisma.arena.create({ data: { userId: user.id, repo, baseBranch, prompt } });
  for (const harness of harnesses) {
    const id = crypto.randomUUID();
    await prisma.thread.create({
      data: {
        id, userId: user.id, repo, baseBranch, harness, arenaId: arena.id, autoPr: false, desktop: desktop ?? false,
        title: threadTitle(prompt),
        branch: `agent/thread-${id.slice(0, 8)}`,
        runs: { create: { repo, baseBranch, prompt, harness, status: "queued", userId: user.id } },
      },
    });
  }
  return c.json({ id: arena.id }, 201);
});

/** The text of the last plain reply in a turn: the agent's own summary of what it did. */
async function finalText(runId: string): Promise<string | null> {
  const events = await prisma.runEvent.findMany({ where: { runId, kind: "text" }, orderBy: { seq: "desc" }, take: 40, select: { data: true } });
  for (const e of events) if (typeof e.data === "string" && e.data.trim()) return e.data;
  return null;
}

async function duration(runId: string): Promise<number | null> {
  const span = await prisma.runEvent.aggregate({ where: { runId }, _min: { ts: true }, _max: { ts: true } });
  return span._min.ts && span._max.ts ? span._max.ts.getTime() - span._min.ts.getTime() : null;
}

arenas.get("/:id", async (c) => {
  const arena = await prisma.arena.findFirst({
    where: { id: c.req.param("id"), userId: c.get("user").id },
    include: { threads: { orderBy: { createdAt: "asc" }, include: { runs: { orderBy: { createdAt: "asc" } } } } },
  });
  if (!arena) return c.json({ message: "Arena not found" }, 404);
  const entries = await Promise.all(
    arena.threads.map(async ({ runs, agentSessionId: _a, ...thread }) => {
      const first = runs[0];
      const latest = runs.at(-1);
      return {
        thread,
        turns: runs.length,
        pushed: runs.some((r) => r.commitSha),
        // The first turn is the arena's task; later turns are follow-ups in that session.
        result: first && {
          id: first.id,
          status: first.status,
          cancelRequested: first.cancelRequested,
          costUsd: runs.reduce((sum, r) => sum + (r.costUsd?.toNumber() ?? 0), 0),
          onPlan: first.onPlan,
          error: first.error,
          filesChanged: runs.reduce((sum, r) => sum + (r.filesChanged ?? 0), 0),
          additions: runs.reduce((sum, r) => sum + (r.additions ?? 0), 0),
          deletions: runs.reduce((sum, r) => sum + (r.deletions ?? 0), 0),
          durationMs: await duration(first.id),
          summary: latest ? await finalText(latest.id) : null,
          latestStatus: latest?.status ?? first.status,
        },
      };
    }),
  );
  const { threads: _t, ...meta } = arena;
  return c.json({ arena: meta, entries });
});

arenas.post("/:id/pick", zValidator("json", z.object({ threadId: z.string() })), async (c) => {
  const arena = await prisma.arena.findFirst({ where: { id: c.req.param("id"), userId: c.get("user").id }, include: { threads: true } });
  if (!arena) return c.json({ message: "Arena not found" }, 404);
  const thread = arena.threads.find((t) => t.id === c.req.valid("json").threadId);
  if (!thread) return c.json({ message: "That session isn't part of this arena." }, 400);
  const busy = await prisma.run.count({ where: { threadId: thread.id, status: { in: ["queued", "running", "finalizing"] } } });
  if (busy) return c.json({ message: "Wait for this agent's turn to finish." }, 409);
  if (!(await prisma.run.findFirst({ where: { threadId: thread.id, commitSha: { not: null } } }))) {
    return c.json({ message: "This agent didn't change any files, so there's nothing to open a pull request for." }, 409);
  }
  const others = arena.threads.filter((t) => t.id !== thread.id).map((t) => harnessName(t.harness));
  let prUrl: string;
  try {
    prUrl = await openPullRequest(
      arena.repo, thread.branch, arena.baseBranch, threadTitle(arena.prompt),
      `Opened by Cloudly: ${harnessName(thread.harness)}'s result, picked over ${others.join(" and ")} in an arena.\n\n**Task**\n\n${arena.prompt}`,
    );
  } catch (err) {
    console.error("opening the arena's pull request failed:", err);
    return c.json({ message: "GitHub didn't open the pull request. Check that the branch still exists." }, 502);
  }
  // From here on it's an ordinary session: follow-ups update this pull request.
  await prisma.thread.update({ where: { id: thread.id }, data: { autoPr: true, prUrl } });
  await prisma.arena.update({ where: { id: arena.id }, data: { winnerThreadId: thread.id } });
  return c.json({ prUrl });
});
