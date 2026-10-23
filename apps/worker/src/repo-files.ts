import { mkdtemp, mkdir, rm, writeFile, lstat, readdir, open, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma, cleanFilePath, putRepoFile, sha256, REPO_FILE_MAX_BYTES, REPO_FILES_MAX_COUNT, REPO_FILES_MAX_TOTAL } from "@repo/db";

// A repo's kept files (see @repo/db repo-files): copied into a fresh folder that
// the run mounts at /files, and saved back once the run container has exited.
// Everything in that folder was writable by the agent, so it is read the way the
// patch is (patch.ts): no following symlinks, regular files only, size caps.

export interface FilesDir {
  dir: string;
  repo: string;
  /** What the run started with, by path, so only files it saw can be deleted. */
  started: Map<string, string>;
}

export async function materializeRepoFiles(repo: string): Promise<FilesDir> {
  const dir = await mkdtemp(path.join(tmpdir(), "run-files-"));
  const started = new Map<string, string>();
  for (const f of await prisma.repoFile.findMany({ where: { repo } })) {
    const rel = cleanFilePath(f.path);
    if (!rel) continue;
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, f.content);
    started.set(rel, f.sha256);
  }
  return { dir, repo, started };
}

/** One regular file's bytes, or null if it isn't a regular file or is too big. */
export async function readRegular(full: string, max = REPO_FILE_MAX_BYTES): Promise<Uint8Array | null> {
  const fh = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!fh) return null;
  try {
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size > max) return null;
    return new Uint8Array(await fh.readFile());
  } finally {
    await fh.close();
  }
}

/** Every regular file under `dir`, by relative path; symlinks and special files are skipped, never followed. */
async function walk(dir: string, rel = "", out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 16 || out.length > REPO_FILES_MAX_COUNT * 2) return out;
  for (const name of await readdir(path.join(dir, rel)).catch(() => [] as string[])) {
    const child = rel ? `${rel}/${name}` : name;
    const st = await lstat(path.join(dir, child)).catch(() => null);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) await walk(dir, child, out, depth + 1);
    else if (st.isFile()) out.push(child);
  }
  return out;
}

export interface SyncResult {
  saved: string[];
  deleted: string[];
  skipped: string[];
}

/** Saves what the agent changed in /files. Call only once the run container has exited. */
export async function syncRepoFiles(files: FilesDir): Promise<SyncResult> {
  const result: SyncResult = { saved: [], deleted: [], skipped: [] };
  const found = new Set<string>();
  let total = 0;
  for (const rel of (await walk(files.dir)).sort()) {
    const clean = cleanFilePath(rel);
    if (!clean || clean !== rel) {
      result.skipped.push(rel);
      continue;
    }
    const bytes = await readRegular(path.join(files.dir, rel));
    if (!bytes || found.size >= REPO_FILES_MAX_COUNT || total + bytes.byteLength > REPO_FILES_MAX_TOTAL) {
      result.skipped.push(rel);
      // Too big to keep this time, but not deleted either: the earlier copy stays.
      found.add(rel);
      continue;
    }
    found.add(rel);
    total += bytes.byteLength;
    if (files.started.get(rel) === sha256(bytes)) continue;
    await putRepoFile(files.repo, rel, bytes);
    result.saved.push(rel);
  }
  for (const rel of files.started.keys()) {
    if (found.has(rel)) continue;
    await prisma.repoFile.deleteMany({ where: { repo: files.repo, path: rel } });
    result.deleted.push(rel);
  }
  return result;
}

export async function destroyFilesDir(files: FilesDir): Promise<void> {
  await rm(files.dir, { recursive: true, force: true });
}
