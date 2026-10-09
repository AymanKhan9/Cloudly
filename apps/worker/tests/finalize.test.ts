import { test, expect } from "bun:test";
import path from "node:path";
import { tmpdir } from "node:os";

import { createWorkspace, destroyWorkspace } from "../src/workspace";
import { exportPatch, publishCommit, destroyPublish, type CommitInfo } from "../src/finalize";
import { createFixtureRepo } from "./test-helpers";

test("exportPatch captures modified and new files", async () => {
  const fixture = await createFixtureRepo();
  try {
    const ws = await createWorkspace(fixture.repoPath);
    try {
      await Bun.write(
        path.join(ws.runDir, "README.md"),
        (await Bun.file(path.join(ws.runDir, "README.md")).text()) + "edit\n",
      );
      await Bun.write(path.join(ws.runDir, "new-file.txt"), "hello\n");

      const patch = await exportPatch(ws);

      expect(patch).toContain("README.md");
      expect(patch).toContain("new-file.txt");
      expect(patch).toContain("+edit");
    } finally {
      await destroyWorkspace(ws);
    }
  } finally {
    await fixture.cleanup();
  }
}, 30000);

test("exportPatch leaves out caches the agent created by running code", async () => {
  const fixture = await createFixtureRepo();
  try {
    const ws = await createWorkspace(fixture.repoPath);
    try {
      await Bun.write(path.join(ws.runDir, "pkg/core.py"), "def f():\n    return 1\n");
      await Bun.write(path.join(ws.runDir, "pkg/__pycache__/core.cpython-311.pyc"), "bytecode");
      await Bun.write(path.join(ws.runDir, ".pytest_cache/v/cache/lastfailed"), "{}");

      const patch = await exportPatch(ws);

      expect(patch).toContain("pkg/core.py");
      expect(patch).not.toContain("__pycache__");
      expect(patch).not.toContain(".pytest_cache");
    } finally {
      await destroyWorkspace(ws);
    }
  } finally {
    await fixture.cleanup();
  }
}, 30000);

test("publishCommit is deterministic given the same inputs", async () => {
  const fixture = await createFixtureRepo();
  try {
    const ws = await createWorkspace(fixture.repoPath);
    try {
      await Bun.write(path.join(ws.runDir, "new-file.txt"), "hello\n");
      const patch = await exportPatch(ws);

      const info: CommitInfo = {
        runId: "det-test",
        task: "add a file",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      };

      const r1 = await publishCommit(ws, patch, info);
      const r2 = await publishCommit(ws, patch, info);

      try {
        expect(r1.commitSha).toBe(r2.commitSha);
      } finally {
        await destroyPublish(r1);
        await destroyPublish(r2);
      }
    } finally {
      await destroyWorkspace(ws);
    }
  } finally {
    await fixture.cleanup();
  }
}, 30000);

test("core.fsmonitor planted in the run clone never executes on the host", async () => {
  const fixture = await createFixtureRepo();
  try {
    const ws = await createWorkspace(fixture.repoPath);
    try {
      // Simulates a malicious/prompt-injected agent planting a command in
      // the run clone's own git config — the exact attack class §11 exists
      // to close off. The marker lives on the HOST's tmpdir, not inside any
      // container, so this only trips if a host process actually executes it.
      const marker = path.join(tmpdir(), `fsmonitor-marker-${crypto.randomUUID()}`);
      await Bun.$`git -C ${ws.runDir} config core.fsmonitor "touch ${marker}"`;

      await Bun.write(path.join(ws.runDir, "new-file.txt"), "hello\n");
      const patch = await exportPatch(ws);

      const info: CommitInfo = {
        runId: crypto.randomUUID(),
        task: "fsmonitor safety test",
        createdAt: new Date(),
      };
      const result = await publishCommit(ws, patch, info);

      try {
        const triggered = await Bun.file(marker).exists();
        expect(triggered).toBe(false);
      } finally {
        await destroyPublish(result);
      }
    } finally {
      await destroyWorkspace(ws);
    }
  } finally {
    await fixture.cleanup();
  }
}, 30000);
