import { test, expect } from "bun:test";
import {
  prisma, canonicalResource, parseWwwAuthenticate, wellKnownUrls, discoverMcpAuth, registerMcpClient, authorizationUrl,
  exchangeMcpCode, refreshMcpTokens, sealMcpSecret, readMcpSecret, gatewayMcpServers, pkcePair, type McpOAuthSecret,
} from "../src";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function fakeFetch(routes: Record<string, Handler>, seen: { url: string; init?: RequestInit }[] = []) {
  return async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    const handler = routes[url];
    return handler ? handler(url, init) : new Response("not found", { status: 404 });
  };
}

test("resource URLs are canonical: lowercase host, no fragment, no lone trailing slash", () => {
  expect(canonicalResource("https://MCP.Example.com/mcp#x")).toBe("https://mcp.example.com/mcp");
  expect(canonicalResource("https://mcp.example.com/")).toBe("https://mcp.example.com");
});

test("WWW-Authenticate parameters and well-known locations", () => {
  expect(parseWwwAuthenticate('Bearer resource_metadata="https://x/.well-known/oauth-protected-resource", scope="read write"')).toEqual({
    resource_metadata: "https://x/.well-known/oauth-protected-resource",
    scope: "read write",
  });
  expect(wellKnownUrls("https://a.com/tenant/mcp", "oauth-protected-resource")).toEqual([
    "https://a.com/.well-known/oauth-protected-resource/tenant/mcp",
    "https://a.com/.well-known/oauth-protected-resource",
  ]);
});

test("discovery follows the 401 to the resource metadata and on to the authorization server", async () => {
  const f = fakeFetch({
    "https://mcp.example.com/mcp": () =>
      new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"' } }),
    "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () =>
      Response.json({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"], scopes_supported: ["read"] }),
    "https://auth.example.com/.well-known/oauth-authorization-server": () =>
      Response.json({
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      }),
  });
  expect(await discoverMcpAuth("https://mcp.example.com/mcp", f)).toEqual({
    authRequired: true,
    resource: "https://mcp.example.com/mcp",
    authorizationEndpoint: "https://auth.example.com/authorize",
    tokenEndpoint: "https://auth.example.com/token",
    registrationEndpoint: "https://auth.example.com/register",
    scope: "read",
    tokenAuthMethods: ["none", "client_secret_post"],
  });
});

test("a server that answers without a token needs no sign-in; an old one without metadata uses the default paths", async () => {
  expect((await discoverMcpAuth("https://open.example.com/mcp", fakeFetch({ "https://open.example.com/mcp": () => Response.json({}) }))).authRequired).toBe(false);
  const old = await discoverMcpAuth("https://old.example.com/mcp", fakeFetch({ "https://old.example.com/mcp": () => new Response("", { status: 401 }) }));
  expect(old.authorizationEndpoint).toBe("https://old.example.com/authorize");
  expect(old.registrationEndpoint).toBe("https://old.example.com/register");
});

test("registration asks for a public client with Cloudly's callback, and keeps a secret if one comes back", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const f = fakeFetch({ "https://auth.example.com/register": () => Response.json({ client_id: "abc", client_secret: "shh", token_endpoint_auth_method: "client_secret_basic" }) }, seen);
  const client = await registerMcpClient("https://auth.example.com/register", "https://vm.example.com/api/settings/mcp/oauth/callback", ["none"], f);
  expect(client).toEqual({ clientId: "abc", clientSecret: "shh", tokenAuth: "client_secret_basic" });
  const body = JSON.parse(String(seen[0]!.init!.body));
  expect(body.redirect_uris).toEqual(["https://vm.example.com/api/settings/mcp/oauth/callback"]);
  expect(body.token_endpoint_auth_method).toBe("none");
});

test("the authorization URL carries PKCE, state and the resource; the code exchange sends the verifier", async () => {
  const secret: McpOAuthSecret = {
    kind: "oauth", clientId: "abc", authorizationEndpoint: "https://auth.example.com/authorize", tokenEndpoint: "https://auth.example.com/token",
    redirectUri: "https://vm/cb", scope: "read",
  };
  const { verifier, challenge } = pkcePair();
  const url = new URL(authorizationUrl(secret, "https://mcp.example.com/mcp", "st", challenge));
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    response_type: "code", client_id: "abc", redirect_uri: "https://vm/cb", code_challenge: challenge, code_challenge_method: "S256", state: "st",
    resource: "https://mcp.example.com/mcp", scope: "read",
  });

  const seen: { url: string; init?: RequestInit }[] = [];
  const f = fakeFetch({ "https://auth.example.com/token": () => Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600 }) }, seen);
  const signedIn = await exchangeMcpCode(secret, "https://mcp.example.com/mcp", "the-code", verifier, f);
  expect(signedIn.accessToken).toBe("at");
  expect(signedIn.refreshToken).toBe("rt");
  expect(signedIn.expiresAt).toBeGreaterThan(Date.now());
  const sent = new URLSearchParams(String(seen[0]!.init!.body));
  expect(sent.get("code_verifier")).toBe(verifier);
  expect(sent.get("resource")).toBe("https://mcp.example.com/mcp");
  expect(sent.get("grant_type")).toBe("authorization_code");
});

