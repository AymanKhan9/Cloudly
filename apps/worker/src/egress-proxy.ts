// The only way out of a run container. Runs in its own container on both the
// sandbox's internal network (no route out, no outside DNS) and the normal one.
// HTTPS only: clients send CONNECT host:443 and this pipes the encrypted stream
// through when the host is allowed. It never sees request contents.
import net from "node:net";
import { readFileSync } from "node:fs";

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
      console.log(`allow ${target.host}`);
      const upstream = net.connect(target.port, target.host, () => {
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
};

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

export function startGateway(port = GATEWAY_PORT, credentials = readCredentials) {
  return Bun.serve({
    port,
    idleTimeout: 0, // model responses stream for minutes
    async fetch(req) {
      const url = new URL(req.url);
      const [, service, ...rest] = url.pathname.split("/");
      const upstream = UPSTREAMS[service ?? ""];
      if (!upstream) return new Response("Unknown service\n", { status: 404 });

      const target = new URL(`/${rest.join("/")}${url.search}`, upstream);
      const headers = new Headers(req.headers);
      for (const h of HOP_BY_HOP) headers.delete(h);
      if (!injectCredentials(service!, headers, target, credentials())) {
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
  console.log(`egress proxy on :${PORT}, rules from ${ALLOW_FILE}; credential gateway on :${GATEWAY_PORT}`);
}
