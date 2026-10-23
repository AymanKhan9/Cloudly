// The only way out of a run container. Runs in its own container on both the
// sandbox's internal network (no route out, no outside DNS) and the normal one.
// HTTPS only: clients send CONNECT host:443 and this pipes the encrypted stream
// through when the host is allowed. It never sees request contents.
import net from "node:net";
import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const ALLOW_FILE = process.env.ALLOW_FILE ?? "/allow/hosts";
const PORT = Number(process.env.PORT ?? 3128);

// Re-read on every connection so Settings changes apply without a restart.
function allowed(host: string): boolean {
  let rules: string[] = [];
  try {
    rules = readFileSync(ALLOW_FILE, "utf8").split("\n").map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith("#"));
  } catch {}
  const h = host.toLowerCase();
  // "example.com" allows it and its subdomains; "*" allows everything.
  return rules.some((r) => r === "*" || h === r || h.endsWith(`.${r}`));
}

export function parseConnect(head: string): { host: string; port: number } | null {
  const m = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]\r\n/i.exec(head);
  if (!m) return null;
  return { host: m[1]!, port: Number(m[2]) };
}

// --- Secrets ------------------------------------------------------------------------
// Runs get a placeholder for each secret. For the hosts a secret may be sent to,
// this proxy doesn't tunnel blindly: it terminates TLS with a certificate from
// Cloudly's CA (which run containers trust), swaps placeholders for real values
// in the request's headers and URL, and makes the request itself. Other hosts
// never see a real value, and the agent never holds one.

const SECRETS_FILE = process.env.SECRETS_FILE ?? "/keys/secrets.json";

export interface ProxySecret {
  placeholder: string;
  value: string;
  hosts: string[];
}

export interface InterceptConfig {
  cert: string;
  key: string;
  secrets: ProxySecret[];
}

function readIntercept(): InterceptConfig | null {
  try {
    const conf = JSON.parse(readFileSync(SECRETS_FILE, "utf8")) as InterceptConfig;
    return conf.cert && conf.key && conf.secrets?.length ? conf : null;
  } catch {
    return null;
  }
}

/** "example.com" covers itself and its subdomains, as on the allowlist. */
export function hostMatches(host: string, rule: string): boolean {
  const h = host.toLowerCase();
  const r = rule.toLowerCase();
  return h === r || h.endsWith(`.${r}`);
}

/**
 * Puts the real values in for every secret allowed to go to `host`: in header
 * values (Basic credentials decoded first) and the URL. Returns how many
 * placeholders it replaced.
 */
export function substituteSecrets(headers: Headers, url: URL, host: string, secrets: ProxySecret[]): number {
  const mine = secrets.filter((s) => s.hosts.some((r) => hostMatches(host, r)));
  if (mine.length === 0) return 0;
  let count = 0;
  const swap = (text: string) => {
    for (const s of mine) {
      if (text.includes(s.placeholder)) {
        count += text.split(s.placeholder).length - 1;
        text = text.split(s.placeholder).join(s.value);
      }
    }
    return text;
  };
  for (const [name, value] of [...headers]) {
    let next = swap(value);
    const basic = /^Basic\s+(.+)$/i.exec(value);
    if (basic) {
      const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
      const swapped = swap(decoded);
      if (swapped !== decoded) next = `Basic ${Buffer.from(swapped).toString("base64")}`;
    }
    if (next !== value) headers.set(name, next);
  }
  const path = swap(url.pathname + url.search);
  if (path !== url.pathname + url.search) {
    const fixed = new URL(path, url.origin);
    url.pathname = fixed.pathname;
    url.search = fixed.search;
  }
  return count;
}

// Which host each intercepted tunnel was opened for, by the proxy's own local
// port on the connection to the TLS server. The request's Host header is the
// agent's to choose; this is what the agent actually asked the proxy for.
const tunnelTargets = new Map<number, string>();
const interceptServers = new Map<string, ReturnType<typeof Bun.serve>>();

