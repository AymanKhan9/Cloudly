import { test, expect } from "bun:test";
import { pinInstall, launchVersion, sameLaunch, splitPackage, parseRegistry } from "../src/agent-updates";

test("unpinned npm packages are pinned to their latest release; pinned ones and other installs are left", async () => {
  const latest = async (name: string) => ({ "@earendil-works/pi-coding-agent": "1.5.0", "range-pkg": "2.0.1" } as Record<string, string>)[name] ?? null;
  expect(await pinInstall({ kind: "npm", packages: ["pi-acp@0.0.35", "@earendil-works/pi-coding-agent", "range-pkg@^2", "unknown-pkg"] }, latest)).toEqual({
    kind: "npm",
    packages: ["pi-acp@0.0.35", "@earendil-works/pi-coding-agent@1.5.0", "range-pkg@2.0.1", "unknown-pkg"],
  });
  const binary = { kind: "binary" as const, builds: { x86_64: { url: "https://x/a.tgz", sha256: "ab", cmd: "a" } } };
  expect(await pinInstall(binary, latest)).toBe(binary);
  expect(splitPackage("@scope/pkg")).toEqual(["@scope/pkg", null]);
  expect(splitPackage("@scope/pkg@1.2.3")).toEqual(["@scope/pkg", "1.2.3"]);
});

test("versions read the way people know them, and launches compare by what they install", () => {
  const pi = { install: { kind: "npm" as const, packages: ["pi-acp@0.0.35", "@earendil-works/pi-coding-agent@1.5.0"] }, args: [] };
  expect(launchVersion(pi, "0.0.35")).toBe("0.0.35 · pi-coding-agent 1.5.0");
  expect(launchVersion({ install: { kind: "binary", builds: {} }, args: [] }, "1.19.6")).toBe("1.19.6");
  expect(sameLaunch(pi, { ...pi, env: {} })).toBe(true);
  // Keys in another order (as Postgres jsonb returns them) are the same launch.
  expect(sameLaunch({ install: { kind: "binary", builds: { x86_64: { url: "u", sha256: "s", cmd: "c" } } }, args: [] }, { args: [], install: { builds: { x86_64: { cmd: "c", sha256: "s", url: "u" } }, kind: "binary" } } as never)).toBe(true);
  expect(sameLaunch(pi, { ...pi, install: { kind: "npm", packages: ["pi-acp@0.0.36", "@earendil-works/pi-coding-agent@1.5.0"] } })).toBe(false);
  expect(parseRegistry({ agents: [{ id: "ok", name: "Ok", version: "1", distribution: {} }, { id: "bad id!" }] }).map((a) => a.id)).toEqual(["ok"]);
});
