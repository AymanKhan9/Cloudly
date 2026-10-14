import { test, expect } from "bun:test";
import net from "node:net";
import { parseConnect, startProxy, injectCredentials } from "../src/egress-proxy";

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

test("the gateway swaps the agent's placeholder for the real credential", () => {
  const creds = { ANTHROPIC_API_KEY: "sk-ant-real", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real", OPENAI_API_KEY: "sk-real", GEMINI_API_KEY: "g-real" };
  const url = new URL("https://x");

  const apiKey = new Headers({ "x-api-key": "sk-ant-api03-cloudly-placeholder" });
  expect(injectCredentials("anthropic", apiKey, url, creds)).toBe(true);
  expect(apiKey.get("x-api-key")).toBe("sk-ant-real");

  const plan = new Headers({ authorization: "Bearer sk-ant-oat01-cloudly-placeholder" });
  injectCredentials("anthropic", plan, url, creds);
  expect(plan.get("authorization")).toBe("Bearer sk-ant-oat01-real");

  const openai = new Headers({ authorization: "Bearer sk-cloudly-placeholder" });
  injectCredentials("openai", openai, url, creds);
  expect(openai.get("authorization")).toBe("Bearer sk-real");

  const gemini = new Headers({ "x-goog-api-key": "cloudly-placeholder" });
  injectCredentials("gemini", gemini, url, creds);
  expect(gemini.get("x-goog-api-key")).toBe("g-real");
  const byQuery = new URL("https://x/v1beta/models?key=cloudly-placeholder");
  injectCredentials("gemini", new Headers(), byQuery, creds);
  expect(byQuery.searchParams.get("key")).toBe("g-real");

  // Nothing configured: refuse rather than forward the placeholder.
  expect(injectCredentials("openai", new Headers({ authorization: "Bearer x" }), url, {})).toBe(false);
});
