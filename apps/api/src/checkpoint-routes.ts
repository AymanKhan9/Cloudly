import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma, harnessAvailable } from "@repo/db";
import type { AuthEnv } from "./middleware/auth_middleware";
import { HARNESSES } from "./harnesses";

// Checkpoints: rewind a session to just after one of its turns, or fork a new
// session from there. Both are queued turns the worker carries out
// (apps/worker/src/checkpoints.ts), so they wait for a running turn.

export const checkpoints = new Hono<AuthEnv>();

const ACTIVE = ["queued", "running", "finalizing"];

/** Why the session can't go back to that turn now, if it can't. */
async function problem(thread: { id: string; mergedAt: Date | null }, target: { status: string; rewoundAt: Date | null; kind: string; createdAt: Date } | null, rewind: boolean) {
  if (!target || target.kind === "rewind" || target.kind === "fork" || target.kind === "import" || target.kind === "screenshots") return "No such turn in this session.";
  // Cloudly has an imported session's code only as it was when it came in.
  if (target.kind === "import_turn") {
    const later = await prisma.run.count({ where: { threadId: thread.id, kind: "import_turn", createdAt: { gt: target.createdAt } } });
    if (later) return "Cloudly has this session's code only as it was when it was imported, so it can go back to the last imported turn but not before it.";
  }
  if (target.rewoundAt) return "That turn was rewound already.";
  if (ACTIVE.includes(target.status)) return "That turn hasn't finished yet.";
  if (rewind && thread.mergedAt) return "The pull request is merged, so the branch stays as it is. Fork the session instead.";
  if (await prisma.run.count({ where: { threadId: thread.id, status: { in: ACTIVE as never } } })) {
    return rewind ? "Wait for the current turn to finish, or cancel it." : null;
  }
  return null;
}

async function turnNumber(threadId: string, runId: string) {
  const runs = await prisma.run.findMany({ where: { threadId, kind: { notIn: ["rewind", "fork", "import", "screenshots"] } }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return runs.findIndex((r) => r.id === runId) + 1;
}

checkpoints.post("/:id/rewind", zValidator("json", z.object({ runId: z.string().uuid() })), async (c) => {
  const user = c.get("user");
  const thread = await prisma.thread.findFirst({ where: { id: c.req.param("id"), userId: user.id } });
  if (!thread) return c.json({ message: "Session not found" }, 404);
  if (!thread.repo) return c.json({ message: "Rewinding needs the session to be on a repository." }, 400);
  const target = await prisma.run.findFirst({ where: { id: c.req.valid("json").runId, threadId: thread.id } });
  const why = await problem(thread, target, true);
  if (why) return c.json({ message: why }, 409);
  // Nothing after it: nothing to undo.
  const later = await prisma.run.count({ where: { threadId: thread.id, createdAt: { gt: target!.createdAt }, rewoundAt: null } });
  if (later === 0) return c.json({ message: "That's the latest turn; there's nothing after it to undo." }, 409);
  const n = await turnNumber(thread.id, target!.id);
  const run = await prisma.run.create({
    data: {
      repo: thread.repo, baseBranch: thread.baseBranch, harness: thread.harness, userId: user.id, threadId: thread.id,
      status: "queued", kind: "rewind", targetRunId: target!.id, prompt: `Rewind to after turn ${n}`,
    },
  });
  await prisma.thread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
  return c.json({ id: run.id }, 201);
});

const ForkSchema = z.object({
  runId: z.string().uuid(),
  /** Another agent for the fork; the same one if left out. */
  harness: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
  /** Its first message, sent once the fork is ready. */
  prompt: z.string().trim().max(8000).optional(),
});

checkpoints.post("/:id/fork", zValidator("json", ForkSchema), async (c) => {
  const user = c.get("user");
  const parent = await prisma.thread.findFirst({ where: { id: c.req.param("id"), userId: user.id } });
  if (!parent) return c.json({ message: "Session not found" }, 404);
  if (!parent.repo) return c.json({ message: "Forking needs the session to be on a repository." }, 400);
  const { runId, harness: picked, prompt } = c.req.valid("json");
  const target = await prisma.run.findFirst({ where: { id: runId, threadId: parent.id } });
  const why = await problem(parent, target, false);
  if (why) return c.json({ message: why }, 409);
  const harness = picked ?? parent.harness;
  if (!(await harnessAvailable(harness, HARNESSES.map((h) => h.id)))) return c.json({ message: "That agent isn't available here." }, 400);

  const n = await turnNumber(parent.id, target!.id);
  const id = crypto.randomUUID();
  await prisma.thread.create({
    data: {
      id, userId: user.id, repo: parent.repo, baseBranch: parent.baseBranch, harness,
      title: `${parent.title.slice(0, 100)} (fork at turn ${n})`,
      branch: `agent/thread-${id.slice(0, 8)}`,
      // The session's model and effort carry over when the agent does.
      model: harness === parent.harness ? parent.model : null,
      effort: harness === parent.harness ? parent.effort : null,
      peers: parent.peers,
      forkOfThreadId: parent.id,
      forkAtRunId: target!.id,
      runs: {
        create: {
          repo: parent.repo, baseBranch: parent.baseBranch, harness, userId: user.id, status: "queued",
          kind: "fork", targetRunId: target!.id, prompt: `Fork of "${parent.title}" after turn ${n}`,
        },
      },
    },
  });
  // Its first message waits behind the fork turn (a session runs one turn at a time, in order).
  if (prompt) {
    await prisma.run.create({
      data: { repo: parent.repo, baseBranch: parent.baseBranch, harness, userId: user.id, threadId: id, status: "queued", prompt, createdAt: new Date(Date.now() + 1) },
    });
  }
  return c.json({ id }, 201);
});
