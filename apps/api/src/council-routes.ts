import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma, budgetStatus, harnessUsesPlan, Prisma } from "@repo/db";
import type { AuthEnv } from "./middleware/auth_middleware";
import { harnessName, isHarness, checkAgents } from "./harnesses";
import { knownAgentName } from "@repo/shared/agent-names";

// A council: several agents answer one question in rounds (research, then
// cross-review, then final positions) and a chair writes the report. The worker
// runs the rounds; this creates the council with its first round, shows it, and
// takes the user's notes between rounds.

const AgentId = z.string().regex(/^[a-z0-9-]{1,80}$/, "an agent id");

export const councils = new Hono<AuthEnv>();

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Research, then as many rounds of debate as asked, the last one final positions. */
export const MAX_ROUNDS = 10;

const CouncilSchema = z
  .object({
    question: z.string().trim().min(1).max(8000),
    // As many agents as the user has set up, each once.
    // Agent ids; whether each can run is checked below, with a reason for each that can't.
    members: z.array(AgentId).min(2).max(30).refine((m) => new Set(m).size === m.length, "Pick each agent once."),
    chair: AgentId,
    rounds: z.number().int().min(1).max(MAX_ROUNDS).default(3),
    /** A member's (or the chair's) model and effort; left out, the agent's own default. */
    settings: z.record(AgentId, z.object({ model: z.string().trim().min(1).max(100).regex(/^\S+$/).optional(), effort: z.string().trim().min(1).max(40).optional() })).optional(),
    repo: z.string().regex(SLUG, "expected owner/repo").nullable().optional(),
    baseBranch: z.string().min(1).max(255).nullable().optional(),
    budgetUsd: z.number().min(0.5).max(1000).nullable().optional(),
  })
  .refine((c) => !c.repo || c.baseBranch, { message: "Give the base branch for the repo.", path: ["baseBranch"] });

/** Typical cost of one turn per agent, from the user's own recent turns. */
async function typicalTurnCost(userId: string, harness: string): Promise<number | null> {
  const recent = await prisma.run.findMany({
    where: { userId, harness, status: "succeeded", onPlan: false, costUsd: { gt: 0 } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { costUsd: true },
  });
  if (recent.length < 3) return null;
  const sorted = recent.map((r) => r.costUsd!.toNumber()).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** How many turns a council takes, and roughly what they cost, from the user's history. */
councils.get("/estimate", async (c) => {
  const members: string[] = [];
  for (const m of (c.req.query("members") ?? "").split(",")) if (m && (await isHarness(m))) members.push(m);
  const asked = c.req.query("chair");
  const chair = asked && (await isHarness(asked)) ? asked : members[0];
  const rounds = Math.min(MAX_ROUNDS, Math.max(1, Number(c.req.query("rounds")) || 3));
  const turns = [...members.flatMap((m) => Array(rounds).fill(m) as string[]), ...(chair ? [chair] : [])];
  let usd = 0;
  let known = true;
  const plan: string[] = [];
  for (const h of new Set(turns)) {
    if (await harnessUsesPlan(h)) {
      plan.push(harnessName(h));
      continue;
    }
    const each = await typicalTurnCost(c.get("user").id, h);
    if (each === null) known = false;
    else usd += each * turns.filter((t) => t === h).length;
  }
  return c.json({ turns: turns.length, usd: known ? Math.round(usd * 100) / 100 : null, onPlan: plan });
});

councils.post("/", zValidator("json", CouncilSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const budget = await budgetStatus(user.id);
  if (budget.state === "storm") {
    const paid = [];
    for (const h of new Set([...body.members, body.chair])) if (!(await harnessUsesPlan(h))) paid.push(harnessName(h));
    if (paid.length) return c.json({ message: `Monthly spend limit reached, so ${paid.join(" and ")} can't run. Raise it in Settings.`, budget }, 402);
  }
  // Every member and the chair must be able to run, or the council stalls a round in.
  const notReady = (await checkAgents([...body.members, body.chair], Object.fromEntries([...body.members, body.chair].map((id) => [id, knownAgentName(id) ?? id])))).filter((r) => !r.ready);
  if (notReady.length) {
    return c.json({ message: notReady.map((r) => r.reason).join(" "), notReady }, 400);
  }
  const council = await prisma.council.create({
    data: {
      userId: user.id,
      question: body.question,
      members: body.members,
      chair: body.chair,
      rounds: body.rounds,
      repo: body.repo ?? null,
      baseBranch: body.repo ? body.baseBranch ?? null : null,
      budgetUsd: body.budgetUsd ?? null,
      settings: (body.settings ?? {}) as Prisma.InputJsonValue,
    },
  });
  await prisma.run.createMany({
    data: body.members.map((harness) => ({
      repo: council.repo ?? "",
      baseBranch: council.baseBranch ?? "",
      prompt: `Research: ${body.question.trim().split("\n")[0]!.slice(0, 120)}`,
      harness,
      status: "queued" as const,
      userId: user.id,
      councilId: council.id,
      councilRound: 1,
      councilRole: "member",
    })),
  });
  return c.json({ id: council.id }, 201);
});

councils.get("/", async (c) => {
  const rows = await prisma.council.findMany({
    where: { userId: c.get("user").id },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, question: true, members: true, status: true, round: true, rounds: true, repo: true, createdAt: true, updatedAt: true },
  });
  return c.json({ councils: rows });
});

async function owned(id: string, userId: string) {
  return prisma.council.findFirst({ where: { id, userId } });
}

councils.get("/:id", async (c) => {
  const council = await prisma.council.findFirst({
    where: { id: c.req.param("id"), userId: c.get("user").id },
    include: { runs: { orderBy: [{ councilRound: "asc" }, { createdAt: "asc" }] } },
  });
  if (!council) return c.json({ message: "Council not found" }, 404);
  const turns = await Promise.all(
    council.runs.map(async (r) => {
      const span = await prisma.runEvent.aggregate({ where: { runId: r.id }, _min: { ts: true }, _max: { ts: true } });
      return {
        id: r.id,
        harness: r.harness,
        round: r.councilRound,
        role: r.councilRole,
        status: r.status,
        cancelRequested: r.cancelRequested,
        costUsd: r.costUsd?.toNumber() ?? null,
        onPlan: r.onPlan,
        output: r.output,
        error: r.error,
        createdAt: r.createdAt,
        durationMs: span._min.ts && span._max.ts ? span._max.ts.getTime() - span._min.ts.getTime() : null,
      };
    }),
  );
  // A round's turns are created together, with the same timestamp: order them the way the members were picked.
  const place = (h: string) => council.members.indexOf(h);
  turns.sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || place(a.harness) - place(b.harness));
  const { runs: _r, ...meta } = council;
  return c.json({
    council: { ...meta, budgetUsd: meta.budgetUsd?.toNumber() ?? null },
    turns,
    spentUsd: turns.reduce((n, t) => n + (t.costUsd ?? 0), 0),
  });
});

