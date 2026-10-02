export const SESSION_COOKIE_NAME = "session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Only this hash is ever stored (as `Session.id`) — the raw cookie value
 * never touches the database, so a leaked DB can't be replayed as a session.
 */
export async function hashToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(bytes).toString("base64url");
}
