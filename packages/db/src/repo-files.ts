import { createHash } from "node:crypto";
import { prisma } from "./client";

// A repo's files outside git: datasets, fixtures, a local config, notes the
// agent keeps between sessions. They live in Postgres, so the API (which has no
// access to the worker's disk) can take uploads, and the worker copies them into
// /files for each run and saves back what the agent left there.

export const REPO_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const REPO_FILES_MAX_TOTAL = 200 * 1024 * 1024;
export const REPO_FILES_MAX_COUNT = 1000;

/**
 * A relative path with plain segments only: no "..", no absolute paths, no
 * empty or dot segments, no control characters. Returns the normalized path or null.
 */
export function cleanFilePath(input: string): string | null {
  const parts = input.replace(/\\/g, "/").split("/").filter((p) => p !== "");
  if (parts.length === 0 || parts.length > 16) return null;
  for (const p of parts) {
    if (p === "." || p === ".." || p.length > 200 || /[\x00-\x1f\x7f]/.test(p)) return null;
  }
  const path = parts.join("/");
  return path.length <= 1024 ? path : null;
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface RepoFileInfo {
  path: string;
  size: number;
  sha256: string;
  updatedAt: Date;
}

export async function listRepoFiles(repo: string): Promise<RepoFileInfo[]> {
  return prisma.repoFile.findMany({
    where: { repo },
    select: { path: true, size: true, sha256: true, updatedAt: true },
    orderBy: { path: "asc" },
  });
}

/** Checks a new or replaced file against the repo's limits. Returns a reason, or null if it fits. */
export async function repoFileProblem(repo: string, path: string, size: number): Promise<string | null> {
  if (size > REPO_FILE_MAX_BYTES) return `Files can be up to ${REPO_FILE_MAX_BYTES / 1048576} MB.`;
  const others = await prisma.repoFile.aggregate({ where: { repo, NOT: { path } }, _sum: { size: true }, _count: true });
  if (others._count >= REPO_FILES_MAX_COUNT) return `A repo can keep up to ${REPO_FILES_MAX_COUNT} files.`;
  if ((others._sum.size ?? 0) + size > REPO_FILES_MAX_TOTAL) return `A repo can keep up to ${REPO_FILES_MAX_TOTAL / 1048576} MB of files.`;
  return null;
}

export async function putRepoFile(repo: string, path: string, content: Uint8Array): Promise<void> {
  const bytes = new Uint8Array(content);
  const data = { content: bytes, size: bytes.byteLength, sha256: sha256(bytes) };
  await prisma.repoFile.upsert({ where: { repo_path: { repo, path } }, update: data, create: { repo, path, ...data } });
}