test("tokens close to expiry are refreshed; a refused refresh asks for a new sign-in; the gateway only gets working ones", async () => {
  await prisma.mcpServer.deleteMany({ where: { name: { in: ["t-fresh", "t-old", "t-dead", "t-bearer", "t-off"] } } });
  const base: McpOAuthSecret = { kind: "oauth", clientId: "c", tokenEndpoint: "https://auth.example.com/token", redirectUri: "https://vm/cb" };
  const mk = async (name: string, auth: string, secret: object | null, extra: object = {}) =>
    prisma.mcpServer.create({
      data: { name, url: `https://${name}.example.com/mcp`, auth, status: "connected", secret: secret ? await sealMcpSecret(secret as McpOAuthSecret) : null, ...extra },
    });
  await mk("t-fresh", "oauth", { ...base, accessToken: "fresh", refreshToken: "r1", expiresAt: Date.now() + 3600_000 });
  const old = await mk("t-old", "oauth", { ...base, accessToken: "old", refreshToken: "r2", expiresAt: Date.now() + 60_000 });
  const dead = await mk("t-dead", "oauth", { ...base, accessToken: "dead", refreshToken: "revoked", expiresAt: Date.now() - 1000 });
  await mk("t-bearer", "bearer", { kind: "bearer", token: "tok" });
  await mk("t-off", "bearer", { kind: "bearer", token: "tok" }, { enabled: false });

  const f = fakeFetch({
    "https://auth.example.com/token": (_u, init) => {
      const p = new URLSearchParams(String(init!.body));
      return p.get("refresh_token") === "r2"
        ? Response.json({ access_token: "renewed", expires_in: 3600 })
        : Response.json({ error: "invalid_grant" }, { status: 400 });
    },
  });
  try {
    expect(await refreshMcpTokens(f)).toBe(1);
    const renewed = await readMcpSecret((await prisma.mcpServer.findUniqueOrThrow({ where: { id: old.id } })).secret);
    expect(renewed?.kind === "oauth" && renewed.accessToken).toBe("renewed");
    // The refresh token wasn't rotated, so the old one is kept.
    expect(renewed?.kind === "oauth" && renewed.refreshToken).toBe("r2");
    const failed = await prisma.mcpServer.findUniqueOrThrow({ where: { id: dead.id } });
    expect(failed.status).toBe("needs_auth");
    expect(failed.error).toContain("invalid_grant");

    const gateway = await gatewayMcpServers();
    expect(gateway["t-fresh"]).toEqual({ url: "https://t-fresh.example.com/mcp", authorization: "Bearer fresh" });
    expect(gateway["t-old"]?.authorization).toBe("Bearer renewed");
    expect(gateway["t-bearer"]?.authorization).toBe("Bearer tok");
    expect(gateway["t-dead"]).toBeUndefined();
    expect(gateway["t-off"]).toBeUndefined();
  } finally {
    await prisma.mcpServer.deleteMany({ where: { name: { in: ["t-fresh", "t-old", "t-dead", "t-bearer", "t-off"] } } });
  }
});
