import { test, expect } from "bun:test";
import { substituteSecrets, hostMatches, forwardMcp, mcpTarget, startGateway, type ProxySecret } from "../src/egress-proxy";

const secrets: ProxySecret[] = [
  { placeholder: "cloudly-secret-aaaa", value: "sk_live_real", hosts: ["api.stripe.com"] },
  { placeholder: "cloudly-secret-bbbb", value: "ghp_real", hosts: ["example.com"] },
];

test("hosts match themselves and their subdomains, nothing else", () => {
  expect(hostMatches("api.stripe.com", "api.stripe.com")).toBe(true);
  expect(hostMatches("uploads.example.com", "example.com")).toBe(true);
  expect(hostMatches("evilexample.com", "example.com")).toBe(false);
  expect(hostMatches("example.com.evil.io", "example.com")).toBe(false);
});

test("placeholders become real values only for the secret's own hosts", () => {
  const headers = new Headers({
    authorization: "Bearer cloudly-secret-aaaa",
    "x-other": "cloudly-secret-bbbb",
    "x-plain": "nothing here",
  });
  const url = new URL("https://api.stripe.com/v1/charges?key=cloudly-secret-aaaa");
  expect(substituteSecrets(headers, url, "api.stripe.com", secrets)).toBe(2);
  expect(headers.get("authorization")).toBe("Bearer sk_live_real");
  // Another secret's placeholder isn't filled in for a host it isn't meant for.
  expect(headers.get("x-other")).toBe("cloudly-secret-bbbb");
  expect(url.searchParams.get("key")).toBe("sk_live_real");
  expect(url.pathname).toBe("/v1/charges");

  const elsewhere = new Headers({ authorization: "Bearer cloudly-secret-aaaa" });
  expect(substituteSecrets(elsewhere, new URL("https://attacker.example/"), "attacker.example", secrets)).toBe(0);
  expect(elsewhere.get("authorization")).toBe("Bearer cloudly-secret-aaaa");
});

test("Basic credentials are decoded, filled in and encoded again", () => {
  const headers = new Headers({ authorization: `Basic ${Buffer.from("user:cloudly-secret-bbbb").toString("base64")}` });
  substituteSecrets(headers, new URL("https://git.example.com/"), "git.example.com", secrets);
  expect(Buffer.from(headers.get("authorization")!.slice(6), "base64").toString()).toBe("user:ghp_real");
});

test("an MCP server's URL keeps its own path, with any sub-path and query added", () => {
  expect(mcpTarget({ url: "https://mcp.linear.app/mcp" }, [], "").href).toBe("https://mcp.linear.app/mcp");
  expect(mcpTarget({ url: "https://x.dev/mcp/" }, ["messages"], "?sessionId=1").href).toBe("https://x.dev/mcp/messages?sessionId=1");
});

test("the gateway sends /mcp/<name> to the server with its token and nothing of the sandbox's", async () => {
  let seen: Headers | null = null;
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      seen = req.headers;
      if (req.headers.get("authorization") !== "Bearer real-token") {
        return new Response("no", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://x"' } });
      }
      return new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream", "mcp-session-id": "s1" } });
    },
  });
  const servers = {
    linear: { url: `http://127.0.0.1:${upstream.port}/mcp`, authorization: "Bearer real-token" },
    stale: { url: `http://127.0.0.1:${upstream.port}/mcp`, authorization: "Bearer revoked" },
  };
  const gateway = startGateway(0, () => ({}), undefined, () => servers);
  try {
    const ok = await fetch(`http://127.0.0.1:${gateway.port}/mcp/linear`, {
      method: "POST",
      headers: { authorization: "Bearer sandbox-guess", cookie: "x=1", "content-type": "application/json" },
      body: "{}",
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("mcp-session-id")).toBe("s1");
    expect(await ok.text()).toBe("data: {}\n\n");
    expect(seen!.get("authorization")).toBe("Bearer real-token");
    expect(seen!.get("cookie")).toBeNull();

    const refused = await fetch(`http://127.0.0.1:${gateway.port}/mcp/stale`, { method: "POST", body: "{}" });
    expect(refused.status).toBe(401);
    // No challenge: the agent's client mustn't try to sign in to the gateway itself.
    expect(refused.headers.get("www-authenticate")).toBeNull();
    expect(await refused.text()).toContain("Reconnect it under Settings");

    expect((await fetch(`http://127.0.0.1:${gateway.port}/mcp/unknown`)).status).toBe(404);
  } finally {
    gateway.stop(true);
    upstream.stop(true);
  }
});

test("forwardMcp needs a known server name", async () => {
  const res = await forwardMcp(new Request("http://gw/mcp/x"), "x", [], {});
  expect(res.status).toBe(404);
});
