import { prisma } from "@repo/db";
import type { Run } from "@repo/shared/run";

// Messages the user sends while a turn runs (the API stores them as RunSteer).
// The worker hands each to the runner once (docker.ts writes it where the runner
// looks); the runner says whether the agent took it. Whatever the turn didn't
// take becomes the session's next turn, so nothing the user said is lost.

/** Waiting messages for a running turn, claimed so each is passed on once. */
export async function takeSteers(runId: string): Promise<{ id: string; text: string }[]> {
  const waiting = await prisma.runSteer.findMany({ where: { runId, status: "pending" }, orderBy: { createdAt: "asc" }, select: { id: true, text: true } });
  const taken: { id: string; text: string }[] = [];
  for (const m of waiting) {
    const r = await prisma.runSteer.updateMany({ where: { id: m.id, status: "pending" }, data: { status: "sent" } });
    if (r.count) taken.push(m);
  }
  return taken;
}

/** The runner's word on a message: the agent has it. */
export async function steerDelivered(event: { kind: string; data: unknown }): Promise<void> {
  const d = event.data as { type?: string; id?: unknown } | null;
  if (event.kind !== "status" || d?.type !== "steer" || typeof d.id !== "string") return;
  await prisma.runSteer.updateMany({ where: { id: d.id, status: { in: ["pending", "sent"] } }, data: { status: "delivered" } });
}

/** After the turn: what it didn't take becomes the next turn. Returns that turn's id. */
export async function requeueSteers(run: Pick<Run, "id" | "threadId" | "repo" | "baseBranch" | "harness" | "userId">): Promise<string | null> {
  if (!run.threadId) return null;
  return prisma.$transaction(async (tx) => {
    const left = await tx.runSteer.findMany({ where: { runId: run.id, status: { in: ["pending", "sent"] } }, orderBy: { createdAt: "asc" } });
    if (!left.length) return null;
    await tx.runSteer.updateMany({ where: { id: { in: left.map((m) => m.id) } }, data: { status: "requeued" } });
    const next = await tx.run.create({
      data: {
        repo: run.repo, baseBranch: run.baseBranch, harness: run.harness, userId: run.userId ?? null, threadId: run.threadId,
        status: "queued", prompt: left.map((m) => m.text).join("\n\n"),
      },
    });
    return next.id;
  });
}
