// The one way in to a sandbox, on purpose and narrow. Runs in its own container
// on the sandbox network. Every request carries a token the API signed for one
// container and one purpose, valid for a limited time, and the relay only ever
// connects to that container's VNC port or its preview port:
//
//   :3140  /desktop?t=…   WebSocket ↔ the container's VNC server, for the
//                          viewer in the session page (behind the web app's /relay).
//   :3141  a preview      the session's app over HTTP and WebSocket, on an origin
//                          of its own so its code can't act as the Cloudly app.
//
// Self-contained (node builtins only): the worker mounts this one file.
import net from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const DESKTOP_PORT = 3140;
export const PREVIEW_PORT = 3141;
/** Where a preview container serves its app (packages/runner/src/preview.ts). */
export const APP_PORT = 39000;
export const VNC_PORT = 5900;

export interface RelayToken {
  /** desktop: the VNC server. preview: the app. */
  k: "desktop" | "preview";
  /** The container: run-<id> or preview-<id>. */
  c: string;
  /** Expiry, in epoch seconds. */
  exp: number;
}

const CONTAINER = /^(run|preview)-[0-9a-f-]{36}$/;

export function verifyRelayToken(token: string | null | undefined, key: string, now = Date.now()): RelayToken | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", key).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as RelayToken;
    if ((t.k !== "desktop" && t.k !== "preview") || !CONTAINER.test(t.c) || !(t.exp * 1000 > now)) return null;
    return t;
  } catch {
    return null;
  }
}

// Cookies the Cloudly app sets. A preview shares the host (cookies ignore the
// port), so these would otherwise reach the app's code, or be overwritten by it.
export const CLOUDLY_COOKIES = ["session", "oauth_state", "oauth_verifier", "setup_state", "mcp_oauth", "cloudly_preview"];

/** The Cookie header without Cloudly's own cookies. */
export function stripCookies(header: string | null): string | null {
  if (!header) return null;
  const kept = header
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !CLOUDLY_COOKIES.includes(p.split("=")[0]!.trim()));
  return kept.length ? kept.join("; ") : null;
}

export function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "content-length", "host"];

/** Where a container's port is reached; tests point it at local servers. */
export type Resolve = (container: string, port: number) => { host: string; port: number };
const byName: Resolve = (container, port) => ({ host: container, port });

interface Bridge {
  kind: "vnc" | "ws";
  host: string;
  port: number;
  path?: string;
  protocol?: string;
  tcp?: net.Socket;
  upstream?: WebSocket;
  queue: (string | Buffer)[];
}

type Server = ReturnType<typeof Bun.serve<Bridge>>;

const websocket = {
  open(ws: import("bun").ServerWebSocket<Bridge>) {
    const b = ws.data;
    if (b.kind === "vnc") {
      const tcp = net.connect(b.port, b.host, () => {
        for (const m of b.queue.splice(0)) tcp.write(m);
      });
      tcp.on("data", (d) => ws.send(d));
      tcp.on("close", () => ws.close());
      tcp.on("error", () => ws.close(1011, "The desktop isn't reachable."));
      b.tcp = tcp;
      return;
    }
    const upstream = new WebSocket(`ws://${b.host}:${b.port}${b.path}`, b.protocol ? [b.protocol] : []);
    upstream.binaryType = "arraybuffer";
    upstream.onopen = () => {
      for (const m of b.queue.splice(0)) upstream.send(m);
    };
    upstream.onmessage = (e) => ws.send(typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer));
    upstream.onclose = () => ws.close();
    upstream.onerror = () => ws.close(1011, "The app isn't reachable.");
    b.upstream = upstream;
  },
  message(ws: import("bun").ServerWebSocket<Bridge>, message: string | Buffer) {
    const b = ws.data;
    if (b.kind === "vnc") {
      if (b.tcp && !b.tcp.connecting) b.tcp.write(message);
      else b.queue.push(message);
    } else if (b.upstream?.readyState === WebSocket.OPEN) {
      b.upstream.send(message);
    } else {
      b.queue.push(message);
    }
  },
  close(ws: import("bun").ServerWebSocket<Bridge>) {
    ws.data.tcp?.destroy();
    ws.data.upstream?.close();
  },
};

