import { test, expect } from "bun:test";
import net from "node:net";
import tls from "node:tls";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startProxy, startInterceptServer } from "../src/egress-proxy";

/** A certificate for api.test, made the way the worker makes them (openssl). */
async function certificate(): Promise<{ cert: string; key: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "intercept-cert-"));
  try {
    const p = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=api.test",
      "-addext", "subjectAltName=DNS:api.test", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")]);
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return { cert: await Bun.file(path.join(dir, "c.pem")).text(), key: await Bun.file(path.join(dir, "k.pem")).text() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What a sandbox does: CONNECT through the proxy, then TLS and one HTTP request inside the tunnel. */
function requestThrough(proxyPort: number, host: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, "127.0.0.1", () => raw.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    raw.once("data", (d) => {
      if (!d.toString().startsWith("HTTP/1.1 200")) return reject(new Error(d.toString()));
      const secure = tls.connect({ socket: raw, servername: host, rejectUnauthorized: false }, () => secure.write(request));
      let out = "";
      secure.on("data", (c) => {
        out += c.toString();
        if (out.includes("\r\n\r\n") && /content-length: (\d+)/i.test(out)) {
          const len = Number(/content-length: (\d+)/i.exec(out)![1]);
          if (out.length - out.indexOf("\r\n\r\n") - 4 >= len) secure.end();
        }
      });
      secure.on("close", () => resolve(out));
      secure.on("error", reject);
    });
    raw.on("error", reject);
  });
}

test("a secret's host gets the real value; the request still goes only where the tunnel was opened", async () => {
  const secrets = [{ placeholder: "cloudly-secret-1234", value: "sk_real_value", hosts: ["api.test"] }];
  const intercept = startInterceptServer({ ...(await certificate()), secrets });
  const proxy = startProxy(0, (h) => h === "api.test", (h) => (h === "api.test" ? intercept.port! : null), "127.0.0.1");
  await new Promise<void>((r) => (proxy.listening ? r() : proxy.once("listening", () => r())));
  const realFetch = globalThis.fetch;
  const sent: { url: string; auth: string | null }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return new Response("ok", { headers: { "content-length": "2" } });
  }) as typeof fetch;
  try {
    const port = (proxy.address() as net.AddressInfo).port;
    const ok = await requestThrough(port, "api.test", "GET /v1/me?key=cloudly-secret-1234 HTTP/1.1\r\nHost: api.test\r\nAuthorization: Bearer cloudly-secret-1234\r\nConnection: close\r\n\r\n");
    expect(ok).toStartWith("HTTP/1.1 200");
    expect(sent).toEqual([{ url: "https://api.test/v1/me?key=sk_real_value", auth: "Bearer sk_real_value" }]);

    // The Host header is the agent's to choose; the tunnel's target isn't.
    const misdirected = await requestThrough(port, "api.test", "GET / HTTP/1.1\r\nHost: attacker.example\r\nAuthorization: Bearer cloudly-secret-1234\r\nConnection: close\r\n\r\n");
    expect(misdirected).toStartWith("HTTP/1.1 421");
    expect(sent).toHaveLength(1);
  } finally {
    globalThis.fetch = realFetch;
    proxy.close();
    intercept.stop(true);
  }
});
