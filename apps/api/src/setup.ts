import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { config, setSetting } from "@repo/db";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const STATE_COOKIE = "setup_state";

function origins() {
  const web = (process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
  const api = (process.env.API_ORIGIN ?? `${web}/api`).replace(/\/$/, "");
  return { web, api };
}

/** Everything the manifest asks GitHub for. Exported so tests can pin it. */
export function buildManifest(suffix: string) {
  const { web, api } = origins();
  return {
    name: `Cloudly ${suffix}`,
    url: web,
    redirect_url: `${api}/setup/github/callback`,
    callback_urls: [`${api}/auth/github/callback`],
    setup_url: `${api}/setup/github/installed`,
    public: false,
    request_oauth_on_install: false,
    default_events: [] as string[],
    default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
  };
}

export async function setupStatus() {
  const [appId, clientId, clientSecret, privateKey, installationId, logins] = await Promise.all([
    config("GITHUB_APP_ID"),
    config("GITHUB_CLIENT_ID"),
    config("GITHUB_CLIENT_SECRET"),
    config("GITHUB_APP_PRIVATE_KEY"),
    config("GITHUB_APP_INSTALLATION_ID"),
    config("ALLOWED_GITHUB_LOGINS"),
  ]);
  const pemFile = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const hasKey = Boolean(privateKey) || Boolean(pemFile && (await Bun.file(pemFile).exists()));

  const steps = {
    access: Boolean(logins?.trim()),
    githubApp: Boolean(appId && clientId && clientSecret && hasKey),
    installed: Boolean(installationId),
  };
  return {
    needsSetup: !(steps.access && steps.githubApp && steps.installed),
    steps,
    appSlug: await config("GITHUB_APP_SLUG"),
    models: {
      claude: Boolean(await config("ANTHROPIC_API_KEY")),
      codex: Boolean(await config("OPENAI_API_KEY")),
      gemini: Boolean(await config("GEMINI_API_KEY")),
    },
    tokenConfigured: Boolean(process.env.CLOUDLY_SETUP_TOKEN),
  };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Setup runs before anyone can sign in, so something has to stop a stranger who
 * reaches a fresh instance from claiming it: the installer writes a one-time
 * token to .env and prints it for the owner. Once setup is complete these
 * routes close for good; changes after that go through Settings.
 */
const requireSetupToken = createMiddleware(async (c, next) => {
  const expected = process.env.CLOUDLY_SETUP_TOKEN;
  if (!expected) {
    return c.json({ message: "Set CLOUDLY_SETUP_TOKEN in the server's .env, restart the API, and try again." }, 503);
  }
  const given = c.req.header("x-setup-token") ?? "";
  if (!timingSafeEqual(digest(given), digest(expected))) {
    return c.json({ message: "That setup token is wrong." }, 401);
  }
  if (!(await setupStatus()).needsSetup) {
    return c.json({ message: "Setup is finished. Change things in Settings." }, 409);
  }
  await next();
});

export const setup = new Hono();

setup.get("/status", async (c) => c.json(await setupStatus()));

setup.post("/access", requireSetupToken, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { logins?: unknown };
  const logins = String(body.logins ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (logins.length === 0 || logins.some((l) => !LOGIN.test(l))) {
    return c.json({ message: "Enter one or more GitHub usernames, separated by commas." }, 400);
  }
  await setSetting("ALLOWED_GITHUB_LOGINS", logins.join(","));
  return c.json({ ok: true, logins });
});

setup.post("/github/start", requireSetupToken, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { org?: unknown };
  const org = typeof body.org === "string" && body.org.trim() ? body.org.trim() : null;
  if (org && !LOGIN.test(org)) return c.json({ message: "That isn't a valid GitHub organization name." }, 400);

  const state = randomBytes(24).toString("base64url");
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, sameSite: "Lax", maxAge: 900, path: "/" });

  const base = org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new";
  return c.json({
    action: `${base}?state=${state}`,
    manifest: buildManifest(randomBytes(3).toString("hex")),
  });
});

setup.get("/github/callback", async (c) => {
  const { web } = origins();
  const fail = (reason: string) => c.redirect(`${web}/setup?error=${reason}`);

  const code = c.req.query("code");
  const state = c.req.query("state");
  const expected = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/" });
  if (!code || !state || !expected || state !== expected) return fail("state");
  if (!(await setupStatus()).needsSetup) return fail("done");

  const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "cloudly-setup" },
  });
  if (!res.ok) {
    console.error("manifest conversion failed:", res.status, await res.text());
    return fail("github");
  }
  const app = (await res.json()) as Record<string, unknown>;
  const { id, slug, client_id, client_secret, pem } = app;
  if (typeof id !== "number" || typeof slug !== "string" || typeof client_id !== "string" || typeof client_secret !== "string" || typeof pem !== "string") {
    console.error("manifest conversion response was missing fields:", Object.keys(app));
    return fail("github");
  }

  await setSetting("GITHUB_APP_ID", String(id));
  await setSetting("GITHUB_APP_SLUG", slug);
  await setSetting("GITHUB_CLIENT_ID", client_id);
  await setSetting("GITHUB_CLIENT_SECRET", client_secret);
  await setSetting("GITHUB_APP_PRIVATE_KEY", pem);

  // Next: GitHub's own screen to pick which repositories the app may touch.
  return c.redirect(`https://github.com/apps/${slug}/installations/new`);
});

setup.get("/github/installed", async (c) => {
  const { web } = origins();
  const fail = (reason: string) => c.redirect(`${web}/setup?error=${reason}`);

  const installationId = c.req.query("installation_id") ?? "";
  if (!/^\d{1,15}$/.test(installationId)) return fail("installation");

  const appId = await config("GITHUB_APP_ID");
  const privateKey = await config("GITHUB_APP_PRIVATE_KEY");
  if (!appId || !privateKey) return fail("installation");

  // Only an installation of *this* app counts; GitHub confirms that for us.
  const { token } = await createAppAuth({ appId, privateKey })({ type: "app" });
  const check = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "cloudly-setup" },
  });
  if (!check.ok) return fail("installation");

  await setSetting("GITHUB_APP_INSTALLATION_ID", installationId);
  return c.redirect(`${web}/setup?step=installed`);
});