// A note for the rounds still to come ("focus on AI roles"), read by every later turn.
councils.post("/:id/guidance", zValidator("json", z.object({ text: z.string().trim().min(1).max(2000) })), async (c) => {
  const council = await owned(c.req.param("id"), c.get("user").id);
  if (!council) return c.json({ message: "Council not found" }, 404);
  if (council.status !== "running") return c.json({ message: "This council has finished." }, 409);
  const notes = Array.isArray(council.guidance) ? (council.guidance as Prisma.JsonArray) : [];
  await prisma.council.update({
    where: { id: council.id },
    data: { guidance: [...notes, { text: c.req.valid("json").text, round: council.round, at: new Date().toISOString() }] },
  });
  return c.json({ ok: true });
});

// Ends the debate early: the round under way is the last, then the chair writes the report.
councils.post("/:id/finish", async (c) => {
  const council = await owned(c.req.param("id"), c.get("user").id);
  if (!council) return c.json({ message: "Council not found" }, 404);
  if (council.status !== "running") return c.json({ message: `The council is already ${council.status}.` }, 409);
  if (council.round > council.rounds) return c.json({ message: "The chair is already writing the report." }, 409);
  await prisma.council.update({ where: { id: council.id }, data: { rounds: council.round } });
  return c.json({ ok: true, rounds: council.round });
});

councils.post("/:id/cancel", async (c) => {
  const council = await owned(c.req.param("id"), c.get("user").id);
  if (!council) return c.json({ message: "Council not found" }, 404);
  if (council.status !== "running") return c.json({ message: `The council is already ${council.status}.` }, 409);
  await prisma.council.update({ where: { id: council.id }, data: { status: "cancelled" } });
  await prisma.run.updateMany({ where: { councilId: council.id, status: "queued" }, data: { status: "cancelled", cancelRequested: true } });
  await prisma.run.updateMany({ where: { councilId: council.id, status: { in: ["running", "finalizing"] } }, data: { cancelRequested: true } });
  return c.json({ ok: true });
});

councils.get("/:id/report", async (c) => {
  const council = await owned(c.req.param("id"), c.get("user").id);
  if (!council?.report) return c.json({ message: "No report yet." }, 404);
  return new Response(council.report, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="council-report.md"',
      "x-content-type-options": "nosniff",
    },
  });
});
