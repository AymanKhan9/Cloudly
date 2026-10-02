import { z } from "zod";
import { RunStatusSchema } from "./run-status";

// Prisma's Decimal wrapper (from a raw $queryRaw result) is never imported
// here directly — packages/shared stays decoupled from packages/db's
// generated internals. Duck-type on the shape instead: a number, a numeric
// string, or anything with .toNumber().
const DecimalLike = z
  .union([
    z.number(),
    z.string(),
    z.custom<{ toNumber: () => number }>(
      (val) => typeof (val as { toNumber?: unknown })?.toNumber === "function",
    ),
  ])
  .transform((val): number => {
    if (typeof val === "number") return val;
    if (typeof val === "string") return parseFloat(val);
    return val.toNumber();
  });

export const RunSchema = z.object({
  id: z.string(),
  userId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  status: RunStatusSchema,
  createdAt: z.coerce.date(),
  leaseUntil: z.coerce.date().nullable(),
  leaseGen: z.number(),
  attempts: z.number(),
  cancelRequested: z.boolean(),
  costUsd: DecimalLike.nullable(),
  repo: z.string(),
  baseBranch: z.string(),
  branch: z.string().nullable(),
  prompt: z.string(),
  harness: z.string(),
  workerId: z.string().nullable(),
  sessionId: z.string().nullable(),
  baseSha: z.string().nullable(),
  commitSha: z.string().nullable(),
  patchHash: z.string().nullable(),
  prUrl: z.string().nullable(),
  error: z.string().nullable(),
});

export type Run = z.infer<typeof RunSchema>;
