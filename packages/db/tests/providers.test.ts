import { test, expect, afterAll } from "bun:test";
import {
  prisma, addProvider, listProviders, getProvider, setProviderCredentials, removeProviderCredential, updateProvider,
  deleteProvider, providerRunCredentials, providerProxySecrets, providerHosts, providerInstallScript, providerPlaceholder,
  providerEnvProblem, harnessAvailable, setSetting, deleteSetting, getSetting,
} from "../src";
import type { ProviderSpec } from "@repo/shared/providers";

const spec = (over: Partial<ProviderSpec> = {}): ProviderSpec => ({
  launch: { install: { kind: "npm", packages: ["some-agent@1.0.0"] }, args: ["acp"] },
  credentials: [{ env: "T_AGENT_KEY", label: "Agent key", hosts: ["https://api.agent.test/v1"] }],
  hosts: ["login.agent.test"],
  ...over,
});

afterAll(async () => {
  await prisma.provider.deleteMany({ where: { id: { startsWith: "acp-t-" } } });
});

test("a key can't take a variable that steers the sandbox, and needs hosts to go to", async () => {
  expect(providerEnvProblem("XAI_API_KEY")).toBeNull();
  expect(providerEnvProblem("ANTHROPIC_API_KEY")).toBeNull();
  for (const name of ["HTTPS_PROXY", "NODE_OPTIONS", "LD_PRELOAD", "PATH", "SSL_CERT_FILE", "CLOUDLY_SECRET_KEY"]) {
    expect(providerEnvProblem(name)).toContain("can't hold a key");
  }
  await expect(addProvider({ id: "acp-t-nohosts", name: "x", source: "custom", spec: spec({ credentials: [{ env: "T_K", label: "k", hosts: [] }] }) })).rejects.toThrow("Name the hosts");
  await expect(addProvider({ id: "bad id", name: "x", source: "custom", spec: spec() })).rejects.toThrow();
});

test("keys are stored encrypted, shown by their last four characters, and given to runs as placeholders", async () => {
  await addProvider({ id: "acp-t-one", name: "One", source: "catalog", spec: spec() });
  await expect(addProvider({ id: "acp-t-one", name: "One", source: "catalog", spec: spec() })).rejects.toThrow("already added");

  let view = (await getProvider("acp-t-one"))!;
  expect(view.missing).toEqual(["T_AGENT_KEY"]);
  expect(view.spec.credentials[0]!.hosts).toEqual(["api.agent.test"]);

  // Whitespace from a wrapped terminal line is dropped.
  await setProviderCredentials("acp-t-one", { T_AGENT_KEY: "sk-real-\nvalue-1234" });
  const row = await prisma.provider.findUnique({ where: { id: "acp-t-one" } });
  expect(row!.secret).not.toContain("value-1234");
  view = (await getProvider("acp-t-one"))!;
  expect(view.missing).toEqual([]);
  expect(view.credentials[0]).toMatchObject({ set: true, preview: "…1234" });
  expect(JSON.stringify(await listProviders())).not.toContain("sk-real-value-1234");

  const { resolved } = await providerRunCredentials("acp-t-one");
  expect(resolved[0]!.value).toBe("sk-real-value-1234");
  expect(resolved[0]!.placeholder).toBe(await providerPlaceholder("acp-t-one", "T_AGENT_KEY"));
  expect(resolved[0]!.placeholder).toMatch(/^cloudly-secret-[0-9a-f]{24}$/);
  // Another agent's same variable gets a different placeholder, so it can't ask for this key.
  expect(await providerPlaceholder("acp-t-two", "T_AGENT_KEY")).not.toBe(resolved[0]!.placeholder);

  const proxy = (await providerProxySecrets()).find((s) => s.placeholder === resolved[0]!.placeholder);
  expect(proxy).toEqual({ placeholder: resolved[0]!.placeholder, value: "sk-real-value-1234", hosts: ["api.agent.test"] });
  expect(await providerHosts()).toContain("login.agent.test");

  // Turned off: no keys at the proxy, no hosts, and not a harness sessions may pick.
  await updateProvider("acp-t-one", { enabled: false });
  expect((await providerProxySecrets()).some((s) => s.placeholder === resolved[0]!.placeholder)).toBe(false);
  expect(await providerHosts()).not.toContain("login.agent.test");
  expect(await harnessAvailable("acp-t-one", ["native-claude"])).toBe(false);
  await updateProvider("acp-t-one", { enabled: true });
  expect(await harnessAvailable("acp-t-one", ["native-claude"])).toBe(true);
  expect(await harnessAvailable("native-claude", ["native-claude"])).toBe(true);
  expect(await harnessAvailable("acp-t-nope", ["native-claude"])).toBe(false);

  await setProviderCredentials("acp-t-one", { T_AGENT_KEY: null });
  expect((await getProvider("acp-t-one"))!.missing).toEqual(["T_AGENT_KEY"]);
  await expect(setProviderCredentials("acp-t-one", { OTHER: "x" })).rejects.toThrow("isn't one of this agent's keys");
});

