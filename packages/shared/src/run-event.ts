import { z } from "zod";

export const RunEventKindSchema = z.enum([
    "status",
    "text",
    "tool_call",
    "tool_result",
    "raw",
    "error",
    "done",
])

export const RunEventSchema = z.object({
    seq: z.number(),
    ts: z.number(),
    kind: RunEventKindSchema,
    data: z.unknown(),
})

export type RunEvent = z.infer<typeof RunEventSchema>