export function startInterceptServer(conf: InterceptConfig) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: conf.cert, key: conf.key },
    idleTimeout: 0,
    async fetch(req, server) {
      const target = tunnelTargets.get(server.requestIP(req)?.port ?? -1);
      const url = new URL(req.url);
      if (!target || url.hostname.toLowerCase() !== target.toLowerCase()) {
        return new Response("This connection was opened for a different host.\n", { status: 421 });
      }
      const upstream = new URL(`${url.pathname}${url.search}`, `https://${target}`);
      const headers = new Headers(req.headers);
      for (const h of HOP_BY_HOP) headers.delete(h);
      const swapped = substituteSecrets(headers, upstream, target, readIntercept()?.secrets ?? conf.secrets);
      console.log(`secrets ${req.method} ${target}${upstream.pathname}${swapped ? ` (${swapped} placeholder${swapped > 1 ? "s" : ""} filled)` : ""}`);
      const res = await fetch(upstream, { method: req.method, headers, body: req.body, duplex: "half", decompress: false, redirect: "manual" } as RequestInit);
      const out = new Headers(res.headers);
      for (const h of HOP_BY_HOP) out.delete(h);
      return new Response(res.body, { status: res.status, headers: out });
    },
  });
}

/** The local TLS server for hosts that carry a secret, or null when `host` carries none. */
function interceptPort(host: string): number | null {
  const conf = readIntercept();
  if (!conf || !conf.secrets.some((s) => s.hosts.some((r) => hostMatches(host, r)))) return null;
  // One server per certificate: a new secret host means a new certificate, and
  // tunnels already open keep the server they started on.
  const id = createHash("sha256").update(conf.cert).digest("hex");
  let server = interceptServers.get(id);
  if (!server) interceptServers.set(id, (server = startInterceptServer(conf)));
  return server.port ?? null;
}

// --- Open web, for research councils ----------------------------------------------
// A research council has no repo and no secrets, so its turns may reach any public
// HTTPS site. Each such turn gets a credential for this proxy (the worker writes
// the live ones to a file); without one, the allowlist applies as always, so a
// repo's run can't opt itself out. Private, loopback and link-local addresses
// (the VM's own services, a cloud's metadata endpoint) are never reachable.

const OPEN_TOKENS_FILE = process.env.OPEN_TOKENS_FILE ?? "/keys/open-tokens.json";

function openToken(token: string | null): boolean {
  if (!token) return false;
  try {
    return (JSON.parse(readFileSync(OPEN_TOKENS_FILE, "utf8")) as string[]).includes(token);
  } catch {
    return false;
  }
}

/** The password from a `council:<token>` Proxy-Authorization header, if there is one. */
export function proxyToken(head: string): string | null {
  const m = /^proxy-authorization:\s*basic\s+(\S+)\s*$/im.exec(head);
  if (!m) return null;
  const [user, ...rest] = Buffer.from(m[1]!, "base64").toString("utf8").split(":");
  return user === "council" && rest.length ? rest.join(":") : null;
}

function v4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

export function isPublicAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return !v4Private(ip);
  if (kind !== 6) return false;
  const v = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return !v4Private(mapped[1]!);
  return !(v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || v.startsWith("64:ff9b:"));
}

/** A public address for `host`, or null if it has none or any of its addresses is private. */
export async function publicAddress(host: string, resolve = (h: string) => lookup(h, { all: true })): Promise<string | null> {
  if (net.isIP(host)) return isPublicAddress(host) ? host : null;
  try {
    const addrs = (await resolve(host)).map((a) => a.address);
    return addrs.length && addrs.every(isPublicAddress) ? addrs[0]! : null;
  } catch {
    return null;
  }
}

