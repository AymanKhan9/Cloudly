import { test, expect } from "bun:test";
import { mkdir, writeFile, symlink, readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma, putRepoFile } from "@repo/db";
import { materializeRepoFiles, syncRepoFiles, destroyFilesDir } from "../src/repo-files";

const repo = "acme/kept-files";

test("files go into /files and what the agent changed comes back; symlinks and pipes are never followed", async () => {
  await prisma.repoFile.deleteMany({ where: { repo } });
  const outside = await mkdtemp(path.join(tmpdir(), "host-secret-"));
  await writeFile(path.join(outside, "secret.key"), "HOST SECRET");
  await putRepoFile(repo, "keep.txt", new TextEncoder().encode("unchanged"));
  await putRepoFile(repo, "data/edit.csv", new TextEncoder().encode("a,b"));
  await putRepoFile(repo, "gone.txt", new TextEncoder().encode("bye"));
  const files = await materializeRepoFiles(repo);
  try {
    expect(await readFile(path.join(files.dir, "data/edit.csv"), "utf8")).toBe("a,b");

    // What an agent might leave behind.
    await writeFile(path.join(files.dir, "data/edit.csv"), "a,b\n1,2");
    await rm(path.join(files.dir, "gone.txt"));
    await mkdir(path.join(files.dir, "notes"));
    await writeFile(path.join(files.dir, "notes/plan.md"), "# plan");
    await symlink(path.join(outside, "secret.key"), path.join(files.dir, "steal.txt"));
    await symlink(outside, path.join(files.dir, "hostdir"));
    Bun.spawnSync(["mkfifo", path.join(files.dir, "pipe")]);

    const result = await syncRepoFiles(files);
    expect(result.saved.sort()).toEqual(["data/edit.csv", "notes/plan.md"]);
    expect(result.deleted).toEqual(["gone.txt"]);

    const kept = await prisma.repoFile.findMany({ where: { repo }, orderBy: { path: "asc" } });
    expect(kept.map((f) => f.path)).toEqual(["data/edit.csv", "keep.txt", "notes/plan.md"]);
    for (const f of kept) expect(Buffer.from(f.content).toString()).not.toContain("HOST SECRET");
    expect(Buffer.from(kept[0]!.content).toString()).toBe("a,b\n1,2");
  } finally {
    await destroyFilesDir(files);
    await rm(outside, { recursive: true, force: true });
    await prisma.repoFile.deleteMany({ where: { repo } });
  }
});

test("a file added by another session meanwhile isn't deleted by this one", async () => {
  await prisma.repoFile.deleteMany({ where: { repo } });
  const files = await materializeRepoFiles(repo);
  try {
    await putRepoFile(repo, "from-elsewhere.txt", new TextEncoder().encode("hi"));
    const result = await syncRepoFiles(files);
    expect(result.deleted).toEqual([]);
    expect(await prisma.repoFile.count({ where: { repo } })).toBe(1);
  } finally {
    await destroyFilesDir(files);
    await prisma.repoFile.deleteMany({ where: { repo } });
  }
});
