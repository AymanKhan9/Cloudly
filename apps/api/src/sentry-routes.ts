import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { prisma, config, setSetting, deleteSetting, harnessAvailable } from "@repo/db";
import type { AuthEnv } from "./middleware/auth_middleware";
import { HARNESSES } from "./harnesses";

// Sentry: a new error in production starts a session that reproduces and fixes
// it. Sentry's integration platform posts here, signed with the integration's
// client secret; like GitHub's, the delivery is stored and the worker decides
// what it means (apps/worker/src/sentry.ts).

const MAX_BODY = 2 * 1024 * 1024;
/** What Sentry sends that the worker acts on: a new issue, or an alert rule firing. */
const HANDLED = ["issue", "event_alert"];

export function sentryWebhookUrl(): string {
  const web = (process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
  const api = (process.env.API_ORIGIN ?? `${web}/api`).replace(/\/$/, "");
  return `${api}/webhooks/sentry`;
}

/** Sentry-Hook-Signature: the hex HMAC-SHA256 of the body with the client secret. */
export function sentrySignatureValid(secret: string, body: string, header: string | undefined): boolean {
  if (!header || !/^[0-9a-f]{64}$/i.test(header)) return false;
  const given = Buffer.from(header.toLowerCase());
  const matches = (text: string) => {
    const expected = Buffer.from(createHmac("sha256", secret).update(text, "utf8").digest("hex"));
    return expected.length === given.length && timingSafeEqual(expected, given);
  };
  if (matches(body)) return true;
  // Sentry's own examples sign JSON.stringify of the parsed body.
  try {
    return matches(JSON.stringify(JSON.parse(body)));
  } catch {
    return false;
  }
}

export const sentryHook = new Hono();

sentryHook.post("/sentry", async (c) => {
  const secret = await config("SENTRY_CLIENT_SECRET");
  if (!secret) return c.json({ message: "Sentry isn't connected to this Cloudly. Set it up under Settings > Sentry." }, 503);
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return c.json({ message: "Too large" }, 413);
  const body = await c.req.text();
  if (body.length > MAX_BODY) return c.json({ message: "Too large" }, 413);
  if (!sentrySignatureValid(secret, body, c.req.header("sentry-hook-signature"))) return c.json({ message: "Bad signature" }, 401);
  const resource = c.req.header("sentry-hook-resource") ?? "";
  if (!HANDLED.includes(resource)) return c.json({ ok: true, ignored: resource }, 202);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ message: "Not JSON" }, 400);
  }
  const requestId = c.req.header("request-id");
  const id = `sentry-${requestId && /^[\w-]{8,64}$/.test(requestId) ? requestId : createHash("sha256").update(body).digest("hex").slice(0, 40)}`;
  try {
    await prisma.webhookDelivery.create({
      data: { id, event: `sentry.${resource}`, action: typeof payload.action === "string" ? payload.action : null, payload: payload as never },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return c.json({ ok: true, duplicate: true });
    throw err;
  }
  return c.json({ ok: true }, 202);
});

// ---------- Settings > Sentry ----------

export const sentrySettings = new Hono<AuthEnv>();
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

sentrySettings.get("/", async (c) => {
  const [secret, token, url, projects, deliveries] = await Promise.all([
    config("SENTRY_CLIENT_SECRET"),
    config("SENTRY_AUTH_TOKEN"),
    config("SENTRY_URL"),
    prisma.sentryProject.findMany({ orderBy: { slug: "asc" } }),
    prisma.webhookDelivery.findMany({
      where: { event: { startsWith: "sentry." } },
      orderBy: { receivedAt: "desc" },
      take: 10,
      select: { id: true, event: true, action: true, status: true, note: true, receivedAt: true },
    }),
  ]);
  return c.json({ webhookUrl: sentryWebhookUrl(), secretSet: Boolean(secret), tokenSet: Boolean(token), sentryUrl: url ?? "https://sentry.io", projects, deliveries });
});

sentrySettings.put(
  "/",
  zValidator("json", z.object({
    clientSecret: z.string().trim().min(16).max(200).nullable().optional(),
    authToken: z.string().trim().min(16).max(400).nullable().optional(),
    sentryUrl: z.url().max(200).nullable().optional(),
  })),
  async (c) => {
    const body = c.req.valid("json");
    const apply = async (name: string, v: string | null | undefined) => {
      if (v === undefined) return;
      if (v === null) await deleteSetting(name);
      else await setSetting(name, v);
    };
    await apply("SENTRY_CLIENT_SECRET", body.clientSecret);
    await apply("SENTRY_AUTH_TOKEN", body.authToken);
    await apply("SENTRY_URL", body.sentryUrl === undefined ? undefined : body.sentryUrl ? new URL(body.sentryUrl).origin : null);
    return c.json({ ok: true });
  },
);

const ProjectSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/i, "A Sentry project slug, like my-app"),
  repo: z.string().regex(SLUG, "owner/repo"),
  harness: z.string().regex(/^[a-z0-9-]{1,80}$/).nullable().optional(),
  perDay: z.number().int().min(1).max(50).optional(),
  enabled: z.boolean().optional(),
});

sentrySettings.post("/projects", zValidator("json", ProjectSchema), async (c) => {
  const body = c.req.valid("json");
  if (body.harness && !(await harnessAvailable(body.harness, HARNESSES.map((h) => h.id)))) return c.json({ message: "That agent isn't available here." }, 400);
  const userId = c.get("user").id;
  const row = await prisma.sentryProject.upsert({
    where: { slug: body.slug.toLowerCase() },
    update: { repo: body.repo, harness: body.harness ?? null, perDay: body.perDay ?? 5, enabled: body.enabled ?? true, userId },
    create: { slug: body.slug.toLowerCase(), repo: body.repo, harness: body.harness ?? null, perDay: body.perDay ?? 5, enabled: body.enabled ?? true, userId },
  });
  return c.json({ project: row }, 201);
});

sentrySettings.patch("/projects/:id", zValidator("json", ProjectSchema.partial()), async (c) => {
  const body = c.req.valid("json");
  const r = await prisma.sentryProject.updateMany({ where: { id: c.req.param("id") }, data: { ...body, ...(body.slug ? { slug: body.slug.toLowerCase() } : {}) } });
  return r.count ? c.json({ ok: true }) : c.json({ message: "Not found" }, 404);
});

sentrySettings.delete("/projects/:id", async (c) => {
  await prisma.sentryProject.deleteMany({ where: { id: c.req.param("id") } });
  return c.json({ ok: true });
});
