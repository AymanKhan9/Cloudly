import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./client";
import { decrypt, encrypt, masterKey } from "./secrets";

// Remote MCP servers (Notion, Linear, Sentry, your own) the agents may use.
// Cloudly does the OAuth itself, with its own public callback URL instead of a
// localhost one, and keeps the tokens here. Sandboxes get the credential
// gateway's address for each server and never a token: the gateway adds it.

export type McpAuth = "oauth" | "bearer" | "none";

export interface McpOAuthSecret {
  kind: "oauth";
  /** Registered with the server's authorization server, or pasted by the user. */
  clientId?: string;
  clientSecret?: string;
  /** How the client authenticates at the token endpoint. */
  tokenAuth?: "none" | "client_secret_basic" | "client_secret_post";
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  /** The redirect URI the client was registered with. */
  redirectUri?: string;
  scope?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

export interface McpBearerSecret {
  kind: "bearer";
  token: string;
}

export type McpSecret = McpOAuthSecret | McpBearerSecret;

/** What agents call a server: it becomes a tool prefix, so keep it plain. */
export const MCP_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export async function readMcpSecret(blob: string | null | undefined): Promise<McpSecret | null> {
  if (!blob) return null;
  try {
    return JSON.parse(decrypt(blob, await masterKey())) as McpSecret;
  } catch {
    return null;
  }
}

export async function sealMcpSecret(secret: McpSecret): Promise<string> {
  return encrypt(JSON.stringify(secret), await masterKey());
}

/**
 * The URL that identifies the server as an OAuth resource (RFC 8707): scheme
 * and host lowercased, no fragment, no trailing slash on a bare path.
 */
export function canonicalResource(url: string): string {
  const u = new URL(url);
  u.hash = "";
  const text = `${u.protocol}//${u.host.toLowerCase()}${u.pathname}${u.search}`;
  return text.endsWith("/") && u.pathname === "/" ? text.slice(0, -1) : text;
}

/** The parameters of a WWW-Authenticate challenge, e.g. resource_metadata and scope. */
export function parseWwwAuthenticate(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const m of header.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) out[m[1]!.toLowerCase()] = m[2]!;
  for (const m of header.matchAll(/([a-zA-Z_]+)=([^",\s]+)/g)) out[m[1]!.toLowerCase()] ??= m[2]!;
  return out;
}

/** Where RFC 8414/9728 metadata may live for a URL: path-inserted first, then the root. */
export function wellKnownUrls(url: string, suffix: string): string[] {
  const u = new URL(url);
  const path = u.pathname.replace(/\/$/, "");
  const urls = [`${u.origin}/.well-known/${suffix}${path}`];
  if (path) urls.push(`${u.origin}/.well-known/${suffix}`);
  return urls;
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

async function getJson(fetchImpl: Fetch, url: string): Promise<any | null> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json", "mcp-protocol-version": "2025-06-18" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface McpAuthDiscovery {
  /** False when the server answered without asking for a token. */
  authRequired: boolean;
  resource: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  scope?: string;
  /** What the authorization server says it accepts at the token endpoint. */
  tokenAuthMethods?: string[];
}

/**
 * Finds where to sign in for an MCP server, per the MCP authorization spec: ask
 * the server, follow its 401 to its protected-resource metadata (RFC 9728), and
 * from there to its authorization server's metadata (RFC 8414 or OpenID).
 * Servers from before RFC 9728 support are treated as their own authorization
 * server.
 */
export async function discoverMcpAuth(serverUrl: string, fetchImpl: Fetch = fetch): Promise<McpAuthDiscovery> {
  const resource = canonicalResource(serverUrl);
  const probe = await fetchImpl(serverUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Cloudly", version: "1" } },
    }),
  });
  await probe.body?.cancel().catch(() => {});
  if (probe.status !== 401 && probe.status !== 403) return { authRequired: false, resource };

  const challenge = parseWwwAuthenticate(probe.headers.get("www-authenticate"));
  let prm: any = null;
  if (challenge.resource_metadata) prm = await getJson(fetchImpl, challenge.resource_metadata);
  for (const url of prm ? [] : wellKnownUrls(serverUrl, "oauth-protected-resource")) {
    prm = await getJson(fetchImpl, url);
    if (prm) break;
  }

  const issuer: string = prm?.authorization_servers?.[0] ?? new URL(serverUrl).origin;
  let meta: any = null;
  const candidates = [
    ...wellKnownUrls(issuer, "oauth-authorization-server"),
    ...wellKnownUrls(issuer, "openid-configuration"),
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
  ];
  for (const url of [...new Set(candidates)]) {
    meta = await getJson(fetchImpl, url);
    if (meta?.authorization_endpoint) break;
  }

  // Pre-RFC 9728 servers without metadata: the spec's fixed default paths.
  const origin = new URL(issuer).origin;
  const scopes: string[] | undefined = challenge.scope ? challenge.scope.split(" ") : prm?.scopes_supported;
  return {
    authRequired: true,
    resource: prm?.resource ? canonicalResource(prm.resource) : resource,
    authorizationEndpoint: meta?.authorization_endpoint ?? `${origin}/authorize`,
    tokenEndpoint: meta?.token_endpoint ?? `${origin}/token`,
    registrationEndpoint: meta?.registration_endpoint ?? (meta ? undefined : `${origin}/register`),
    scope: scopes?.length ? scopes.join(" ") : undefined,
    tokenAuthMethods: meta?.token_endpoint_auth_methods_supported,
  };
}

/** Dynamic client registration (RFC 7591), as a public client when the server allows it. */
export async function registerMcpClient(
  registrationEndpoint: string,
  redirectUri: string,
  tokenAuthMethods: string[] | undefined,
  fetchImpl: Fetch = fetch,
): Promise<Pick<McpOAuthSecret, "clientId" | "clientSecret" | "tokenAuth">> {
  const publicClient = !tokenAuthMethods || tokenAuthMethods.includes("none");
  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Cloudly",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: publicClient ? "none" : "client_secret_post",
    }),
  });
  if (!res.ok) throw new Error(`The server refused to register Cloudly as a client (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as Record<string, string>;
  if (!body.client_id) throw new Error("The server registered Cloudly but sent no client_id.");
  const method = body.token_endpoint_auth_method ?? (body.client_secret ? "client_secret_post" : "none");
  return {
    clientId: body.client_id,
    clientSecret: body.client_secret,
    tokenAuth: method === "client_secret_basic" || method === "client_secret_post" ? method : "none",
  };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizationUrl(secret: McpOAuthSecret, resource: string, state: string, challenge: string): string {
  if (!secret.authorizationEndpoint || !secret.clientId || !secret.redirectUri) throw new Error("This server isn't ready for sign-in.");
  const url = new URL(secret.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", secret.clientId);
  url.searchParams.set("redirect_uri", secret.redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", resource);
  if (secret.scope) url.searchParams.set("scope", secret.scope);
  return url.toString();
}

async function tokenRequest(secret: McpOAuthSecret, params: Record<string, string>, fetchImpl: Fetch): Promise<McpOAuthSecret> {
  if (!secret.tokenEndpoint || !secret.clientId) throw new Error("This server isn't ready for sign-in.");
  const body = new URLSearchParams({ ...params, client_id: secret.clientId });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (secret.clientSecret && secret.tokenAuth === "client_secret_basic") {
    const pair = `${encodeURIComponent(secret.clientId)}:${encodeURIComponent(secret.clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
  } else if (secret.clientSecret) {
    body.set("client_secret", secret.clientSecret);
  }
  const res = await fetchImpl(secret.tokenEndpoint, { method: "POST", headers, body });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // Some older servers answer form-encoded.
    json = Object.fromEntries(new URLSearchParams(text));
  }
  if (!res.ok || !json.access_token) {
    throw new Error(`Sign-in failed (${res.status}): ${json.error_description ?? json.error ?? text.slice(0, 200)}`);
  }
  return {
    ...secret,
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? secret.refreshToken,
    expiresAt: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : undefined,
  };
}

