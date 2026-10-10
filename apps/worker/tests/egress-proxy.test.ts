import { test, expect } from "bun:test";
import net from "node:net";
import { parseConnect, startProxy } from "../src/egress-proxy";

function ask(port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(request));
    let out = "";
    s.on("data", (d) => (out += d.toString()));
    s.on("close", () => resolve(out));
  });
}

test("CONNECT requests are parsed; anything else isn't", () => {
  expect(parseConnect("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: x\r\n\r\n")).toEqual({ host: "api.anthropic.com", port: 443 });
  expect(parseConnect("GET http://example.com/ HTTP/1.1\r\n\r\n")).toBeNull();
});

test("hosts off the list, other ports and plain HTTP are refused", async () => {
  const server = startProxy(0, (host) => host === "api.anthropic.com");
  const port = (server.address() as net.AddressInfo).port;
  try {
    expect(await ask(port, "CONNECT attacker.example:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 403");
    expect(await ask(port, "CONNECT api.anthropic.com:22 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 403");
    expect(await ask(port, "GET http://api.anthropic.com/ HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 405");
  } finally {
    server.close();
  }
});