export function startProxy(
  port = PORT,
  isAllowed = allowed,
  intercept: (host: string) => number | null = interceptPort,
  host?: string,
  isOpen: (token: string | null) => boolean = openToken,
  resolvePublic: (host: string) => Promise<string | null> = publicAddress,
): net.Server {
  const server = net.createServer((client) => {
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 8192) client.destroy();
        return;
      }
      client.off("data", onData);
      const target = parseConnect(head);
      if (!target) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Type: text/plain\r\n\r\nOnly HTTPS (CONNECT) goes through Cloudly's egress proxy.\n");
        return;
      }
      const open = isOpen(proxyToken(head));
      if (target.port !== 443 || !(open || isAllowed(target.host))) {
        console.log(`deny  ${target.host}:${target.port}`);
        client.end(
          `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${target.host} isn't on this Cloudly instance's allowed list. Add it under Settings > Sandbox tools > Network.\n`,
        );
        return;
      }
      // Codex on a ChatGPT sign-in holds only placeholder tokens, and some of its
      // ChatGPT URLs are fixed, so chatgpt.com goes to the gateway's HTTPS port:
      // its certificate covers chatgpt.com, signed by the CA only Codex's sandbox
      // trusts, and it adds the real token. Anything else sees a bad certificate.
      const viaGateway = target.host.toLowerCase() === "chatgpt.com";
      const secretPort = viaGateway ? null : intercept(target.host);
      const mustBePublic = open && !isAllowed(target.host);
      // Open-web connections are logged once their address has been checked.
      if (!mustBePublic || viaGateway || secretPort !== null) {
        console.log(viaGateway ? `allow ${target.host} (via the credential gateway)` : secretPort ? `allow ${target.host} (fills secrets)` : `allow ${target.host}`);
      }
      void connectUpstream(target, end, viaGateway, secretPort, mustBePublic);
    };
    const connectUpstream = async (target: { host: string; port: number }, end: number, viaGateway: boolean, secretPort: number | null, mustBePublic: boolean) => {
      const local = viaGateway || secretPort !== null;
      // Off the allowlist (open web): connect to the address checked here, not
      // the name again, so a second DNS answer can't point it somewhere private.
      let address = target.host;
      if (mustBePublic && !local) {
        const checked = await resolvePublic(target.host);
        if (!checked) {
          console.log(`deny  ${target.host}:443 (not a public address)`);
          client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${target.host} doesn't resolve to a public address.\n`);
          return;
        }
        address = checked;
        console.log(`allow ${target.host} (open web)`);
      }
      const upstream = net.connect(viaGateway ? GATEWAY_PORT + 1 : (secretPort ?? target.port), local ? "127.0.0.1" : address, () => {
        if (secretPort !== null && upstream.localPort) {
          const localPort = upstream.localPort;
          tunnelTargets.set(localPort, target.host);
          upstream.on("close", () => tunnelTargets.delete(localPort));
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = head.slice(end + 4);
        if (rest) upstream.write(Buffer.from(rest, "latin1"));
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
      client.on("error", () => upstream.destroy());
    };
    client.on("data", onData);
    client.on("error", () => {});
  });
  server.listen(port, host);
  return server;
}

// --- Credential gateway -------------------------------------------------------
// Run containers never get real model credentials: they get a placeholder and an
// API base URL pointing here. This adds the real key or plan token on the way
// out, so a prompt-injected agent has nothing to leak.

const CREDENTIALS_FILE = process.env.CREDENTIALS_FILE ?? "/keys/credentials.json";
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 3129);

export const UPSTREAMS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
  chatgpt: "https://chatgpt.com",
};

// --- Codex on a ChatGPT sign-in ---------------------------------------------------
// Codex manages these tokens itself, so the sandbox gets a look-alike auth.json:
// the same claims (account, plan), no valid signature, no real refresh token. Its
// chatgpt_base_url and refresh URL point here; this adds the real access token and
// does the real refresh, keeping the refreshed tokens outside the sandbox.

const CODEX_STATE_FILE = process.env.CODEX_STATE_FILE ?? "/state/codex-auth.json";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // Codex CLI's public OAuth client
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const PLACEHOLDER_REFRESH_TOKEN = "cloudly-placeholder";

const b64url = (s: string) => Buffer.from(s).toString("base64url");

function jwtClaims(token: string): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/** Same claims, no valid signature: Codex can read it, nobody can use it. */
export function placeholderJwt(real: string): string {
  return `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(jwtClaims(real)))}.cloudly-placeholder`;
}

/** The auth.json the sandbox gets in place of the real one. */
export function placeholderCodexAuth(real: any): any {
  const t = real?.tokens ?? {};
  return {
    ...real,
    tokens: {
      ...t,
      id_token: t.id_token ? placeholderJwt(t.id_token) : t.id_token,
      access_token: t.access_token ? placeholderJwt(t.access_token) : t.access_token,
      refresh_token: PLACEHOLDER_REFRESH_TOKEN,
    },
  };
}

/** The newest real sign-in: Settings' copy, or one this gateway refreshed since. */
function realCodexAuth(creds: Record<string, string | undefined>): any | null {
  const candidates: any[] = [];
  try {
    if (creds.CODEX_AUTH_JSON) candidates.push(JSON.parse(creds.CODEX_AUTH_JSON));
  } catch {}
  try {
    candidates.push(JSON.parse(readFileSync(CODEX_STATE_FILE, "utf8")));
  } catch {}
  return candidates.sort((a, b) => String(b?.last_refresh ?? "").localeCompare(String(a?.last_refresh ?? "")))[0] ?? null;
}