export function exchangeMcpCode(secret: McpOAuthSecret, resource: string, code: string, verifier: string, fetchImpl: Fetch = fetch) {
  return tokenRequest(secret, {
    grant_type: "authorization_code",
    code,
    redirect_uri: secret.redirectUri!,
    code_verifier: verifier,
    resource,
  }, fetchImpl);
}

export function refreshMcpToken(secret: McpOAuthSecret, resource: string, fetchImpl: Fetch = fetch) {
  if (!secret.refreshToken) throw new Error("No refresh token: sign in again.");
  return tokenRequest(secret, { grant_type: "refresh_token", refresh_token: secret.refreshToken, resource }, fetchImpl);
}

/** Refresh this far ahead of expiry, so a turn never starts on a token about to lapse. */
export const MCP_REFRESH_MARGIN_MS = 10 * 60_000;

/**
 * Refreshes every OAuth connection whose token is close to expiring. A refresh
 * the server refuses marks the server as needing a new sign-in.
 */
export async function refreshMcpTokens(fetchImpl: Fetch = fetch, now = Date.now()): Promise<number> {
  let refreshed = 0;
  for (const row of await prisma.mcpServer.findMany({ where: { auth: "oauth", status: "connected" } })) {
    const secret = await readMcpSecret(row.secret);
    if (secret?.kind !== "oauth" || !secret.expiresAt || secret.expiresAt > now + MCP_REFRESH_MARGIN_MS) continue;
    try {
      const fresh = await refreshMcpToken(secret, canonicalResource(row.url), fetchImpl);
      await prisma.mcpServer.update({ where: { id: row.id }, data: { secret: await sealMcpSecret(fresh), error: null } });
      refreshed++;
    } catch (err) {
      await prisma.mcpServer.update({
        where: { id: row.id },
        data: { status: "needs_auth", error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return refreshed;
}

export interface GatewayMcpServer {
  url: string;
  /** The Authorization header the gateway adds; none for open servers. */
  authorization?: string;
}

/** Connected, enabled servers with what the gateway needs to call each one. */
export async function gatewayMcpServers(): Promise<Record<string, GatewayMcpServer>> {
  const out: Record<string, GatewayMcpServer> = {};
  for (const row of await prisma.mcpServer.findMany({ where: { enabled: true, status: "connected" } })) {
    const secret = await readMcpSecret(row.secret);
    const token = secret?.kind === "oauth" ? secret.accessToken : secret?.kind === "bearer" ? secret.token : undefined;
    if (row.auth !== "none" && !token) continue;
    out[row.name] = { url: row.url, ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }
  return out;
}
