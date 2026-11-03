import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma, addContextEntry, setContextNotes } from "@repo/db";
import { notesWithLesson } from "@repo/shared/lessons";
import type { AuthEnv } from "./middleware/auth_middleware";
import { listInstallationRepos } from "./github";

// Lessons from a repo's sessions (see the worker's lessons.ts): look for them,
// then accept (into the repo's shared notes), edit, or dismiss each.

export const lessons = new Hono<AuthEnv>();
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ORDER: Record<string, number> = { proposed: 0, accepted: 1, dismissed: 2 };

lessons.get("/", async (c) => {
  const repo = c.req.query("repo") ?? "";
  if (!SLUG.test(repo)) return c.json({ message: "Expected ?repo=owner/repo" }, 400);
  const rows = await prisma.lesson.findMany({ where: { repo }, orderBy: { createdAt: "desc" }, take: 100 });
  const run = await prisma.run.findFirst({ where: { repo, kind: "lessons" }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, output: true, error: true, createdAt: true, harness: true, costUsd: true } });
  const settings = await prisma.repoSettings.findUnique({ where: { repo }, select: { autoLessons: true } });
  const ctx = await prisma.repoContext.findUnique({ where: { repo }, select: { enabled: true } });
  return c.json({
    repo,
    lessons: rows.sort((a, b) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3)),
    run: run ? { ...run, costUsd: run.costUsd?.toNumber() ?? null } : null,
    autoLessons: settings?.autoLessons ?? false,
    contextOn: ctx?.enabled ?? false,
  });
});

lessons.post("/run", zValidator("json", z.object({ repo: z.string().regex(SLUG), harness: z.string().regex(/^[a-z0-9-]{1,80}$/).optional() })), async (c) => {
  const user = c.get("user");
  const { repo, harness: asked } = c.req.valid("json");
  if (await prisma.run.count({ where: { repo, kind: "lessons", status: { in: ["queued", "running"] } } })) {
    return c.json({ message: "Cloudly is already looking at this repo's sessions." }, 409);
  }
  const settings = await prisma.repoSettings.findUnique({ where: { repo } });
  const harness = asked ?? settings?.reviewer ?? settings?.triggerHarness ?? "native-claude";
  const base = (await listInstallationRepos().catch(() => [])).find((r) => r.fullName === repo)?.defaultBranch
    ?? (await prisma.thread.findFirst({ where: { repo }, orderBy: { createdAt: "desc" }, select: { baseBranch: true } }))?.baseBranch ?? "main";
  const run = await prisma.run.create({ data: { repo, baseBranch: base, harness, userId: user.id, status: "queued", kind: "lessons", prompt: `Lessons from ${repo}'s sessions` } });
  return c.json({ id: run.id }, 201);
});

lessons.post(
  "/:id/accept",
  zValidator("json", z.object({ title: z.string().trim().min(3).max(100).optional(), rule: z.string().trim().min(10).max(600).optional() })),
  async (c) => {
    const lesson = await prisma.lesson.findUnique({ where: { id: c.req.param("id") } });
    if (!lesson) return c.json({ message: "Not found" }, 404);
    const edit = c.req.valid("json");
    const title = edit.title ?? lesson.title;
    const rule = edit.rule ?? lesson.rule;
    const ctx = await prisma.repoContext.findUnique({ where: { repo: lesson.repo } });
    await setContextNotes(lesson.repo, notesWithLesson(ctx?.notes ?? "", { title, rule }));
    // Notes reach agents through shared context, so it's on for the repo from now.
    await prisma.repoContext.update({ where: { repo: lesson.repo }, data: { enabled: true } });
    await addContextEntry({ repo: lesson.repo, kind: "decision", author: c.get("user").login, source: "cloudly", title: `Lesson: ${title}`, body: `${rule}${lesson.why ? `\n\nWhy: ${lesson.why}` : ""}` });
    await prisma.lesson.update({ where: { id: lesson.id }, data: { title, rule, status: "accepted", decidedAt: new Date() } });
    return c.json({ ok: true, turnedOnContext: !ctx?.enabled });
  },
);

lessons.post("/:id/dismiss", async (c) => {
  const r = await prisma.lesson.updateMany({ where: { id: c.req.param("id"), status: "proposed" }, data: { status: "dismissed", decidedAt: new Date() } });
  return r.count ? c.json({ ok: true }) : c.json({ message: "Not found, or decided already" }, 404);
});

lessons.put("/settings", zValidator("json", z.object({ repo: z.string().regex(SLUG), autoLessons: z.boolean() })), async (c) => {
  const { repo, autoLessons } = c.req.valid("json");
  await prisma.repoSettings.upsert({ where: { repo }, update: { autoLessons }, create: { repo, autoLessons } });
  return c.json({ ok: true });
});
