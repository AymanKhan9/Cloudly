import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { prisma, accessTokenOwner } from "@repo/db";
import { userFromSessionCookie, type AuthEnv } from "./auth_middleware";
import { SESSION_COOKIE_NAME } from "../session";

/**
 * Signed in (the web app), or a personal token from Settings (the import
 * command on the user's machine, as a bearer token).
 */
export const tokenOrSession = createMiddleware<AuthEnv>(async (c, next) => {
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  if (bearer) {
    const owner = await accessTokenOwner(bearer);
    const user = owner ? await prisma.user.findUnique({ where: { id: owner.userId } }) : null;
    if (!user) return c.json({ message: "That token isn't valid. Create one in Cloudly under Settings > Shared context, or on the Import page." }, 401);
    c.set("user", { id: user.id, login: user.login, avatarUrl: user.avatarUrl });
    return next();
  }
  const user = await userFromSessionCookie(getCookie(c, SESSION_COOKIE_NAME));
  if (!user) return c.json({ message: "Sign in required" }, 401);
  c.set("user", user);
  await next();
});
