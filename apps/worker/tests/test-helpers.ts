import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FixtureRepo {
  repoPath: string;
  cleanup: () => Promise<void>;
}

export async function createFixtureRepo(): Promise<FixtureRepo> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "fixture-repo-"));

  await Bun.$`git init -q ${repoPath}`;
  await Bun.$`git -C ${repoPath} config user.name "Test"`;
  await Bun.$`git -C ${repoPath} config user.email "test@example.com"`;
  await Bun.write(path.join(repoPath, "README.md"), "# fixture\n");
  await Bun.$`git -C ${repoPath} add -A`;
  await Bun.$`git -C ${repoPath} commit -q -m "initial commit"`;

  return {
    repoPath,
    cleanup: () => rm(repoPath, { recursive: true, force: true }),
  };
}
