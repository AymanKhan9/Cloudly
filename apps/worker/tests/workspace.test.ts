import { test, expect } from "bun:test";

import { createWorkspace, destroyWorkspace } from "../src/workspace";
import { createFixtureRepo } from "./test-helpers";

test("creates a workspace with a real base_sha and a usable run clone", async () => {
  const fixture = await createFixtureRepo();
  try {
    const ws = await createWorkspace(fixture.repoPath);
    try {
      expect(ws.baseSha).toMatch(/^[0-9a-f]{40}$/);

      const files = await Bun.$`ls ${ws.runDir}`.text();
      expect(files).toContain("README.md");
    } finally {
      await destroyWorkspace(ws);
    }

    const stillExists = await Bun.$`test -d ${ws.scratchDir} && echo yes || echo no`.text();
    expect(stillExists.trim()).toBe("no");
  } finally {
    await fixture.cleanup();
  }
});

test("--no-hardlinks gives the mirror separate inodes from the source repo", async () => {
  const fixture = await createFixtureRepo();
  try {
    const ws = await createWorkspace(fixture.repoPath);
    try {
      const objectFile = (
        await Bun.$`find ${fixture.repoPath}/.git/objects -type f`.text()
      )
        .trim()
        .split("\n")[0];
      expect(objectFile).toBeTruthy();

      const relative = path_relative_to_objects(objectFile!, fixture.repoPath);
      const mirrorObjectFile = `${ws.mirrorDir}/objects/${relative}`;

      const origInode = (await Bun.$`stat -c %i ${objectFile}`.text()).trim();
      const mirrorInode = (await Bun.$`stat -c %i ${mirrorObjectFile}`.text()).trim();

      expect(mirrorInode).not.toBe(origInode);
    } finally {
      await destroyWorkspace(ws);
    }
  } finally {
    await fixture.cleanup();
  }
});

function path_relative_to_objects(objectFile: string, repoPath: string): string {
  const prefix = `${repoPath}/.git/objects/`;
  if (!objectFile.startsWith(prefix)) {
    throw new Error(`unexpected object path: ${objectFile}`);
  }
  return objectFile.slice(prefix.length);
}

test("continues from the thread's branch when an earlier turn pushed one", async () => {
  const fixture = await createFixtureRepo();
  try {
    await Bun.$`git -C ${fixture.repoPath} checkout -q -b agent/thread-abc`;
    await Bun.write(`${fixture.repoPath}/turn1.txt`, "from turn one\n");
    await Bun.$`git -C ${fixture.repoPath} add -A`;
    await Bun.$`git -C ${fixture.repoPath} commit -q -m "turn one"`;
    const turnOneSha = (await Bun.$`git -C ${fixture.repoPath} rev-parse HEAD`.text()).trim();
    await Bun.$`git -C ${fixture.repoPath} checkout -q -`;

    const ws = await createWorkspace(fixture.repoPath, { branch: "agent/thread-abc" });
    try {
      expect(ws.baseSha).toBe(turnOneSha);
      expect(await Bun.file(`${ws.runDir}/turn1.txt`).text()).toBe("from turn one\n");
    } finally {
      await destroyWorkspace(ws);
    }

    // A thread branch nobody pushed yet falls back to the base branch.
    const first = await createWorkspace(fixture.repoPath, { branch: "agent/thread-new" });
    try {
      expect(await Bun.file(`${first.runDir}/turn1.txt`).exists()).toBe(false);
    } finally {
      await destroyWorkspace(first);
    }
  } finally {
    await fixture.cleanup();
  }
});
