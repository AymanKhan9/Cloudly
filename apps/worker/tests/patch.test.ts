import { test, expect } from "bun:test";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { validatePatch } from "../src/patch";

const MAX_BYTES = 1024 * 1024;

test("accepts a well-formed patch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "patch-test-"));
  try {
    const goodPatch =
      "diff --git a/foo.txt b/foo.txt\n--- a/foo.txt\n+++ b/foo.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const p = path.join(dir, "good.patch");
    await writeFile(p, goodPatch);

    const content = await validatePatch(p, MAX_BYTES);
    expect(content).toBe(goodPatch);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects a symlink instead of following it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "patch-test-"));
  try {
    const target = path.join(dir, "secret.txt");
    await writeFile(target, "host secret");
    const link = path.join(dir, "symlink.patch");
    await symlink(target, link);

    await expect(validatePatch(link, MAX_BYTES)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects a FIFO without hanging", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "patch-test-"));
  try {
    const fifoPath = path.join(dir, "fifo.patch");
    await Bun.$`mkfifo ${fifoPath}`;

    const start = Date.now();
    await expect(
      Promise.race([
        validatePatch(fifoPath, MAX_BYTES),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT — HUNG")), 3000),
        ),
      ]),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(3000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);

test("rejects a patch touching a path under .git/", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "patch-test-"));
  try {
    const gitPatch =
      "diff --git a/.git/config b/.git/config\n--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-x\n+y\n";
    const p = path.join(dir, "git.patch");
    await writeFile(p, gitPatch);

    await expect(validatePatch(p, MAX_BYTES)).rejects.toThrow(/\.git\//);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects a patch larger than the size cap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "patch-test-"));
  try {
    const p = path.join(dir, "big.patch");
    await writeFile(p, "x".repeat(1000));

    await expect(validatePatch(p, 100)).rejects.toThrow(/size cap/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
