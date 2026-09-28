import { z } from "zod";

export const HarnessManifestSchema = z.object({
    id: z.string(),
    image: z.string(),
    adapter: z.string(),
    credentials: z.array(z.string()),
    capabilities: z.object({
        resume: z.boolean(),
        cost: z.boolean(),
        pre_action_hook: z.boolean(),
        interrupt: z.boolean(),
    }),
})

export type HarnessManifest = z.infer<typeof HarnessManifestSchema>
