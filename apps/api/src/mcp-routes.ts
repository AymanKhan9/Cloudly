import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import {
  prisma, MCP_NAME, readMcpSecret, sealMcpSecret, canonicalResource, discoverMcpAuth, registerMcpClient,
  pkcePair, authorizationUrl, exchangeMcpCode, type McpOAuthSecret,
} from "@repo/db";
import type { AuthEnv } from "./middleware/auth_middleware";

// MCP servers for the agents, with sign-in done here: Cloudly's own public URL
// is the OAuth callback, so nothing needs to listen on localhost, and the tokens
// stay on this server (the gateway adds them; sandboxes never see one).

const STATE_COOKIE = "mcp_oauth";

function apiOrigin(): string {
  return (process.env.API_ORIGIN ?? `${(process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "")}/api`).replace(/\/$/, "");
}
function settingsUrl(params: Record<string, string>): string {
  const web = (process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
  return `${web}/app/settings?${new URLSearchParams(params)}#mcp`;
}
export const mcpRedirectUri = () => `${apiOrigin()}/settings/mcp/oauth/callback`;

const CreateSchema = z.object({
  name: z.string().trim().regex(MCP_NAME, "Use lowercase letters, digits and dashes, starting with a letter."),
  url: z.url({ protocol: /^https?$/ }).max(2000),
  auth: z.enum(["oauth", "bearer", "none"]),
  token: z.string().trim().max(8000).optional(),
  clientId: z.string().trim().max(500).optional(),
  clientSecret: z.string().trim().max(2000).optional(),
});

export const mcp = new Hono<AuthEnv>();

mcp.get("/", async (c) => {
  const rows = await prisma.mcpServer.findMany({ orderBy: { name: "asc" } });
  const servers = await Promise.all(
    rows.map(async ({ secret, ...row }) => {
      const s = await readMcpSecret(secret);
      return { ...row, expiresAt: s?.kind === "oauth" && s.expiresAt ? new Date(s.expiresAt).toISOString() : null };
    }),
  );
  return c.json({ servers, redirectUri: mcpRedirectUri() });
});

mcp.post("/", zValidator("json", CreateSchema), async (c) => {
  const body = c.req.valid("json");
  // Cloudly's own in-sandbox servers.
  if (["context", "desktop"].includes(body.name)) return c.json({ message: `"${body.name}" is the name of one of Cloudly's own tools. Pick another.` }, 400);
  if (await prisma.mcpServer.findUnique({ where: { name: body.name } })) {
    return c.json({ message: `There's already a server called ${body.name}.` }, 409);
  }
  if (body.auth === "bearer" && !body.token) return c.json({ message: "Paste the token." }, 400);
  const secret =
    body.auth === "bearer"
      ? await sealMcpSecret({ kind: "bearer", token: body.token! })
      : body.auth === "oauth"
        ? await sealMcpSecret({ kind: "oauth", clientId: body.clientId || undefined, clientSecret: body.clientSecret || undefined, tokenAuth: body.clientSecret ? "client_secret_post" : undefined })
        : null;
  const row = await prisma.mcpServer.create({
    data: { name: body.name, url: body.url, auth: body.auth, secret, status: body.auth === "oauth" ? "needs_auth" : "connected" },
  });
  return c.json({ id: row.id }, 201);
});

mcp.patch("/:id", zValidator("json", z.object({ enabled: z.boolean() })), async (c) => {
  const updated = await prisma.mcpServer.updateMany({ where: { id: c.req.param("id") }, data: { enabled: c.req.valid("json").enabled } });
  if (updated.count === 0) return c.json({ message: "Server not found" }, 404);
  return c.json({ ok: true });
});

mcp.delete("/:id", async (c) => {
  await prisma.mcpServer.deleteMany({ where: { id: c.req.param("id") } });
  return c.json({ ok: true });
});

// A top-level navigation from Settings: find where to sign in, register Cloudly
// as a client if needed, and send the browser there.
mcp.get("/:id/connect", async (c) => {
  const row = await prisma.mcpServer.findUnique({ where: { id: c.req.param("id") } });
  if (!row || row.auth !== "oauth") return c.redirect(settingsUrl({ mcp_error: "That server doesn't sign in with OAuth." }));
  try {
    const found = await discoverMcpAuth(row.url);
    if (!found.authRequired) {
      // Answered without a token: nothing to sign in to.
      await prisma.mcpServer.update({ where: { id: row.id }, data: { auth: "none", status: "connected", error: null, secret: null } });
      return c.redirect(settingsUrl({ mcp: row.name }));
    }
    const existing = await readMcpSecret(row.secret);
    let secret: McpOAuthSecret = {
      ...(existing?.kind === "oauth" ? existing : { kind: "oauth" }),
      authorizationEndpoint: found.authorizationEndpoint,
      tokenEndpoint: found.tokenEndpoint,
      scope: found.scope,
    };
    const redirectUri = mcpRedirectUri();
    // A client registered for a different callback (the instance moved) is registered again.
    const pasted = Boolean(secret.clientId) && !secret.redirectUri;
    if (!secret.clientId || (!pasted && secret.redirectUri !== redirectUri)) {
      if (!found.registrationEndpoint) {
        throw new Error("This server doesn't let apps register themselves. Remove it and add it again with a client ID from its developer settings.");
      }
      secret = { ...secret, ...(await registerMcpClient(found.registrationEndpoint, redirectUri, found.tokenAuthMethods)) };
    }
    secret.redirectUri = redirectUri;
    await prisma.mcpServer.update({ where: { id: row.id }, data: { secret: await sealMcpSecret(secret), error: null } });

    const state = randomBytes(16).toString("base64url");
    const { verifier, challenge } = pkcePair();
    setCookie(c, STATE_COOKIE, `${state}.${row.id}.${verifier}`, {
      httpOnly: true, sameSite: "Lax", maxAge: 600, path: "/",
      secure: process.env.WEB_ORIGIN?.startsWith("https://") ?? false,
    });
    return c.redirect(authorizationUrl(secret, found.resource, state, challenge));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.mcpServer.update({ where: { id: row.id }, data: { status: "error", error: message } });
    return c.redirect(settingsUrl({ mcp_error: message }));
  }
});

mcp.get("/oauth/callback", async (c) => {
  const [state, id, verifier] = (getCookie(c, STATE_COOKIE) ?? "").split(".");
  deleteCookie(c, STATE_COOKIE, { path: "/" });
  const error = c.req.query("error_description") ?? c.req.query("error");
  if (error) return c.redirect(settingsUrl({ mcp_error: `The server declined: ${error}` }));
  if (!state || !id || !verifier || c.req.query("state") !== state || !c.req.query("code")) {
    return c.redirect(settingsUrl({ mcp_error: "That sign-in expired or came from somewhere else. Try Connect again." }));
  }
  const row = await prisma.mcpServer.findUnique({ where: { id } });
  const secret = await readMcpSecret(row?.secret);
  if (!row || secret?.kind !== "oauth") return c.redirect(settingsUrl({ mcp_error: "That server was removed." }));
  try {
    const signedIn = await exchangeMcpCode(secret, canonicalResource(row.url), c.req.query("code")!, verifier);
    await prisma.mcpServer.update({ where: { id }, data: { secret: await sealMcpSecret(signedIn), status: "connected", error: null } });
    return c.redirect(settingsUrl({ mcp: row.name }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.mcpServer.update({ where: { id }, data: { status: "error", error: message } });
    return c.redirect(settingsUrl({ mcp_error: message }));
  }
});
