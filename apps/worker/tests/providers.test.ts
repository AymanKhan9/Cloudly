import { test, expect, afterAll } from "bun:test";
import { prisma, addProvider, setProviderCredentials, updateProvider, providerPlaceholder } from "@repo/db";
import { providerInstallBlock, launchFromRegistry, catalogLaunch, catalogEntry, type AgentLaunch } from "@repo/shared/providers";
import { credentialFlags, acpLaunch } from "../src/docker";
import { costFromDoneEvent } from "../src/cost";
import { agentSessionIdFromEvent } from "../src/agent-session";
import { BASE_IMAGE } from "../src/sandbox-image";

afterAll(async () => {
  await prisma.provider.deleteMany({ where: { id: { startsWith: "acp-wt-" } } });
});

/** Runs image-build lines as root in the base image, with no network, the way the image build does. */
async function inBaseImage(script: string): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["docker", "run", "--rm", "--network", "none", "-u", "root", BASE_IMAGE, "bash", "-c", `set -eux\n${script}`], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out: out + err, code };
}

test("an added agent's run script passes its arguments exactly, quotes and dollar signs included", async () => {
  const launch: AgentLaunch = {
    // Stands in for an install: a command that prints each argument on its own line.
    install: { kind: "script", script: `printf '#!/bin/sh\\nfor a in "$@"; do echo "[$a]"; done\\n' > /usr/local/bin/echo-args && chmod 755 /usr/local/bin/echo-args`, cmd: "echo-args" },
    args: ["acp", "it's", "$HOME", "a b", "`id`"],
  };
  const { out, code } = await inBaseImage(`${providerInstallBlock("acp-wt-args", launch)}\nsu node -s /bin/sh -c '/opt/cloudly/agents/acp-wt-args/run extra'`);
  expect(code).toBe(0);
  expect(out).toContain("[acp]\n[it's]\n[$HOME]\n[a b]\n[`id`]\n[extra]");
});

test("an agent that fails to install is left out without failing the rest of the image", async () => {
  const broken = providerInstallBlock("acp-wt-broken", { install: { kind: "script", script: "false", cmd: "nothing" }, args: [] });
  const fine = providerInstallBlock("acp-wt-fine", { install: { kind: "script", script: "true", cmd: "/bin/true" }, args: [] });
  const { out, code } = await inBaseImage(`${broken}\n${fine}\ntest ! -e /opt/cloudly/agents/acp-wt-broken && test -x /opt/cloudly/agents/acp-wt-fine/run && echo BOTH-OK`);
  expect(code).toBe(0);
  expect(out).toContain("acp-wt-broken failed to install");
  expect(out).toContain("BOTH-OK");
});

test("a binary build is checked against its sha256 before it's unpacked", async () => {
  const block = providerInstallBlock("acp-wt-bin", {
    install: { kind: "binary", builds: { x86_64: { url: "file:///etc/hostname", sha256: "00".repeat(32), cmd: "./agent" }, aarch64: { url: "file:///etc/hostname", sha256: "00".repeat(32), cmd: "./agent" } } },
    args: [],
  });
  const { out } = await inBaseImage(`${block}\ntest ! -e /opt/cloudly/agents/acp-wt-bin && echo REJECTED`);
  expect(out).toContain("FAILED");
  expect(out).toContain("REJECTED");
});

