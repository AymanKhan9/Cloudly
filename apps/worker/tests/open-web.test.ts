import { test, expect } from "bun:test";
import net from "node:net";
import { startProxy, proxyToken, isPublicAddress, publicAddress } from "../src/egress-proxy";

function ask(port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(request));
    let out = "";
    s.on("data", (d) => {
      out += d.toString();
      if (out.includes("\r\n\r\n")) s.end();
    });
    s.on("close", () => resolve(out));
  });
}
const basic = (user: string, pass: string) => `Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}\r\n`;

test("public and private addresses", () => {
  for (const ip of ["8.8.8.8", "140.82.112.3", "2606:4700::1111"]) expect(isPublicAddress(ip)).toBe(true);
  for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.17.0.2", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "not-an-ip"]) {
    expect(isPublicAddress(ip)).toBe(false);
  }
});

test("a name with any private address is refused, so DNS can't smuggle in an internal host", async () => {
  const fake = (map: Record<string, string[]>) => async (h: string) => (map[h] ?? []).map((address) => ({ address, family: 4 }));
  expect(await publicAddress("example.com", fake({ "example.com": ["93.184.216.34"] }))).toBe("93.184.216.34");
  expect(await publicAddress("metadata.evil", fake({ "metadata.evil": ["169.254.169.254"] }))).toBeNull();
  expect(await publicAddress("mixed.evil", fake({ "mixed.evil": ["93.184.216.34", "10.0.0.5"] }))).toBeNull();
  expect(await publicAddress("169.254.169.254")).toBeNull();
});

test("the open web needs a live council credential; without one the allowlist applies", async () => {
  expect(proxyToken(`CONNECT a:443 HTTP/1.1\r\n${basic("council", "tok:en")}\r\n`)).toBe("tok:en");
  expect(proxyToken(`CONNECT a:443 HTTP/1.1\r\n${basic("other", "tok")}\r\n`)).toBeNull();

  const resolved: string[] = [];
  const proxy = startProxy(
    0,
    (h) => h === "api.anthropic.com",
    () => null,
    "127.0.0.1",
    (t) => t === "live-token",
    async (h) => {
      resolved.push(h);
      return h === "news.example" ? "127.0.0.1" : null; // the test's stand-in is local; the real resolver refuses that
    },
  );
  await new Promise<void>((r) => (proxy.listening ? r() : proxy.once("listening", () => r())));
  const port = (proxy.address() as net.AddressInfo).port;
  try {
    expect(await ask(port, "CONNECT news.example:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 403");
    expect(await ask(port, `CONNECT news.example:443 HTTP/1.1\r\n${basic("council", "revoked")}\r\n`)).toStartWith("HTTP/1.1 403");
    expect(await ask(port, `CONNECT internal.example:443 HTTP/1.1\r\n${basic("council", "live-token")}\r\n`)).toContain("public address");
    expect(await ask(port, `CONNECT news.example:80 HTTP/1.1\r\n${basic("council", "live-token")}\r\n`)).toStartWith("HTTP/1.1 403");
    // With the credential, an off-list public host is tunnelled (here the proxy fails to reach port 443 locally: a 502, not a 403).
    const open = await ask(port, `CONNECT news.example:443 HTTP/1.1\r\n${basic("council", "live-token")}\r\n`);
    expect(open).not.toStartWith("HTTP/1.1 403");
    expect(resolved).toContain("news.example");
  } finally {
    proxy.close();
  }
});
