// The only way out of a run container. Runs in its own container on both the
// sandbox's internal network (no route out, no outside DNS) and the normal one.
// HTTPS only: clients send CONNECT host:443 and this pipes the encrypted stream
// through when the host is allowed. It never sees request contents.
import net from "node:net";
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

export function startProxy(port = PORT, isAllowed = allowed): net.Server {
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
      if (target.port !== 443 || !isAllowed(target.host)) {
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
      console.log(viaGateway ? `allow ${target.host} (via the credential gateway)` : `allow ${target.host}`);
      const upstream = net.connect(viaGateway ? GATEWAY_PORT + 1 : target.port, viaGateway ? "127.0.0.1" : target.host, () => {
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
  server.listen(port);
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

function readCredentials(): Record<string, string | undefined> {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function startGateway(port = GATEWAY_PORT, credentials = readCredentials, tls?: { cert: string; key: string }) {
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
  startProxy();
  startGateway();
  // HTTPS twin, for Codex's ChatGPT backend (which refuses plain HTTP).
  try {
    startGateway(GATEWAY_PORT + 1, readCredentials, { cert: readFileSync("/keys/gateway.pem", "utf8"), key: readFileSync("/keys/gateway.key", "utf8") });
  } catch (err) {
    console.log("gateway HTTPS port not started:", String(err));
  }
  console.log(`egress proxy on :${PORT}, rules from ${ALLOW_FILE}; credential gateway on :${GATEWAY_PORT}`);
}
