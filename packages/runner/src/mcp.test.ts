import { test, expect } from "bun:test";
import { claudeMcpServers, codexMcpConfig, acpMcpServers, DESKTOP_MCP, type McpSpec } from "./mcp";
import { handle, commandsFor, TOOLS } from "./desktop-mcp";

const specs: McpSpec[] = [{ name: "linear", url: "http://cloudly-egress:3129/mcp/linear" }, DESKTOP_MCP];
const desktopArgs = (DESKTOP_MCP as { args: string[] }).args;

test("each agent gets the same servers in its own format", () => {
  expect(claudeMcpServers(specs)).toEqual({
    linear: { type: "http", url: "http://cloudly-egress:3129/mcp/linear" },
    desktop: { type: "stdio", command: "bun", args: desktopArgs },
  });
  expect(codexMcpConfig(specs)).toEqual({
    mcp_servers: {
      linear: { url: "http://cloudly-egress:3129/mcp/linear" },
      desktop: { command: "bun", args: desktopArgs },
    },
  });
  expect(codexMcpConfig([])).toBeUndefined();
  expect(acpMcpServers(specs)).toEqual([
    { type: "http", name: "linear", url: "http://cloudly-egress:3129/mcp/linear", headers: [] },
    { name: "desktop", command: "bun", args: desktopArgs, env: [] },
  ]);
  expect(desktopArgs[0]).toEndWith("/desktop-mcp.ts");
});

test("the desktop server speaks MCP: initialize, tools, errors", async () => {
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  expect(init?.result.capabilities).toEqual({ tools: {} });
  expect(init?.result.protocolVersion).toBe("2025-06-18");
  expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect(list?.result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
  expect((await handle({ jsonrpc: "2.0", id: 3, method: "nope" }))?.error.code).toBe(-32601);
  // A bad call is a tool error the agent can read, not a protocol failure.
  const bad = await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "click", arguments: { x: 99999, y: 1 } } });
  expect(bad?.result.isError).toBe(true);
  const url = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "open_url", arguments: { url: "file:///etc/passwd" } } });
  expect(url?.result.isError).toBe(true);
});

test("tool calls become bounded xdotool commands; text never becomes options", () => {
  expect(commandsFor("click", { x: 10, y: 20, button: "right", double: true })).toEqual([["xdotool", "mousemove", "10", "20", "click", "--repeat", "2", "3"]]);
  expect(commandsFor("type", { text: "--help; rm -rf /" })).toEqual([["xdotool", "type", "--delay", "15", "--", "--help; rm -rf /"]]);
  expect(commandsFor("key", { keys: "ctrl+l Return" })).toEqual([["xdotool", "key", "--", "ctrl+l", "Return"]]);
  expect(commandsFor("scroll", { x: 1, y: 1, direction: "up", amount: 500 })[0]).toContain("30");
  expect(() => commandsFor("move", { x: -1, y: 0 })).toThrow();
});