test("registry entries become installs: npm packages, Linux builds per CPU, Python packages", () => {
  expect(launchFromRegistry({ id: "a", name: "A", version: "1", distribution: { npx: { package: "a@1", args: ["--acp"] } } })).toEqual({
    install: { kind: "npm", packages: ["a@1"] },
    args: ["--acp"],
    env: undefined,
  });
  expect(launchFromRegistry({
    id: "b", name: "B", version: "1",
    distribution: { binary: { "linux-aarch64": { archive: "https://x/b.zip", cmd: "./b", args: ["acp"] }, "windows-x86_64": { archive: "https://x/b.exe", cmd: "b.exe" } } },
  })).toEqual({ install: { kind: "binary", builds: { aarch64: { url: "https://x/b.zip", sha256: undefined, cmd: "./b" } } }, args: ["acp"], env: undefined });
  expect(launchFromRegistry({ id: "c", name: "C", version: "1", distribution: { binary: { "darwin-aarch64": { archive: "x", cmd: "c" } } } })).toBeNull();
  expect(launchFromRegistry({ id: "d", name: "D", version: "1", distribution: { uvx: { package: "d==1" } } })?.install).toEqual({ kind: "uvx", package: "d==1" });

  // Pi installs the registry's pinned adapter plus pi itself, which the adapter runs.
  const pi = catalogLaunch(catalogEntry("acp-pi")!, [{ id: "pi-acp", name: "pi ACP", version: "0.0.34", distribution: { npx: { package: "pi-acp@0.0.34" } } }]);
  expect(pi?.install).toEqual({ kind: "npm", packages: ["pi-acp@0.0.34", "@earendil-works/pi-coding-agent"] });
  expect(pi?.homeFiles?.[".pi/agent/settings.json"]).toContain("quietStartup");
});

test("an added agent's container gets placeholders and its launch, never the key", async () => {
  await addProvider({
    id: "acp-wt-run",
    name: "Run Test",
    source: "custom",
    spec: {
      launch: { install: { kind: "script", script: "", cmd: "x" }, args: [], authMethodId: "x.key", env: { AGENT_MODE: "headless", HTTPS_PROXY: "http://evil.test" } },
      credentials: [{ env: "WT_KEY", label: "WT key", hosts: ["api.wt.test"] }],
      hosts: [],
    },
  });
  await expect(credentialFlags("acp-wt-run")).rejects.toThrow("Run Test needs a WT key");

  await setProviderCredentials("acp-wt-run", { WT_KEY: "real-wt-secret" });
  const { flags, env } = await credentialFlags("acp-wt-run");
  expect(flags).toEqual(["-e", "AGENT_MODE", "-e", "WT_KEY"]);
  expect(env).toEqual({ AGENT_MODE: "headless", WT_KEY: await providerPlaceholder("acp-wt-run", "WT_KEY") });
  expect(JSON.stringify({ flags, env })).not.toContain("real-wt-secret");

  expect(await acpLaunch("acp-wt-run")).toEqual({ name: "Run Test", command: "/opt/cloudly/agents/acp-wt-run/run", authMethodId: "x.key", homeFiles: undefined });
  expect(await acpLaunch("native-claude")).toBeUndefined();

  await updateProvider("acp-wt-run", { enabled: false });
  await expect(credentialFlags("acp-wt-run")).rejects.toThrow("turned off");
});

test("added agents' cost counts only when prices are set; their session id is read like Gemini's", () => {
  const done = { kind: "done" as const, data: { stopReason: "end_turn", usage: { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 } } };
  expect(costFromDoneEvent("acp-wt-price", done)).toBeNull();
  process.env.PRICE_ACP_WT_PRICE_INPUT_PER_MTOK = "2";
  process.env.PRICE_ACP_WT_PRICE_OUTPUT_PER_MTOK = "8";
  try {
    expect(costFromDoneEvent("acp-wt-price", done)).toEqual({ usd: 6, estimated: true });
  } finally {
    delete process.env.PRICE_ACP_WT_PRICE_INPUT_PER_MTOK;
    delete process.env.PRICE_ACP_WT_PRICE_OUTPUT_PER_MTOK;
  }
  expect(agentSessionIdFromEvent("acp-cursor", { kind: "status", data: { type: "acp.session", sessionId: "abc" } })).toBe("abc");
  expect(agentSessionIdFromEvent("something-else", { kind: "status", data: { type: "acp.session", sessionId: "abc" } })).toBeNull();
});
