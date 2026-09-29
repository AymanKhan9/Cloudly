import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Workspace {
  scratchDir: string;
  mirrorDir: string;
  runDir: string;
  baseSha: string;
}

export async function createWorkspace(
  repoPath: string,
): Promise<Workspace> {
  const scratchDir = await mkdtemp(
    path.join(tmpdir(), "workspace-"),
  );

  const mirrorDir = path.join(scratchDir, "mirror");
  const runDir = path.join(scratchDir, "run");

  try {
    // Create the bare mirror.
    await Bun.$`git clone --bare --no-hardlinks ${repoPath} ${mirrorDir}`;

    // Record the exact starting commit.
    const baseSha = (
      await Bun.$`git --git-dir=${mirrorDir} rev-parse HEAD`.text()
    ).trim();

    // Create the working clone.
    await Bun.$`git clone --no-hardlinks ${mirrorDir} ${runDir}`;

    return {
      scratchDir,
      mirrorDir,
      runDir,
      baseSha,
    };
  } catch (error) {
    await rm(scratchDir, {
      recursive: true,
      force: true,
    });

    throw error;
  }
}

export async function destroyWorkspace(
  workspace: Workspace,
): Promise<void> {
  await rm(workspace.scratchDir, {
    recursive: true,
    force: true,
  });
}