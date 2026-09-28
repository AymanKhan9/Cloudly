import { z } from "zod";


export const RunStatusSchema = z.enum(["queued","running","finalizing","succeeded","failed","cancelled"])

export type RunStatus = z.infer<typeof RunStatusSchema>