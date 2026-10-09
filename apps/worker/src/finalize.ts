import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runContainerCommand, sandboxUser } from "./docker";
import { validatePatch } from "./patch";
import { type Workspace } from "./workspace";
import { authenticatedCloneUrl, createPullRequest, parseRepoSlug } from "./github";

const MAX_PATCH_BYTES = 10 * 1024 * 1024; // 10 MB

// Files that only exist because the agent ran something (tests, installs), on top
// of the repo's own .gitignore. Only untracked files are affected, so anything a
// repo deliberately commits still goes through.
const RUN_ARTIFACTS = [
  "__pycache__/", "*.py[cod]", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/",
  ".tox/", ".venv/", "node_modules/", ".DS_Store",
].join("\n");

export async function exportPatch(workspace: Workspace): Promise<string> {
  const outputDir = await mkdtemp(path.join(tmpdir(), "export-output-"));

  try {
    await writeFile(path.join(outputDir, "excludes"), RUN_ARTIFACTS + "\n");
    const { exitCode, stderr } = await runContainerCommand([
      "-v", `${workspace.runDir}:/workspace`,
      "-v", `${outputDir}:/output`,
      "--network", "none",
      "--user", sandboxUser(),
      "cloud-agents-base",
      "sh", "-c",
      `git -C /workspace -c core.excludesFile=/output/excludes add -A && git -C /workspace diff --binary --no-ext-diff --no-textconv --cached ${workspace.baseSha} > /output/patch.diff`,
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
  /** Defaults to agent/run-<runId>; threads keep one branch across turns. */
  branch?: string;
  runId: string;
  task: string;
  createdAt: Date;
}

export interface PublishResult {
  publishDir: string;
  commitSha: string;
  branch: string;
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
  const branch = info.branch ?? `agent/run-${info.runId}`;
  await Bun.$`git -C ${publishDir} checkout -b ${branch} ${workspace.baseSha}`;

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

  return { publishDir, commitSha, branch };
}

export async function destroyPublish(result: PublishResult): Promise<void> {
  await rm(path.dirname(result.publishDir), { recursive: true, force: true });
}

export interface PushResult {
  pushed: boolean;
}

/**
 * Checks the remote branch before pushing — per ARCHITECTURE.md §11, a
 * retried finalize must skip the push entirely if the remote already points
 * at `commitSha`, rather than attempt a second push that a non-fast-forward
 * (the deterministic commit has a fixed parent, so a real second push would
 * never be a fast-forward either) would reject.
 */
export async function pushBranch(
  publish: Pick<PublishResult, "publishDir" | "branch" | "commitSha">,
  repoSlug: string,
): Promise<PushResult> {
  const { owner, repo } = parseRepoSlug(repoSlug);
  // Same "token lives in the subprocess command line for the call's
  // duration" tradeoff `resolveCloneSource`/`createWorkspace` already
  // accept for clone — not a new exposure introduced here.
  const remoteUrl = await authenticatedCloneUrl(owner, repo);

  const lsRemote = (
    await Bun.$`git ls-remote ${remoteUrl} refs/heads/${publish.branch}`.text()
  ).trim();
  const remoteSha = lsRemote.split(/\s+/)[0];

  if (remoteSha === publish.commitSha) {
    return { pushed: false };
  }

  await Bun.$`git -C ${publish.publishDir} push ${remoteUrl} HEAD:refs/heads/${publish.branch}`;
  return { pushed: true };
}

export interface OpenPullRequestParams {
  repoSlug: string;
  baseBranch: string;
  branch: string;
  title: string;
  body?: string;
}

export interface OpenPullRequestResult {
  url: string;
  number: number;
  alreadyExisted: boolean;
}

/** Thin translation from this run's `owner/repo` slug to `createPullRequest`'s
 * split params — the idempotent-create logic itself lives in `github.ts`. */
export async function openPullRequest(
  params: OpenPullRequestParams,
): Promise<OpenPullRequestResult> {
  const { owner, repo } = parseRepoSlug(params.repoSlug);
  return createPullRequest({
    owner,
    repo,
    head: params.branch,
    base: params.baseBranch,
    title: params.title,
    body: params.body,
  });
}
