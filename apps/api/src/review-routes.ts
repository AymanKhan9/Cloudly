import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma, budgetStatus, harnessUsesPlan } from "@repo/db";
import { feedbackPrompt } from "@repo/shared/diff";
import type { AuthEnv } from "./middleware/auth_middleware";

// A session's Changes tab: what the session has changed (from its last commit),
// the reviewer's findings, and sending findings or line comments back as a turn.

export const reviewRoutes = new Hono<AuthEnv>();

const ACTIVE = ["queued", "running", "finalizing"];
const HARNESS = /^[a-z0-9-]{1,80}$/;

async function ownThread(c: { req: { param: (k: string) => string }; get: (k: "user") => { id: string } }) {
  return prisma.thread.findFirst({ where: { id: c.req.param("id"), userId: c.get("user").id } });
}

reviewRoutes.get("/:id/changes", async (c) => {
  const thread = await ownThread(c);
  if (!thread) return c.json({ message: "Session not found" }, 404);
  const findings = await prisma.reviewFinding.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, runId: true, file: true, line: true, severity: true, title: true, body: true, status: true, createdAt: true },
  });
  const settings = await prisma.repoSettings.findUnique({ where: { repo: thread.repo }, select: { reviewer: true } });
  return c.json({ diff: thread.diff ?? "", diffBase: thread.diffBase, findings, reviewer: settings?.reviewer ?? null });
});

reviewRoutes.patch("/:id/findings/:findingId", zValidator("json", z.object({ status: z.enum(["open", "dismissed"]) })), async (c) => {
  const thread = await ownThread(c);
  if (!thread) return c.json({ message: "Session not found" }, 404);
  const r = await prisma.reviewFinding.updateMany({ where: { id: c.req.param("findingId"), threadId: thread.id }, data: { status: c.req.valid("json").status } });
  if (r.count === 0) return c.json({ message: "Finding not found" }, 404);
  return c.json({ ok: true });
});

/** Starts a turn for the session, or says why it can't start now. */
async function startTurn(
  c: { get: (k: "user") => { id: string } },
  thread: { id: string; repo: string; baseBranch: string; harness: string },
  data: { prompt: string; harness: string; kind: string },
) {
  const user = c.get("user");
  const active = await prisma.run.count({ where: { threadId: thread.id, status: { in: ACTIVE as never } } });
  if (active > 0) return { error: "Wait for the current turn to finish, or cancel it.", status: 409 as const };
  const budget = await budgetStatus(user.id);
  if (budget.state === "storm" && !(await harnessUsesPlan(data.harness))) {
    return { error: "Monthly spend limit reached. Raise it in Settings to continue.", status: 402 as const };
  }
  const run = await prisma.run.create({
    data: { repo: thread.repo, baseBranch: thread.baseBranch, userId: user.id, threadId: thread.id, status: "queued", ...data },
  });
  await prisma.thread.update({ where: { id: thread.id }, data: { updatedAt: new Date(), settledAt: null, snoozedUntil: null, archivedAt: null, needsInput: null } });
  return { id: run.id };
}

// "Review now": the repo's reviewer, or the one picked, reviews the session's change.
reviewRoutes.post("/:id/review", zValidator("json", z.object({ harness: z.string().regex(HARNESS).optional() })), async (c) => {
  const thread = await ownThread(c);
  if (!thread) return c.json({ message: "Session not found" }, 404);
  if (!thread.diff?.trim()) return c.json({ message: "Nothing to review yet: the session hasn't changed anything." }, 400);
  const settings = await prisma.repoSettings.findUnique({ where: { repo: thread.repo }, select: { reviewer: true } });
  const harness = c.req.valid("json").harness ?? settings?.reviewer ?? thread.harness;
  const r = await startTurn(c, thread, { prompt: "Review the changes", harness, kind: "review" });
  if ("error" in r) return c.json({ message: r.error }, r.status);
  return c.json({ id: r.id }, 201);
});

const FeedbackSchema = z
  .object({
    findingIds: z.array(z.string().uuid()).max(50).default([]),
    comments: z.array(z.object({ file: z.string().trim().min(1).max(500), line: z.number().int().positive(), body: z.string().trim().min(1).max(4000) })).max(50).default([]),
    note: z.string().trim().max(4000).optional(),
  })
  .refine((f) => f.findingIds.length + f.comments.length > 0 || Boolean(f.note), { message: "Pick a finding or write a comment." });

// Picked findings and line comments go to the session's agent as its next turn.
reviewRoutes.post("/:id/feedback", zValidator("json", FeedbackSchema), async (c) => {
  const thread = await ownThread(c);
  if (!thread) return c.json({ message: "Session not found" }, 404);
  const { findingIds, comments, note } = c.req.valid("json");
  const findings = findingIds.length
    ? await prisma.reviewFinding.findMany({ where: { id: { in: findingIds }, threadId: thread.id }, orderBy: { createdAt: "asc" } })
    : [];
  if (findings.length !== findingIds.length) return c.json({ message: "Finding not found" }, 404);
  const r = await startTurn(c, thread, { prompt: feedbackPrompt({ findings, comments, note }), harness: thread.harness, kind: "turn" });
  if ("error" in r) return c.json({ message: r.error }, r.status);
  if (findings.length) await prisma.reviewFinding.updateMany({ where: { id: { in: findingIds } }, data: { status: "sent" } });
  return c.json({ id: r.id }, 201);
});
