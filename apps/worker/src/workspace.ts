import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Workspace {
  scratchDir: string;
  mirrorDir: string;
  runDir: string;
  baseSha: string;
}

export interface WorkspaceStart {
  /** A thread's branch from an earlier turn; wins when it exists. */
  branch?: string;
  /** The branch the user asked to build on. */
  baseBranch?: string;
}

async function branchExists(mirrorDir: string, name: string): Promise<boolean> {
  const r = await Bun.$`git --git-dir=${mirrorDir} rev-parse --verify --quiet refs/heads/${name}`.nothrow().quiet();
  return r.exitCode === 0;
}

export async function createWorkspace(
  repoPath: string,
  start: WorkspaceStart = {},
): Promise<Workspace> {
  const scratchDir = await mkdtemp(
    path.join(tmpdir(), "workspace-"),
  );

  const mirrorDir = path.join(scratchDir, "mirror");
  const runDir = path.join(scratchDir, "run");

  try {
    // Create the bare mirror.
    await Bun.$`git clone --bare --no-hardlinks ${repoPath} ${mirrorDir}`;

    // Start from the thread's branch if an earlier turn pushed one, else the
    // requested base branch, else whatever the mirror's HEAD is.
    let startBranch: string | undefined;
    for (const candidate of [start.branch, start.baseBranch]) {
      if (candidate && (await branchExists(mirrorDir, candidate))) {
        startBranch = candidate;
        break;
      }
    }

    // Record the exact starting commit.
    const baseSha = (
      await Bun.$`git --git-dir=${mirrorDir} rev-parse ${startBranch ? `refs/heads/${startBranch}` : "HEAD"}`.text()
    ).trim();

    // Create the working clone.
    await Bun.$`git clone --no-hardlinks ${mirrorDir} ${runDir}`;
    if (startBranch) {
      await Bun.$`git -C ${runDir} checkout -q -B ${startBranch} ${baseSha}`;
    }

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