import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createWorkspace, destroyWorkspace, cacheKey, evictRepoCaches, touchCache, cacheLastUsed, repoCacheRoot } from "../src/workspace";
import { createFixtureRepo } from "./test-helpers";

let root: string;
const saved = process.env.CLOUDLY_REPO_CACHE;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "repo-cache-"));
  process.env.CLOUDLY_REPO_CACHE = root;
});
afterAll(async () => {
  if (saved === undefined) delete process.env.CLOUDLY_REPO_CACHE;
  else process.env.CLOUDLY_REPO_CACHE = saved;
  await rm(root, { recursive: true, force: true });
});

const commit = async (repo: string, file: string) => {
  await Bun.write(path.join(repo, file), `${file}\n`);
  await Bun.$`git -C ${repo} add -A && git -C ${repo} commit -q -m ${file}`.quiet();
  return (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
};

test("a cache key names the repo, not the token it was fetched with", () => {
  const a = cacheKey("https://x-access-token:ghs_one@github.com/acme/app.git");
  const b = cacheKey("https://x-access-token:ghs_two@github.com/Acme/app");
  expect(a).toBe(b);
  expect(a).not.toContain("ghs_");
  expect(cacheKey("https://x-access-token:t@github.com/acme/other.git")).not.toBe(a);
  expect(cacheKey("/srv/repos/app")).not.toBe(cacheKey("/srv/repos/app2"));
});

test("later turns use the cache and still see every new commit, branch and deletion", async () => {
  const fixture = await createFixtureRepo();
  const repo = fixture.repoPath;
  try {
    const first = await createWorkspace(repo);
    expect(first.cached).toBe(true);
    await destroyWorkspace(first);

    // New work on the default branch, a new branch, and a branch that goes away.
    const head = await commit(repo, "two.txt");
    await Bun.$`git -C ${repo} branch feature && git -C ${repo} branch doomed`.quiet();
    const second = await createWorkspace(repo, { branch: "doomed" });
    expect(second.cached).toBe(true);
    expect(second.baseSha).toBe(head);
    await destroyWorkspace(second);

    await Bun.$`git -C ${repo} branch -D doomed`.quiet();
    await Bun.$`git -C ${repo} checkout -q feature`.quiet();
    const featureSha = await commit(repo, "three.txt");
    const third = await createWorkspace(repo, { branch: "doomed", baseBranch: "feature" });
    try {
      expect(third.baseSha).toBe(featureSha); // doomed is gone, so it starts from feature
      expect(await Bun.file(path.join(third.runDir, "three.txt")).exists()).toBe(true);
      const branches = await Bun.$`git --git-dir=${third.mirrorDir} branch ${"--format=%(refname:short)"}`.text();
      expect(branches.split("\n")).not.toContain("doomed");
    } finally {
      await destroyWorkspace(third);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("the agent's clone shares no files with the cache, and the cache keeps no remote", async () => {
  const fixture = await createFixtureRepo();
  try {
    const ws = await createWorkspace(fixture.repoPath);
    try {
      const cacheDir = path.join(root, cacheKey(fixture.repoPath));
      const inodes = async (dir: string) =>
        new Set((await Bun.$`find ${dir} -type f -printf ${"%i\n"}`.text()).trim().split("\n").filter(Boolean));
      const cache = await inodes(path.join(cacheDir, "objects"));
      const mirror = await inodes(path.join(ws.mirrorDir, "objects"));
      const run = await inodes(path.join(ws.runDir, ".git"));
      // The mirror is hardlinked (that's the speed-up); the run clone isn't.
      expect([...mirror].some((i) => cache.has(i))).toBe(true);
      expect([...run].some((i) => cache.has(i) || mirror.has(i))).toBe(false);
      const remotes = await Bun.$`git --git-dir=${cacheDir} config --get-regexp ^remote`.nothrow().text();
      expect(remotes.trim()).toBe("");
      expect(await Bun.file(path.join(cacheDir, "FETCH_HEAD")).exists()).toBe(false);
    } finally {
      await destroyWorkspace(ws);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a broken cache falls back to a full clone and is rebuilt next turn", async () => {
  const fixture = await createFixtureRepo();
  try {
    await destroyWorkspace(await createWorkspace(fixture.repoPath));
    const cacheDir = path.join(root, cacheKey(fixture.repoPath));
    // Corrupt it: the objects are gone but the refs still point at them.
    await rm(path.join(cacheDir, "objects"), { recursive: true, force: true });
    const head = await commit(fixture.repoPath, "after.txt");

    const ws = await createWorkspace(fixture.repoPath);
    expect(ws.cached).toBe(false);
    expect(ws.baseSha).toBe(head);
    await destroyWorkspace(ws);

    const again = await createWorkspace(fixture.repoPath);
    expect(again.cached).toBe(true);
    expect(again.baseSha).toBe(head);
    await destroyWorkspace(again);
  } finally {
    await fixture.cleanup();
  }
});

test("a source that can't be reached still fails the turn, and the cache can be turned off", async () => {
  await expect(createWorkspace(path.join(root, "no-such-repo"))).rejects.toThrow();

  const fixture = await createFixtureRepo();
  process.env.CLOUDLY_REPO_CACHE = "off";
  try {
    expect(repoCacheRoot()).toBeNull();
    const ws = await createWorkspace(fixture.repoPath);
    expect(ws.cached).toBe(false);
    await destroyWorkspace(ws);
  } finally {
    process.env.CLOUDLY_REPO_CACHE = root;
    await fixture.cleanup();
  }
});

test("caches nobody has used for two weeks are removed", async () => {
  const used = await createFixtureRepo();
  const stale = await createFixtureRepo();
  try {
    await destroyWorkspace(await createWorkspace(used.repoPath));
    await destroyWorkspace(await createWorkspace(stale.repoPath));
    expect(await cacheLastUsed(stale.repoPath)).toBeInstanceOf(Date);
    await touchCache(stale.repoPath, new Date(Date.now() - 15 * 86_400_000));

    const removed = await evictRepoCaches();
    expect(removed).toEqual([cacheKey(stale.repoPath)]);
    const left = await readdir(root);
    expect(left).toContain(cacheKey(used.repoPath));
    expect(left).not.toContain(cacheKey(stale.repoPath));
  } finally {
    await used.cleanup();
    await stale.cleanup();
  }
});

test("turns on the same repo at once share the cache safely", async () => {
  const fixture = await createFixtureRepo();
  try {
    const head = await commit(fixture.repoPath, "x.txt");
    const all = await Promise.all(Array.from({ length: 4 }, () => createWorkspace(fixture.repoPath)));
    try {
      for (const ws of all) {
        expect(ws.cached).toBe(true);
        expect(ws.baseSha).toBe(head);
      }
    } finally {
      await Promise.all(all.map(destroyWorkspace));
    }
  } finally {
    await fixture.cleanup();
  }
});

test("in its container the agent has the full history but can't write the borrowed objects", async () => {
  const { runContainerCommand, sandboxUser } = await import("../src/docker");
  const { workspaceMounts } = await import("../src/workspace");
  const fixture = await createFixtureRepo();
  try {
    await commit(fixture.repoPath, "second.txt");
    const ws = await createWorkspace(fixture.repoPath);
    try {
      expect(ws.objectsDir).toBeTruthy();
      const r = await runContainerCommand([
        ...workspaceMounts(ws), "--network", "none", "--user", sandboxUser(), "cloud-agents-base", "sh", "-c",
        [
          "git -C /workspace log --oneline | wc -l",
          "git -C /workspace -c user.name=a -c user.email=a@b commit -q --allow-empty -m mine && echo committed",
          "for f in $(find /cloudly/git-objects -type f | head -3); do chmod u+w $f 2>/dev/null || echo ro; done",
          "touch /cloudly/git-objects/planted 2>/dev/null || echo ro",
        ].join("; "),
      ]);
      const lines = r.stdout.trim().split("\n");
      expect(lines[0]!.trim()).toBe("2");
      expect(lines[1]).toBe("committed");
      expect(lines.slice(2).every((l) => l === "ro")).toBe(true);
      expect(await Bun.file(path.join(ws.objectsDir!, "planted")).exists()).toBe(false);
    } finally {
      await destroyWorkspace(ws);
    }
  } finally {
    await fixture.cleanup();
  }
});
