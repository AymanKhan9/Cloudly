import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { gunzipSync } from "node:zlib";
import { prisma, unseal } from "@repo/db";
import type { AuthEnv } from "./middleware/auth_middleware";
import { tokenOrSession } from "./middleware/token_or_session";

// Sending a session back to the user's computer (the command's "pull"). The
// worker gets the agent's own session file ready (apps/worker/src/handoff.ts);
// the command polls for it, then puts it where the agent on the machine looks.

export const handoffs = new Hono<AuthEnv>();
handoffs.use("*", tokenOrSession);

const ACTIVE = ["queued", "running", "finalizing"];

handoffs.post("/", zValidator("json", z.object({ threadId: z.string().uuid() })), async (c) => {
  const user = c.get("user");
  const thread = await prisma.thread.findFirst({ where: { id: c.req.valid("json").threadId, userId: user.id } });
  if (!thread) return c.json({ message: "Session not found" }, 404);
  if (await prisma.run.count({ where: { threadId: thread.id, status: { in: ACTIVE as never } } })) {
    return c.json({ message: "A turn is still running in that session. Wait for it to finish (or cancel it), then try again." }, 409);
  }
  const h = await prisma.sessionHandoff.create({ data: { threadId: thread.id, userId: user.id, harness: thread.harness } });
  return c.json({ id: h.id }, 201);
});

handoffs.get("/:id", async (c) => {
  const h = await prisma.sessionHandoff.findFirst({ where: { id: c.req.param("id"), userId: c.get("user").id }, include: { thread: true } });
  if (!h) return c.json({ message: "Not found" }, 404);
  if (h.status !== "ready") return c.json({ status: h.status, error: h.error });
  const t = h.thread;
  // The branch has commits only once a turn changed something.
  const committed = await prisma.run.count({ where: { threadId: t.id, commitSha: { not: null }, rewoundAt: null } });
  let file: string | null = null;
  if (h.file) {
    const opened = await unseal(h.file);
    file = opened ? gunzipSync(Buffer.from(opened, "base64")).toString("base64") : null;
  }
  return c.json({
    status: "ready",
    session: { id: t.id, title: t.title, repo: t.repo, baseBranch: t.baseBranch, branch: committed ? t.branch : null, harness: t.harness, prUrl: t.prUrl },
    agentSession: file ? { id: h.sessionId, fileName: h.fileName, file, cwd: "/workspace" } : null,
    transcript: h.transcript,
  });
});
