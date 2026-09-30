import { prisma, Prisma } from "@repo/db";
import { RunEventSchema, type RunEvent } from "@repo/shared/run-event";

/**
 * Inserts a batch of RunEvents for a run. Idempotent: re-inserting an event
 * with a (runId, seq) that already exists is silently skipped, not an
 * error — this is what makes crash-recovery replay safe.
 */
export async function insertEvents(
  runId: string,
  events: RunEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  const validated = events.map((e) => RunEventSchema.parse(e));

  const result = await prisma.runEvent.createMany({
    data: validated.map((e) => ({
      runId,
      seq: e.seq,
      ts: new Date(e.ts),
      kind: e.kind,
      data: e.data as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });

  return result.count;
}