export function startDesktopRelay(key: () => string, port = DESKTOP_PORT, resolve: Resolve = byName): Server {
  return Bun.serve<Bridge>({
    port,
    idleTimeout: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname !== "/desktop") return new Response("Not found\n", { status: 404 });
      const t = verifyRelayToken(url.searchParams.get("t"), key());
      if (t?.k !== "desktop") return new Response("This desktop link has expired. Open the desktop again from the session.\n", { status: 401 });
      if (server.upgrade(req, { data: { kind: "vnc", ...resolve(t.c, VNC_PORT), queue: [] } })) return undefined;
      return new Response("Expected a WebSocket\n", { status: 426 });
    },
    websocket,
  });
}

function previewCookie(token: string, secure: boolean, exp: number): string {
  const maxAge = Math.max(0, exp - Math.floor(Date.now() / 1000));
  return `cloudly_preview=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function startPreviewRelay(key: () => string, port = PREVIEW_PORT, resolve: Resolve = byName): Server {
  return Bun.serve<Bridge>({
    port,
    idleTimeout: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      const secure = (req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")) === "https";

      // Opened from the session page with a fresh token: keep it in a cookie for this origin.
      if (url.pathname === "/__cloudly/enter") {
        const token = url.searchParams.get("t");
        const t = verifyRelayToken(token, key());
        if (t?.k !== "preview") return new Response("This preview link has expired. Open the preview again from the session.\n", { status: 401 });
        return new Response(null, { status: 302, headers: { location: "/", "set-cookie": previewCookie(token!, secure, t.exp), "cache-control": "no-store" } });
      }

      const t = verifyRelayToken(cookieValue(req.headers.get("cookie"), "cloudly_preview"), key());
      if (t?.k !== "preview") {
        return new Response("Open this preview from its session in Cloudly.\n", { status: 401, headers: { "content-type": "text/plain" } });
      }

      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocol = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        const ok = server.upgrade(req, {
          data: { kind: "ws", ...resolve(t.c, APP_PORT), path: url.pathname + url.search, protocol, queue: [] },
          headers: protocol ? { "sec-websocket-protocol": protocol } : undefined,
        });
        return ok ? undefined : new Response("Expected a WebSocket\n", { status: 426 });
      }

      const headers = new Headers(req.headers);
      for (const h of HOP_BY_HOP) headers.delete(h);
      const cookie = stripCookies(req.headers.get("cookie"));
      if (cookie) headers.set("cookie", cookie);
      else headers.delete("cookie");
      // Dev servers often only answer to localhost (Vite's allowedHosts).
      headers.set("host", "localhost");
      headers.set("x-forwarded-host", url.host);
      try {
        const app = resolve(t.c, APP_PORT);
        const res = await fetch(`http://${app.host}:${app.port}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: req.body,
          redirect: "manual",
          decompress: false,
          duplex: "half",
        } as RequestInit);
        const out = new Headers();
        for (const [name, value] of res.headers) {
          if (HOP_BY_HOP.includes(name)) continue;
          if (name === "set-cookie" && CLOUDLY_COOKIES.includes(value.split("=")[0]!.trim())) continue;
          out.append(name, value);
        }
        return new Response(res.body, { status: res.status, headers: out });
      } catch {
        return new Response("The app isn't answering yet. If it just started, wait a moment and reload.\n", { status: 502, headers: { "content-type": "text/plain" } });
      }
    },
    websocket,
  });
}

if (import.meta.main) {
  const file = process.env.RELAY_KEY_FILE ?? "/relay/relay.key";
  // Re-read so a new key applies without a restart.
  const key = () => readFileSync(file, "utf8").trim();
  startDesktopRelay(key);
  startPreviewRelay(key);
  console.log(`relay: desktop on :${DESKTOP_PORT}, previews on :${PREVIEW_PORT}`);
}
