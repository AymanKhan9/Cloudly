import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { PublishResult } from "./finalize";

// A session without a project (a repository) still has a folder that keeps
// what the agent made from turn to turn: a git repo of its own on this server,
// never pushed anywhere, with no pull request and no checks.

/** What a session without a project has as its repo. */
export const NO_PROJECT = "";
export const SCRATCH_BRANCH = "main";

const dataDir = () => process.env.CLOUDLY_DATA_DIR ?? path.join(homedir(), ".cloudly");
export const scratchPath = (threadId: string) => path.join(dataDir(), "scratch", `${threadId}.git`);

/** The session's own repo, made (with one empty commit on main) the first time. */
export async function scratchRepo(threadId: string): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error(`invalid session id: ${threadId}`);
  const dir = scratchPath(threadId);
  if (existsSync(path.join(dir, "HEAD"))) return dir;
  await mkdir(path.dirname(dir), { recursive: true });
  await Bun.$`git init -q --bare -b ${SCRATCH_BRANCH} ${dir}`.quiet();
  const work = await mkdtemp(path.join(tmpdir(), "scratch-init-"));
  try {
    await Bun.$`git init -q -b ${SCRATCH_BRANCH} ${work}`.quiet();
    await Bun.$`git -C ${work} -c user.name=Cloudly -c user.email=agent@cloud-agents.local commit -q --allow-empty -m ${"A session without a project"}`.quiet();
    await Bun.$`git -C ${work} push -q ${dir} HEAD:refs/heads/${SCRATCH_BRANCH}`.quiet();
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return dir;
}

/** Keeps a turn's commit in the session's own repo, for its next turn. */
export async function pushScratch(publish: Pick<PublishResult, "publishDir" | "branch">, threadId: string): Promise<void> {
  await Bun.$`git -C ${publish.publishDir} push -q ${scratchPath(threadId)} HEAD:refs/heads/${publish.branch}`.quiet();
}
