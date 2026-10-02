import { prisma } from "@repo/db";
import { RunSchema, type Run } from "@repo/shared/run";

export async function claimRun(
  workerId: string,
  leaseSeconds = 60,
): Promise<Run | null> {
  const rows = await prisma.$queryRaw<unknown[]>`
    UPDATE "Run"
    SET status = 'running',
        "workerId" = ${workerId},
        "leaseUntil" = now() + make_interval(secs => ${leaseSeconds}),
        "leaseGen" = "leaseGen" + 1
    WHERE id = (
      SELECT id FROM "Run"
      WHERE status = 'queued'
        AND NOT "cancelRequested"
        AND ("threadId" IS NULL OR NOT EXISTS (
          SELECT 1 FROM "Run" busy
          WHERE busy."threadId" = "Run"."threadId"
            AND busy.status IN ('running', 'finalizing')
        ))
      ORDER BY "createdAt"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `;

  if (rows.length === 0) return null;
  return RunSchema.parse(rows[0]);
}
