import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma, config, hasDesktop, signRelayToken } from "@repo/db";
import type { AuthEnv } from "./middleware/auth_middleware";

// Watching a turn's desktop, and previews of a session's app. The browser never
// reaches a sandbox directly: it gets a short-lived token for the relay, which
// only accepts that token for that one container.

const ACTIVE = ["requested", "starting", "running", "stopping"];
const previewOrigin = () => process.env.PREVIEW_ORIGIN?.replace(/\/$/, "") || null;
const PREVIEW_MAX = Math.max(1, Number(process.env.PREVIEW_MAX ?? 1));

/** What this instance can offer, for showing or hiding the controls. */
export async function capabilities() {
  const image = await prisma.sandboxImage.findUnique({ where: { id: 1 } });
  const script = (await config("SANDBOX_SETUP_SCRIPT")) ?? "";
  const mcp = await prisma.mcpServer.findMany({ where: { enabled: true, status: "connected" }, select: { name: true } });
  return {
    // Ticked and built: the image runs actually use has the desktop in it.
    desktop: hasDesktop(script) && image?.status === "ready" && image.image !== "cloud-agents-base",
    previews: Boolean(previewOrigin()),
    mcp: mcp.map((m) => m.name),
  };
}

export const live = new Hono<AuthEnv>();

live.get("/capabilities", async (c) => c.json(await capabilities()));

async function ownedThread(id: string, userId: string) {
  return prisma.thread.findFirst({ where: { id, userId } });
}

// The desktop of the turn that's running now.
live.get("/threads/:id/desktop", async (c) => {
  const thread = await ownedThread(c.req.param("id"), c.get("user").id);
  if (!thread) return c.json({ message: "Session not found" }, 404);
  const run = await prisma.run.findFirst({
    where: { threadId: thread.id, status: "running", desktopPassword: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (!run) return c.json({ message: "No turn with a desktop is running right now." }, 404);
  const { token } = await signRelayToken("desktop", `run-${run.id}`, 3600);
  return c.json({ url: `/relay/desktop?t=${encodeURIComponent(token)}`, password: run.desktopPassword, runId: run.id });
});

function previewView(p: { id: string; status: string; command: string; port: number; desktop: boolean; error: string | null; log: string; expiresAt: Date | null; createdAt: Date }) {
  const { id, status, command, port, desktop, error, log, expiresAt, createdAt } = p;
  return { id, status, command, port, desktop, error, log, expiresAt, createdAt };
}

live.get("/threads/:id/previews", async (c) => {
  const thread = await ownedThread(c.req.param("id"), c.get("user").id);
  if (!thread) return c.json({ message: "Session not found" }, 404);
  const latest = await prisma.preview.findFirst({ where: { threadId: thread.id }, orderBy: { createdAt: "desc" } });
  // Suggest what was used last time for this repo.
  const lastForRepo = latest ?? (await prisma.preview.findFirst({ where: { thread: { repo: thread.repo } }, orderBy: { createdAt: "desc" } }));
  return c.json({
    preview: latest ? previewView(latest) : null,
    defaults: { command: lastForRepo?.command ?? "npm install && npm run dev", port: lastForRepo?.port ?? 3000 },
    available: Boolean(previewOrigin()),
    desktop: (await capabilities()).desktop,
  });
});

const PreviewSchema = z.object({
  command: z.string().trim().min(1).max(2000),
  port: z.number().int().min(1).max(65535).refine((p) => p !== 39000 && p !== 5900, "That port is used by Cloudly inside the sandbox."),
  desktop: z.boolean().default(false),
});

live.post("/threads/:id/previews", zValidator("json", PreviewSchema), async (c) => {
  const user = c.get("user");
  const thread = await ownedThread(c.req.param("id"), user.id);
  if (!thread) return c.json({ message: "Session not found" }, 404);
  const body = c.req.valid("json");
  if (!previewOrigin() && !body.desktop) {
    return c.json({ message: "Previews in your browser need PREVIEW_ORIGIN in the server's configuration. You can still watch one on the sandbox's desktop." }, 400);
  }
  if (await prisma.preview.count({ where: { threadId: thread.id, status: { in: ACTIVE } } })) {
    return c.json({ message: "This session's preview is already running. Stop it to start another." }, 409);
  }
  if ((await prisma.preview.count({ where: { status: { in: ACTIVE } } })) >= PREVIEW_MAX) {
    return c.json({ message: `Only ${PREVIEW_MAX} preview can run at a time on this server (PREVIEW_MAX). Stop the other one first.` }, 409);
  }
  const preview = await prisma.preview.create({ data: { threadId: thread.id, userId: user.id, ...body } });
  return c.json({ preview: previewView(preview) }, 201);
});

async function ownedPreview(id: string, userId: string) {
  return prisma.preview.findFirst({ where: { id, userId } });
}

live.post("/previews/:id/stop", async (c) => {
  const p = await ownedPreview(c.req.param("id"), c.get("user").id);
  if (!p) return c.json({ message: "Preview not found" }, 404);
  // Not started yet: nothing for the worker to clean up.
  await prisma.preview.updateMany({ where: { id: p.id, status: "requested" }, data: { status: "stopped" } });
  await prisma.preview.updateMany({ where: { id: p.id, status: { in: ["starting", "running"] } }, data: { status: "stopping" } });
  return c.json({ ok: true });
});

live.get("/previews/:id/link", async (c) => {
  const p = await ownedPreview(c.req.param("id"), c.get("user").id);
  if (!p || p.status !== "running") return c.json({ message: "The preview isn't running." }, 409);
  const origin = previewOrigin();
  if (!origin) return c.json({ message: "Set PREVIEW_ORIGIN in the server's configuration to open previews in your browser." }, 400);
  const ttl = Math.max(60, Math.floor(((p.expiresAt?.getTime() ?? Date.now() + 3600_000) - Date.now()) / 1000));
  const { token } = await signRelayToken("preview", `preview-${p.id}`, ttl);
  return c.json({ url: `${origin}/__cloudly/enter?t=${encodeURIComponent(token)}` });
});

live.get("/previews/:id/desktop", async (c) => {
  const p = await ownedPreview(c.req.param("id"), c.get("user").id);
  if (!p || p.status !== "running" || !p.vncPassword) return c.json({ message: "This preview has no desktop running." }, 409);
  const { token } = await signRelayToken("desktop", `preview-${p.id}`, 3600);
  return c.json({ url: `/relay/desktop?t=${encodeURIComponent(token)}`, password: p.vncPassword });
});
