import { prisma } from "@repo/db";
import { RunSchema, type Run } from "@repo/shared/run";

export async function claimRun(
  workerId: string,
  leaseSeconds = 60,
): Promise<Run | null> {
  const rows = await prisma.$transaction(async (tx) => {
    // Find eligible work first, then take the thread lock before claiming it.
    // A second statement after acquiring the lock sees any claim committed by
    // a worker we had to wait for.
    const candidates = await tx.$queryRaw<Array<{ id: string; threadId: string | null }>>`
      SELECT id, "threadId" FROM "Run"
      WHERE status = 'queued' AND NOT "cancelRequested"
      ORDER BY "createdAt"
      LIMIT 100
    `;

    for (const candidate of candidates) {
      if (candidate.threadId !== null) {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Thread" WHERE id = ${candidate.threadId} FOR UPDATE SKIP LOCKED
        `;
        if (locked.length === 0) continue;
      }

      const claimed = await tx.$queryRaw<unknown[]>`
        UPDATE "Run"
        SET status = 'running',
            "workerId" = ${workerId},
            "leaseUntil" = now() + make_interval(secs => ${leaseSeconds}),
            "leaseGen" = "leaseGen" + 1
        WHERE id = ${candidate.id}
          AND status = 'queued'
          AND NOT "cancelRequested"
          AND ("threadId" IS NULL OR NOT EXISTS (
            SELECT 1 FROM "Run" busy
            WHERE busy."threadId" = "Run"."threadId"
              AND busy.status IN ('running', 'finalizing')
          ))
        RETURNING *
      `;
      if (claimed.length > 0) return claimed;
    }

    return [];
  });

  if (rows.length === 0) return null;
  return RunSchema.parse(rows[0]);
}
