import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { prisma } from "@repo/db";
import { hashToken, SESSION_COOKIE_NAME } from "../session";

export interface SessionUser {
  id: string;
  login: string;
  avatarUrl: string | null;
}

export type AuthEnv = { Variables: { user: SessionUser } };

export async function userFromSessionCookie(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { id: await hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;
  const { id, login, avatarUrl } = session.user;
  return { id, login, avatarUrl };
}

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const user = await userFromSessionCookie(getCookie(c, SESSION_COOKIE_NAME));
  if (!user) {
    return c.json({ message: "Sign in required" }, 401);
  }
  c.set("user", user);
  await next();
});
