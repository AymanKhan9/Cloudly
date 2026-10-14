import { test, expect } from "bun:test";

import { credentialFlags, runnerMountFlags, SANDBOX_LIMITS, sandboxUser } from "../src/docker";

test("the sandbox never sees the install dir, only read-only runner pieces", () => {
  const flags = runnerMountFlags("/opt/cloudly");
  const mounts = flags.filter((f) => f !== "-v");

  for (const m of mounts) {
    const [source, target, mode] = m.split(":");
    expect(mode).toBe("ro");
    expect(source).not.toBe("/opt/cloudly");
    expect(source).not.toContain(".env");
    expect(target!.startsWith("/repo/")).toBe(true);
  }
  expect(mounts).not.toContain("/opt/cloudly:/repo:ro");
});

test("the container gets a placeholder and the gateway address, never the real key", async () => {
  process.env.GEMINI_API_KEY = "real-key-must-not-reach-the-container";
  try {
    const { flags, env } = await credentialFlags("gemini-acp");
    const all = flags.join(" ") + JSON.stringify(env);
    expect(all).not.toContain("real-key-must-not-reach-the-container");
    expect(flags).toContain("GEMINI_API_KEY=cloudly-placeholder");
    expect(flags.some((f) => f.startsWith("GOOGLE_GEMINI_BASE_URL=http://cloudly-egress:3129/gemini"))).toBe(true);
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

test("every sandbox gets memory, process and privilege limits", () => {
  for (const flag of ["--memory", "--pids-limit", "--cap-drop", "--security-opt"]) {
    expect(SANDBOX_LIMITS).toContain(flag);
  }
  expect(SANDBOX_LIMITS).toContain("no-new-privileges");
});

test("the sandbox runs as the worker's own uid, so it can write the workspace", () => {
  expect(sandboxUser()).toBe(`${process.getuid!()}:${process.getgid!()}`);
});
