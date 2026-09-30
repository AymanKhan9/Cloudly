import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runContainerCommand } from "./docker";
import { validatePatch } from "./patch";
import { type Workspace } from "./workspace";

const MAX_PATCH_BYTES = 10 * 1024 * 1024; // 10 MB

export async function exportPatch(workspace: Workspace): Promise<string> {
  const outputDir = await mkdtemp(path.join(tmpdir(), "export-output-"));

  try {
    const { exitCode, stderr } = await runContainerCommand([
      "-v", `${workspace.runDir}:/workspace`,
      "-v", `${outputDir}:/output`,
      "--network", "none",
      "--user", "1000:1000",
      "cloud-agents-base",
      "sh", "-c",
      `git -C /workspace add -A && git -C /workspace diff --binary --no-ext-diff --no-textconv --cached ${workspace.baseSha} > /output/patch.diff`,
    ]);

    if (exitCode !== 0) {
      throw new Error(`export container exited with code ${exitCode}: ${stderr}`);
    }

    return await validatePatch(path.join(outputDir, "patch.diff"), MAX_PATCH_BYTES);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

export interface CommitInfo {
  runId: string;
  task: string;
  createdAt: Date;
}

export interface PublishResult {
  publishDir: string;
  commitSha: string;
}

const GIT_IDENTITY = {
  name: "Cloud Agents",
  email: "agent@cloud-agents.local",
};

export async function publishCommit(
  workspace: Workspace,
  patch: string,
  info: CommitInfo,
): Promise<PublishResult> {
  const scratchDir = await mkdtemp(path.join(tmpdir(), "publish-"));
  const publishDir = path.join(scratchDir, "publish");
  const patchFile = path.join(scratchDir, "patch.diff");

  // Fresh clone from the mirror only — never the run clone, never mounted
  // into any container. This is the one directory the host is allowed to
  // run git in directly (see ARCHITECTURE.md §11).
  await Bun.$`git clone --no-hardlinks ${workspace.mirrorDir} ${publishDir}`;

  // Checkout base_sha detached, then branch — never the mirror's current
  // default branch, which may have moved since the run started.
  await Bun.$`git -C ${publishDir} checkout -b agent/run-${info.runId} ${workspace.baseSha}`;

  await writeFile(patchFile, patch, "utf-8");
  await Bun.$`git -C ${publishDir} apply --index ${patchFile}`;

  const isoDate = info.createdAt.toISOString();

  const commitProc = Bun.spawn(
    [
      "git", "-C", publishDir,
      "-c", `user.name=${GIT_IDENTITY.name}`,
      "-c", `user.email=${GIT_IDENTITY.email}`,
      "commit", "-m", `Agent run ${info.runId}: ${info.task}`,
    ],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: GIT_IDENTITY.name,
        GIT_AUTHOR_EMAIL: GIT_IDENTITY.email,
        GIT_AUTHOR_DATE: isoDate,
        GIT_COMMITTER_NAME: GIT_IDENTITY.name,
        GIT_COMMITTER_EMAIL: GIT_IDENTITY.email,
        GIT_COMMITTER_DATE: isoDate,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const commitExit = await commitProc.exited;
  if (commitExit !== 0) {
    const stderr = await new Response(commitProc.stderr).text();
    throw new Error(`git commit failed: ${stderr}`);
  }

  const commitSha = (await Bun.$`git -C ${publishDir} rev-parse HEAD`.text()).trim();

  return { publishDir, commitSha };
}

export async function destroyPublish(result: PublishResult): Promise<void> {
  await rm(path.dirname(result.publishDir), { recursive: true, force: true });
}
