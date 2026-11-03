import { Hono } from "hono";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma, config, setSetting } from "@repo/db";
import type { AuthEnv } from "./middleware/auth_middleware";

// GitHub's webhooks. The API only checks the signature and stores the delivery;
// the worker decides what it means and does the GitHub calls (webhooks.ts there).
// That keeps this endpoint fast, which GitHub wants (10 seconds at most), and
// keeps the API and the worker talking only through Postgres.

/** The events the worker acts on. Anything else is acknowledged and dropped. */
export const HANDLED_EVENTS = ["issues", "issue_comment", "pull_request_review", "check_suite", "pull_request"] as const;
const MAX_BODY = 5 * 1024 * 1024;

export function webhookUrl(): string {
  const web = (process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
  const api = (process.env.API_ORIGIN ?? `${web}/api`).replace(/\/$/, "");
  return `${api}/webhooks/github`;
}

export function signatureValid(secret: string, body: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const webhooks = new Hono();

webhooks.post("/github", async (c) => {
  const secret = await config("GITHUB_WEBHOOK_SECRET");
  if (!secret) return c.json({ message: "Webhooks aren't set up on this Cloudly. Set them up under Settings > GitHub triggers." }, 503);
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > MAX_BODY) return c.json({ message: "Too large" }, 413);
  const body = await c.req.text();
  if (body.length > MAX_BODY) return c.json({ message: "Too large" }, 413);
  if (!signatureValid(secret, body, c.req.header("x-hub-signature-256"))) return c.json({ message: "Bad signature" }, 401);

  const event = c.req.header("x-github-event") ?? "";
  const id = c.req.header("x-github-delivery") ?? "";
  if (event === "ping") return c.json({ ok: true, pong: true });
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return c.json({ message: "Missing delivery id" }, 400);
  if (!(HANDLED_EVENTS as readonly string[]).includes(event)) return c.json({ ok: true, ignored: event }, 202);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ message: "Not JSON" }, 400);
  }
  const action = typeof payload.action === "string" ? payload.action : null;
  try {
    await prisma.webhookDelivery.create({ data: { id, event, action, payload: payload as never } });
  } catch (err) {
    // A redelivery of one we already have.
    if ((err as { code?: string }).code === "P2002") return c.json({ ok: true, duplicate: true });
    throw err;
  }
  return c.json({ ok: true }, 202);
});

// Settings > GitHub triggers: where to point the GitHub App, and what arrived.
export const webhookSettings = new Hono<AuthEnv>();

webhookSettings.get("/", async (c) => {
  const [secret, slug, deliveries] = await Promise.all([
    config("GITHUB_WEBHOOK_SECRET"),
    config("GITHUB_APP_SLUG"),
    prisma.webhookDelivery.findMany({
      orderBy: { receivedAt: "desc" },
      take: 10,
      select: { id: true, event: true, action: true, status: true, note: true, receivedAt: true },
    }),
  ]);
  return c.json({ url: webhookUrl(), secretSet: Boolean(secret), appSlug: slug, deliveries });
});

// A new secret, shown once: it goes into the GitHub App's webhook settings.
webhookSettings.post("/secret", async (c) => {
  const secret = randomBytes(24).toString("base64url");
  await setSetting("GITHUB_WEBHOOK_SECRET", secret);
  return c.json({ secret, url: webhookUrl() });
});