// ponytail: one refresh at a time per gateway; two workers on one database would
// each refresh, and the refresh token is single-use. Fine with one worker per VM.
let refreshing: Promise<any> | null = null;

async function refreshCodex(auth: any): Promise<any> {
  refreshing ??= (async () => {
    const res = await fetch(CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: auth.tokens.refresh_token, scope: "openid profile email" }),
    });
    if (!res.ok) throw new Error(`ChatGPT sign-in refresh failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const fresh = (await res.json()) as Record<string, string>;
    const updated = {
      ...auth,
      tokens: {
        ...auth.tokens,
        ...(fresh.id_token ? { id_token: fresh.id_token } : {}),
        ...(fresh.access_token ? { access_token: fresh.access_token } : {}),
        ...(fresh.refresh_token ? { refresh_token: fresh.refresh_token } : {}),
      },
      last_refresh: new Date().toISOString(),
    };
    writeFileSync(CODEX_STATE_FILE, JSON.stringify(updated), { mode: 0o600 });
    console.log("gateway: refreshed the ChatGPT sign-in");
    return updated;
  })().finally(() => (refreshing = null));
  return refreshing;
}

/** A real ChatGPT sign-in with at least a minute left, refreshed if needed. */
async function freshCodexAuth(creds: Record<string, string | undefined>, force = false): Promise<any | null> {
  const auth = realCodexAuth(creds);
  if (!auth?.tokens?.access_token) return null;
  const exp = Number(jwtClaims(auth.tokens.access_token).exp) * 1000;
  return force || !exp || exp < Date.now() + 60_000 ? refreshCodex(auth) : auth;
}

// Never forwarded: they describe this hop, not the request.
const HOP_BY_HOP = ["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "content-length"];

/** Swaps whatever credential the agent sent for the real one. Returns false if there's none to add. */
export function injectCredentials(service: string, headers: Headers, url: URL, creds: Record<string, string | undefined>): boolean {
  if (service === "anthropic") {
    // API key in x-api-key; a plan token as a bearer token.
    if (headers.has("x-api-key") && creds.ANTHROPIC_API_KEY) return headers.set("x-api-key", creds.ANTHROPIC_API_KEY), true;
    if (headers.has("authorization") && creds.CLAUDE_CODE_OAUTH_TOKEN) {
      return headers.set("authorization", `Bearer ${creds.CLAUDE_CODE_OAUTH_TOKEN}`), true;
    }
    return false;
  }
  if (service === "openai") {
    if (!creds.OPENAI_API_KEY) return false;
    headers.set("authorization", `Bearer ${creds.OPENAI_API_KEY}`);
    return true;
  }
  if (service === "gemini") {
    if (!creds.GEMINI_API_KEY) return false;
    if (url.searchParams.has("key")) url.searchParams.set("key", creds.GEMINI_API_KEY);
    else headers.set("x-goog-api-key", creds.GEMINI_API_KEY);
    return true;
  }
  return false;
}

// --- MCP servers --------------------------------------------------------------------
// Each connected MCP server is reachable at /mcp/<name> on the gateway, which
// adds the server's token. The sandbox's agents are configured with these URLs
// and never see a token, the same as model keys.

const MCP_FILE = process.env.MCP_FILE ?? "/keys/mcp.json";

export interface GatewayMcp {
  url: string;
  authorization?: string;
}

function readMcp(): Record<string, GatewayMcp> {
  try {
    return JSON.parse(readFileSync(MCP_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** The real URL for /mcp/<name>/<rest>: the server's own URL, plus any sub-path. */
export function mcpTarget(server: GatewayMcp, rest: string[], search: string): URL {
  const target = new URL(server.url);
  const sub = rest.filter(Boolean).join("/");
  if (sub) target.pathname = `${target.pathname.replace(/\/$/, "")}/${sub}`;
  if (search) target.search = search;
  return target;
}

export async function forwardMcp(req: Request, name: string, rest: string[], servers: Record<string, GatewayMcp>): Promise<Response> {
  const server = servers[name];
  if (!server) return new Response(`No MCP server named "${name}" is connected in Cloudly.\n`, { status: 404 });
  const target = mcpTarget(server, rest, new URL(req.url).search);
  const headers = new Headers(req.headers);
  for (const h of [...HOP_BY_HOP, "authorization", "cookie"]) headers.delete(h);
  if (server.authorization) headers.set("authorization", server.authorization);
  console.log(`gateway ${req.method} mcp/${name}`);
  const res = await fetch(target, { method: req.method, headers, body: req.body, duplex: "half", decompress: false, redirect: "manual" } as RequestInit);
  const out = new Headers(res.headers);
  for (const h of [...HOP_BY_HOP, "www-authenticate"]) out.delete(h);
  // Without the challenge, an agent's MCP client won't try to sign in to the
  // gateway itself; the user reconnects in Settings instead.
  if (res.status === 401) {
    await res.body?.cancel().catch(() => {});
    return new Response(`The MCP server "${name}" refused Cloudly's sign-in. Reconnect it under Settings > MCP servers.\n`, { status: 401 });
  }
  return new Response(res.body, { status: res.status, headers: out });
}

