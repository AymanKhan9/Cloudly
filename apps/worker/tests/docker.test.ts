import { test, expect } from "bun:test";

import { credentialFlags, runnerMountFlags, SANDBOX_LIMITS } from "../src/docker";

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

test("model keys are passed by name, with the value only in the docker client's env", async () => {
  process.env.GEMINI_API_KEY = "sk-test-not-on-argv";
  try {
    const { flags, env } = await credentialFlags("gemini-acp");
    expect(flags).toContain("GEMINI_API_KEY");
    expect(flags.join(" ")).not.toContain("sk-test-not-on-argv");
    expect(env.GEMINI_API_KEY).toBe("sk-test-not-on-argv");
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