test("an optional key falls back to the Settings key it reuses", async () => {
  const before = await getSetting("OPENAI_API_KEY");
  try {
    await setSetting("OPENAI_API_KEY", "sk-from-settings-9876");
    await addProvider({
      id: "acp-t-reuse",
      name: "Reuse",
      source: "catalog",
      spec: spec({ credentials: [{ env: "OPENAI_API_KEY", label: "OpenAI", hosts: ["api.openai.com"], optional: true, reuse: "OPENAI_API_KEY" }] }),
    });
    const view = (await getProvider("acp-t-reuse"))!;
    expect(view.credentials[0]).toMatchObject({ set: false, reused: true });
    expect((await providerRunCredentials("acp-t-reuse")).resolved[0]!.value).toBe("sk-from-settings-9876");
    // Its own value wins.
    await setProviderCredentials("acp-t-reuse", { OPENAI_API_KEY: "sk-own-1111" });
    expect((await providerRunCredentials("acp-t-reuse")).resolved[0]!.value).toBe("sk-own-1111");
  } finally {
    if (before) await setSetting("OPENAI_API_KEY", before);
    else await deleteSetting("OPENAI_API_KEY");
  }
});

test("registry and custom agents define their own keys; removing one drops its value", async () => {
  await addProvider({ id: "acp-t-custom", name: "Custom", source: "custom", spec: spec({ credentials: [] }) });
  await setProviderCredentials("acp-t-custom", { MY_KEY: "secret-5555" }, [{ env: "MY_KEY", hosts: ["api.mine.test"] }]);
  let view = (await getProvider("acp-t-custom"))!;
  expect(view.credentials).toEqual([expect.objectContaining({ env: "MY_KEY", hosts: ["api.mine.test"], set: true })]);
  await expect(setProviderCredentials("acp-t-custom", {}, [{ env: "HTTPS_PROXY", hosts: ["x.test"] }])).rejects.toThrow("can't hold a key");
  await removeProviderCredential("acp-t-custom", "MY_KEY");
  view = (await getProvider("acp-t-custom"))!;
  expect(view.credentials).toEqual([]);
  expect((await prisma.provider.findUnique({ where: { id: "acp-t-custom" } }))!.secret).toBeNull();
});

test("every added agent is in the image build, turned off or not, until it's removed", async () => {
  await addProvider({ id: "acp-t-build", name: "Build", source: "custom", spec: spec() });
  await updateProvider("acp-t-build", { enabled: false });
  expect(await providerInstallScript()).toContain("# cloudly-agent:acp-t-build");
  await deleteProvider("acp-t-build");
  expect(await providerInstallScript()).not.toContain("# cloudly-agent:acp-t-build");
});
