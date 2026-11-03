import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { prisma } from "@repo/db";
import type { AuthEnv } from "./middleware/auth_middleware";

// Artifacts (see @repo/shared/artifacts): their content for the session page,
// and share links anyone can open.
//
// An artifact is the agent's file, so it's never served as a page of this
// origin: HTML goes out as plain text (the page puts it in a sandboxed frame),
// and everything else carries a CSP sandbox, so even an SVG opened on its own
// can't run script here.

const SHIELD = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";

function serve(a: { name: string; kind: string; mime: string; content: Uint8Array }, download: boolean) {
  const headers: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=31536000, immutable",
    "content-type": a.kind === "html" || a.kind === "markdown" || a.kind === "mermaid" || a.kind === "csv" || a.kind === "text"
      ? "text/plain; charset=utf-8"
      : a.mime,
    // Chrome's PDF viewer won't run under a sandbox policy; a PDF can't script this origin anyway.
    ...(a.kind === "pdf" ? {} : { "content-security-policy": SHIELD }),
  };
  const file = a.name.split("/").pop()!.replace(/[^\w.-]/g, "_");
  headers["content-disposition"] = `${download ? "attachment" : "inline"}; filename="${file}"`;
  return new Response(Buffer.from(a.content), { headers });
}

export const artifacts = new Hono<AuthEnv>();

async function owned(id: string, userId: string) {
  return prisma.artifact.findFirst({ where: { id, thread: { userId } } });
}

artifacts.get("/:id/content", async (c) => {
  const a = await owned(c.req.param("id"), c.get("user").id);
  if (!a) return c.json({ message: "Not found" }, 404);
  return serve(a, c.req.query("download") === "1");
});

artifacts.post("/:id/share", async (c) => {
  const a = await owned(c.req.param("id"), c.get("user").id);
  if (!a) return c.json({ message: "Not found" }, 404);
  const token = a.shareToken ?? randomBytes(18).toString("base64url");
  if (!a.shareToken) await prisma.artifact.update({ where: { id: a.id }, data: { shareToken: token } });
  return c.json({ token });
});

artifacts.delete("/:id/share", async (c) => {
  const a = await owned(c.req.param("id"), c.get("user").id);
  if (!a) return c.json({ message: "Not found" }, 404);
  await prisma.artifact.update({ where: { id: a.id }, data: { shareToken: null } });
  return c.json({ ok: true });
});

// ---------- Shared links: no sign-in, the token is the key ----------

export const shared = new Hono();
const TOKEN = /^[\w-]{20,40}$/;

shared.get("/:token", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json({ message: "Not found" }, 404);
  const a = await prisma.artifact.findUnique({ where: { shareToken: token }, select: { name: true, kind: true, mime: true, size: true, version: true, createdAt: true } });
  if (!a) return c.json({ message: "This link was turned off, or never existed." }, 404);
  return c.json({ artifact: a });
});

shared.get("/:token/content", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json({ message: "Not found" }, 404);
  const a = await prisma.artifact.findUnique({ where: { shareToken: token } });
  if (!a) return c.json({ message: "Not found" }, 404);
  const res = serve(a, c.req.query("download") === "1");
  // Public, but only as long as the link stays on.
  res.headers.set("cache-control", "public, max-age=300");
  return res;
});