function readCredentials(): Record<string, string | undefined> {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function startGateway(port = GATEWAY_PORT, credentials = readCredentials, tls?: { cert: string; key: string }, mcpServers = readMcp) {
  return Bun.serve({
    port,
    ...(tls ? { tls } : {}),
    idleTimeout: 0, // model responses stream for minutes
    async fetch(req) {
      const url = new URL(req.url);

      // Codex refreshing its (placeholder) sign-in: refresh the real one, answer with placeholders.
      if (url.pathname === "/codex-refresh") {
        try {
          const auth = await freshCodexAuth(credentials(), true);
          if (!auth) return new Response("No ChatGPT sign-in is set in Cloudly.\n", { status: 401 });
          const p = placeholderCodexAuth(auth).tokens;
          return Response.json({ id_token: p.id_token, access_token: p.access_token, refresh_token: p.refresh_token });
        } catch (err) {
          console.log(String(err));
          return new Response(String(err), { status: 401 });
        }
      }
      // Codex tries a WebSocket first and falls back to HTTPS; say no straight away.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return new Response("Use HTTPS.\n", { status: 426 });

      // Codex builds some ChatGPT URLs from the origin alone (/backend-api/...),
      // so that path means ChatGPT too.
      const parts = url.pathname.split("/");
      if (parts[1] === "mcp" && parts[2]) return forwardMcp(req, parts[2], parts.slice(3), mcpServers());
      const [service, ...rest] = parts[1] === "backend-api" ? ["chatgpt", ...parts.slice(1)] : parts.slice(1);
      const upstream = UPSTREAMS[service ?? ""];
      if (!upstream) return new Response("Unknown service\n", { status: 404 });

      const target = new URL(`/${rest.join("/")}${url.search}`, upstream);
      const headers = new Headers(req.headers);
      for (const h of HOP_BY_HOP) headers.delete(h);
      if (service === "chatgpt") {
        const auth = await freshCodexAuth(credentials()).catch((err) => (console.log(String(err)), null));
        if (!auth) return new Response("No working ChatGPT sign-in in Cloudly.\n", { status: 401 });
        headers.set("authorization", `Bearer ${auth.tokens.access_token}`);
        if (auth.tokens.account_id) headers.set("chatgpt-account-id", auth.tokens.account_id);
      } else if (!injectCredentials(service!, headers, target, credentials())) {
        console.log(`gateway ${service}: no credential to add`);
        return new Response(`No ${service} credential is set in Cloudly.\n`, { status: 401 });
      }
      console.log(`gateway ${req.method} ${service} ${target.pathname}`);
      const res = await fetch(target, {
        method: req.method,
        headers,
        body: req.body,
        // Streams the request body instead of buffering it.
        duplex: "half",
        // Pass bytes through untouched, compressed or not.
        decompress: false,
        redirect: "manual",
      });
      const out = new Headers(res.headers);
      for (const h of HOP_BY_HOP) out.delete(h);
      return new Response(res.body, { status: res.status, headers: out });
    },
  });
}

if (import.meta.main) {
  // IPv4: run containers reach it over the Docker network, and some hosts have no IPv6 at all.
  startProxy(PORT, allowed, interceptPort, "0.0.0.0");
  startGateway();
  // HTTPS twin, for Codex's ChatGPT backend (which refuses plain HTTP).
  try {
    startGateway(GATEWAY_PORT + 1, readCredentials, { cert: readFileSync("/keys/gateway.pem", "utf8"), key: readFileSync("/keys/gateway.key", "utf8") });
  } catch (err) {
    console.log("gateway HTTPS port not started:", String(err));
  }
  console.log(`egress proxy on :${PORT}, rules from ${ALLOW_FILE}; credential gateway on :${GATEWAY_PORT}`);
}
