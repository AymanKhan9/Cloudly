import { test, expect, afterAll } from "bun:test";
import { prisma, checkProviderUpdates, settleProviderUpdates, installAvailableUpdate, providerInstallScript, type UpdateSources } from "@repo/db";
import type { RegistryAgent } from "@repo/shared/providers";

const stamp = Date.now();
const ids: string[] = [];
afterAll(async () => {
  await prisma.provider.deleteMany({ where: { id: { in: ids } } });
});

let registry: RegistryAgent[] = [];
let npm: Record<string, string> = {};
const src: UpdateSources = { registry: async () => registry, npmLatest: async (name) => npm[name] ?? null };
const piRegistry = (v: string): RegistryAgent => ({ id: "pi-acp", name: "pi ACP", version: v, distribution: { npx: { package: `pi-acp@${v}` } } });
const binRegistry = (v: string, sha: string): RegistryAgent => ({
  id: `bin-agent-${stamp}`, name: "Bin", version: v, distribution: { binary: { "linux-x86_64": { archive: `https://example.com/bin-${v}.tgz`, cmd: "./bin", sha256: sha, args: ["acp"] } } },
});

async function addPi(suffix: string, extra: object = {}) {
  const id = `acp-upd-${stamp}-${suffix}`;
  ids.push(id);
  return prisma.provider.create({
    data: {
      id, name: "Pi", source: "catalog", sourceId: "acp-pi", version: "0.0.34",
      spec: { launch: { install: { kind: "npm", packages: ["pi-acp@0.0.34", "@earendil-works/pi-coding-agent"] }, args: [], env: {}, homeFiles: {} }, credentials: [], hosts: [] },
      ...extra,
    },
  });
}
const mine = <T extends { id: string }>(results: T[]) => results.filter((r) => ids.includes(r.id));
const row = (id: string) => prisma.provider.findUniqueOrThrow({ where: { id } });

test("a newer version is installed through the image, and one that fails to install is rolled back and skipped", async () => {
  const pi = await addPi("a");
  registry = [piRegistry("0.0.35")];
  npm = { "@earendil-works/pi-coding-agent": "1.5.0" };

  const first = mine(await checkProviderUpdates(src));
  expect(first).toEqual([{ id: pi.id, from: "0.0.34", to: "0.0.35 · pi-coding-agent 1.5.0", outcome: "installing" }]);
  let r = await row(pi.id);
  expect((r.spec as any).launch.install.packages).toEqual(["pi-acp@0.0.35", "@earendil-works/pi-coding-agent@1.5.0"]);
  expect(r).toMatchObject({ updateState: "updating", previousVersion: "0.0.34" });
  // The image's install script changes, so the worker rebuilds the image.
  expect(await providerInstallScript()).toContain("pi-acp@0.0.35");
  // While it builds, checks leave it alone.
  expect(mine(await checkProviderUpdates(src))).toEqual([]);

  // The build log says it didn't install: back on 0.0.34, and 0.0.35 skipped.
  const settled = await settleProviderUpdates({ ok: true, log: `...\ncloudly: ${pi.id} failed to install; the rest of the image is unaffected\n...` });
  expect(settled.rolledBack).toContain(pi.id);
  r = await row(pi.id);
  expect((r.spec as any).launch.install.packages).toEqual(["pi-acp@0.0.34", "@earendil-works/pi-coding-agent"]);
  expect(r).toMatchObject({ version: "0.0.34", updateState: "failed", skipVersion: "0.0.35 · pi-coding-agent 1.5.0" });
  expect(r.updateNote).toContain("didn't install");
  expect(mine(await checkProviderUpdates(src))).toEqual([{ id: pi.id, from: "0.0.34", to: "0.0.35 · pi-coding-agent 1.5.0", outcome: "skipped" }]);

  // The next release installs, and the build settles it.
  registry = [piRegistry("0.0.36")];
  expect(mine(await checkProviderUpdates(src))[0]).toMatchObject({ outcome: "installing", to: "0.0.36 · pi-coding-agent 1.5.0" });
  await settleProviderUpdates({ ok: true, log: "all good" });
  r = await row(pi.id);
  expect(r).toMatchObject({ updateState: "updated", version: "0.0.36 · pi-coding-agent 1.5.0", previousLaunch: null });
  expect(r.updateNote).toBe("Updated from 0.0.34 to 0.0.36 · pi-coding-agent 1.5.0.");

  // Nothing newer: just checked.
  expect(mine(await checkProviderUpdates(src))).toEqual([]);
  expect((await row(pi.id)).checkedAt).toBeInstanceOf(Date);
});

test("with auto-update off a newer version waits for the Update button; a build that fails for another reason doesn't skip it", async () => {
  const pi = await addPi("b", { autoUpdate: false });
  registry = [piRegistry("0.0.40")];
  npm = { "@earendil-works/pi-coding-agent": "1.6.0" };
  expect(mine(await checkProviderUpdates(src)).find((r) => r.id === pi.id)).toMatchObject({ outcome: "available", to: "0.0.40 · pi-coding-agent 1.6.0" });
  let r = await row(pi.id);
  expect(r).toMatchObject({ availableVersion: "0.0.40 · pi-coding-agent 1.6.0", version: "0.0.34", updateState: null });

  expect(await installAvailableUpdate(pi.id)).toBe(true);
  expect((await row(pi.id)).updateState).toBe("updating");
  // The whole build failed (the setup script, say): back to the old version, but not skipped.
  await settleProviderUpdates({ ok: false, log: "setup.sh: line 3: oops" });
  r = await row(pi.id);
  expect(r).toMatchObject({ version: "0.0.34", updateState: "failed", skipVersion: null });
  expect(r.updateNote).toContain("will be tried again");
  expect(await installAvailableUpdate(pi.id)).toBe(false);
});

test("registry binaries update when their build changes; agents added by command never do", async () => {
  registry = [binRegistry("1.0.0", "aaa")];
  const id = `acp-upd-${stamp}-bin`;
  ids.push(id);
  await prisma.provider.create({
    data: { id, name: "Bin", source: "registry", sourceId: `bin-agent-${stamp}`, version: "1.0.0", spec: { launch: { install: { kind: "binary", builds: { x86_64: { url: "https://example.com/bin-1.0.0.tgz", sha256: "aaa", cmd: "./bin" } } }, args: ["acp"] }, credentials: [], hosts: [] } },
  });
  const custom = `acp-upd-${stamp}-custom`;
  ids.push(custom);
  await prisma.provider.create({ data: { id: custom, name: "Mine", source: "custom", spec: { launch: { install: { kind: "script", script: "true", cmd: "/bin/true" }, args: [] }, credentials: [], hosts: [] } } });

  expect(mine(await checkProviderUpdates(src)).filter((r) => r.id === id)).toEqual([]);
  registry = [binRegistry("1.1.0", "bbb")];
  expect(mine(await checkProviderUpdates(src)).filter((r) => r.id === id)).toEqual([{ id, from: "1.0.0", to: "1.1.0", outcome: "installing" }]);
  expect((await row(id)).spec).toMatchObject({ launch: { install: { builds: { x86_64: { sha256: "bbb" } } } } });
  expect(await row(custom)).toMatchObject({ updateState: null, checkedAt: null });
});
