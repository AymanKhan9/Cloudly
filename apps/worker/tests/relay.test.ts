import { test, expect } from "bun:test";
import net from "node:net";
import { createHmac } from "node:crypto";
import { verifyRelayToken, stripCookies, startPreviewRelay, startDesktopRelay, type Resolve } from "../src/relay";
import { signRelayToken, relayKey } from "@repo/db";

const KEY = "test-relay-key";
const CONTAINER = "preview-11111111-2222-3333-4444-555555555555";

function sign(payload: object, key = KEY) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
const soon = () => Math.floor(Date.now() / 1000) + 60;

test("tokens: signed, unexpired, for a run or preview container only", async () => {
  expect(verifyRelayToken(sign({ k: "preview", c: CONTAINER, exp: soon() }), KEY)?.c).toBe(CONTAINER);
  expect(verifyRelayToken(sign({ k: "preview", c: CONTAINER, exp: soon() }, "other"), KEY)).toBeNull();
  expect(verifyRelayToken(sign({ k: "preview", c: CONTAINER, exp: 1 }), KEY)).toBeNull();
  expect(verifyRelayToken(sign({ k: "preview", c: "cloudly-egress", exp: soon() }), KEY)).toBeNull();
  expect(verifyRelayToken(sign({ k: "shell", c: CONTAINER, exp: soon() }), KEY)).toBeNull();
  expect(verifyRelayToken("garbage", KEY)).toBeNull();
  // What the API signs, the relay accepts, with the key the worker hands it.
  const { token } = await signRelayToken("desktop", `run-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, 60);
  expect(verifyRelayToken(token, await relayKey())?.k).toBe("desktop");
});

test("Cloudly's own cookies never reach a preview", () => {
  expect(stripCookies("session=abc; theme=dark; cloudly_preview=t; oauth_state=x")).toBe("theme=dark");
  expect(stripCookies("session=abc")).toBeNull();
});

test("a preview: entered with a token, then proxied by cookie, without Cloudly's cookies either way", async () => {
  let got: Headers | null = null;
  const app = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      got = req.headers;
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "session=hijack; Path=/");
      headers.append("set-cookie", "app=1; Path=/");
      return new Response(`path ${new URL(req.url).pathname}`, { headers });
    },
    websocket: {
      message(ws, m) {
        ws.send(`echo ${m}`);
      },
    },
  });
  const resolve: Resolve = () => ({ host: "127.0.0.1", port: app.port! });
  const relay = startPreviewRelay(() => KEY, 0, resolve);
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/__cloudly/enter?t=nope`, { redirect: "manual" })).status).toBe(401);

    const token = sign({ k: "preview", c: CONTAINER, exp: soon() });
    const enter = await fetch(`${base}/__cloudly/enter?t=${token}`, { redirect: "manual" });
    expect(enter.status).toBe(302);
    const cookie = enter.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    const pv = cookie.split(";")[0]!;

    const res = await fetch(`${base}/assets/app.js`, { headers: { cookie: `${pv}; session=victim; app=1` } });
    expect(await res.text()).toBe("path /assets/app.js");
    expect(got!.get("cookie")).toBe("app=1");
    expect(got!.get("host")).toBe("localhost");
    // The app can't set a cookie Cloudly uses.
    expect(res.headers.getSetCookie()).toEqual(["app=1; Path=/"]);

    // A desktop token doesn't open a preview.
    const desktopToken = sign({ k: "desktop", c: CONTAINER, exp: soon() });
    expect((await fetch(`${base}/`, { headers: { cookie: `cloudly_preview=${desktopToken}` } })).status).toBe(401);

    // Hot reload and other WebSockets go through.
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/_hmr`, { headers: { cookie: pv } } as never);
    const reply = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send("hi");
      ws.onmessage = (e) => resolve(String(e.data));
      ws.onerror = () => reject(new Error("ws failed"));
    });
    expect(reply).toBe("echo hi");
    ws.close();
  } finally {
    relay.stop(true);
    app.stop(true);
  }
});

test("the desktop relay bridges a WebSocket to the container's VNC port, by token only", async () => {
  const vnc = net.createServer((s) => {
    s.write("RFB 003.008\n");
    s.on("data", (d: Buffer) => s.write(Buffer.concat([Buffer.from("got:"), d])));
  });
  await new Promise<void>((r) => vnc.listen(0, "127.0.0.1", r));
  const resolve: Resolve = () => ({ host: "127.0.0.1", port: (vnc.address() as net.AddressInfo).port });
  const relay = startDesktopRelay(() => KEY, 0, resolve);
  try {
    expect((await fetch(`http://127.0.0.1:${relay.port}/desktop?t=bad`)).status).toBe(401);
    const previewToken = sign({ k: "preview", c: CONTAINER, exp: soon() });
    expect((await fetch(`http://127.0.0.1:${relay.port}/desktop?t=${previewToken}`)).status).toBe(401);

    const token = sign({ k: "desktop", c: "run-11111111-2222-3333-4444-555555555555", exp: soon() });
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop?t=${token}`);
    ws.binaryType = "arraybuffer";
    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (e) => {
        messages.push(Buffer.from(e.data as ArrayBuffer).toString());
        if (messages.length === 1) ws.send(Buffer.from("hello"));
        if (messages.length === 2) resolve();
      };
      ws.onerror = () => reject(new Error("ws failed"));
    });
    expect(messages).toEqual(["RFB 003.008\n", "got:hello"]);
    ws.close();
  } finally {
    relay.stop(true);
    vnc.close();
  }
});
