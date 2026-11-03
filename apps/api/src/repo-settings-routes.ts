import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma, config, hasDesktop } from "@repo/db";
import type { AuthEnv } from "./middleware/auth_middleware";

// How Cloudly treats a repo's turns: its checks, how many times the agent may
// try to fix them, and the agent that reviews each change. No row means the defaults; the worker reads the same row.

export const repoSettings = new Hono<AuthEnv>();

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULTS = {
  checks: "auto", checkCommand: null as string | null, fixAttempts: 2, checkTimeoutSec: 600,
  reviewer: null as string | null, reviewRounds: 2, reviewPostToGitHub: true,
  triggerHarness: null as string | null, issueLabel: "cloudly", onIssueLabel: true, onMention: true, onPrReview: true, fixCi: true, ciFixAttempts: 2,
  autoMerge: false, mergeMethod: "squash",
  screenshots: false, screenshotCommand: null as string | null, screenshotPort: 3000, screenshotPaths: ["/"] as string[],
  autoLessons: false,
};

function repoOf(c: { req: { param: (k: string) => string } }) {
  const repo = `${c.req.param("owner")}/${c.req.param("name")}`;
  return SLUG.test(repo) ? repo : null;
}

repoSettings.get("/:owner/:name", async (c) => {
  const repo = repoOf(c);
  if (!repo) return c.json({ message: "Expected owner/repo" }, 400);
  const row = await prisma.repoSettings.findUnique({ where: { repo } });
  // What the checks last ran as, so "Auto" shows what it found.
  const last = await prisma.run.findFirst({
    where: { repo, checkStatus: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { checkCommand: true, checkStatus: true, createdAt: true },
  });
  const { updatedAt: _u, repo: _r, ...settings } = row ?? { repo, updatedAt: null, ...DEFAULTS };
  // Screenshots need Chromium, which comes with the sandbox's desktop tools.
  const desktopTools = hasDesktop(((await config("SANDBOX_SETUP_SCRIPT")) ?? "").trim());
  // The command a preview of this repo last ran, as a starting point.
  const preview = await prisma.preview.findFirst({ where: { thread: { repo } }, orderBy: { createdAt: "desc" }, select: { command: true, port: true } });
  return c.json({ repo, settings, last, desktopTools, preview });
});

const SettingsSchema = z
  .object({
    checks: z.enum(["auto", "custom", "off"]),
    checkCommand: z.string().trim().max(2000).nullable().optional(),
    fixAttempts: z.number().int().min(0).max(5),
    checkTimeoutSec: z.number().int().min(60).max(3600),
    // The agent that reviews each change; null for none. Left out keeps what's saved.
    reviewer: z.string().regex(/^[a-z0-9-]{1,80}$/).nullable().optional(),
    reviewRounds: z.number().int().min(0).max(5).optional(),
    reviewPostToGitHub: z.boolean().optional(),
  })
  .partial({ checks: true, fixAttempts: true, checkTimeoutSec: true })
  .extend({
    // GitHub triggers (see Settings > GitHub triggers). Left out keeps what's saved.
    triggerHarness: z.string().regex(/^[a-z0-9-]{1,80}$/).nullable().optional(),
    issueLabel: z.string().trim().min(1).max(50).optional(),
    onIssueLabel: z.boolean().optional(),
    onMention: z.boolean().optional(),
    onPrReview: z.boolean().optional(),
    fixCi: z.boolean().optional(),
    ciFixAttempts: z.number().int().min(0).max(5).optional(),
    // New sessions start with merge-when-ready on, and how it merges.
    autoMerge: z.boolean().optional(),
    mergeMethod: z.enum(["squash", "merge", "rebase"]).optional(),
    // Before-and-after screenshots of UI changes.
    screenshots: z.boolean().optional(),
    screenshotCommand: z.string().trim().max(2000).nullable().optional(),
    screenshotPort: z.number().int().min(1).max(65535).optional(),
    autoLessons: z.boolean().optional(),
    screenshotPaths: z.array(z.string().trim().regex(/^\/[\w\-./?=&%#~]*$/, "A page starts with /")).min(1).max(6).optional(),
  })
  .refine((s) => s.checks !== "custom" || Boolean(s.checkCommand), { message: "Enter the command to run.", path: ["checkCommand"] });

repoSettings.put("/:owner/:name", zValidator("json", SettingsSchema), async (c) => {
  const repo = repoOf(c);
  if (!repo) return c.json({ message: "Expected owner/repo" }, 400);
  const body = c.req.valid("json");
  const data = { ...body, ...(body.checkCommand !== undefined || body.checks ? { checkCommand: body.checkCommand || null } : {}) };
  await prisma.repoSettings.upsert({ where: { repo }, update: data, create: { repo, ...data } });
  return c.json({ ok: true });
});
