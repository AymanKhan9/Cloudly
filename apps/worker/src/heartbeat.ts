import { prisma } from "@repo/db";

/**
 * Refreshes the lease for a run this worker believes it owns.
 * Returns false if zero rows were updated — meaning another worker has
 * already taken over (the lease expired and was reclaimed), so this
 * worker must stop touching the run immediately.
 */
export async function heartbeat(
  runId: string,
  workerId: string,
  leaseSeconds = 60,
): Promise<boolean> {
  const leaseUntil = new Date(Date.now() + leaseSeconds * 1000);

  const result = await prisma.run.updateMany({
    where: { id: runId, workerId },
    data: { leaseUntil },
  });

  return result.count > 0;
}
