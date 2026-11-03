import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma, sha256 } from "@repo/db";
import { artifactType, ARTIFACT_LIMITS } from "@repo/shared/artifacts";
import { readRegular, walk } from "./repo-files";

// A session's artifacts (see @repo/shared/artifacts): the latest version of each
// is put in a folder the turn mounts at /artifacts, so the agent can change them;
// once the container has exited, every file that's new or different becomes a
// new version. The folder was writable by the agent, so it's read the way /files
// is: no symlinks followed, regular files only, size caps.

export interface ArtifactsDir {
  dir: string;
  threadId: string;
  /** What the turn started with: name to sha256. */
  started: Map<string, string>;
}

/** The latest version of each of a session's artifacts. */
export async function latestArtifacts(threadId: string) {
  const rows = await prisma.artifact.findMany({ where: { threadId }, orderBy: { version: "desc" }, select: { id: true, name: true, version: true, sha256: true, content: true } });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.name)) latest.set(r.name, r);
  return [...latest.values()];
}

export async function prepareArtifacts(threadId: string): Promise<ArtifactsDir> {
  const dir = await mkdtemp(path.join(tmpdir(), "run-artifacts-"));
  const started = new Map<string, string>();
  for (const a of await latestArtifacts(threadId)) {
    const full = path.join(dir, a.name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, a.content);
    started.set(a.name, a.sha256);
  }
  return { dir, threadId, started };
}

export interface CollectedArtifact {
  id: string;
  name: string;
  kind: string;
  version: number;
}

/** New versions of what the agent wrote. Call only once the run container has exited. */
export async function collectArtifacts(art: ArtifactsDir, runId: string): Promise<{ saved: CollectedArtifact[]; skipped: string[] }> {
  const saved: CollectedArtifact[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const rel of (await walk(art.dir)).sort()) {
    const type = artifactType(rel);
    if (!type) {
      skipped.push(rel);
      continue;
    }
    const bytes = await readRegular(path.join(art.dir, rel), ARTIFACT_LIMITS.fileBytes);
    if (!bytes || bytes.byteLength === 0) {
      skipped.push(rel);
      continue;
    }
    const sum = sha256(bytes);
    if (art.started.get(rel) === sum) continue;
    if (saved.length >= ARTIFACT_LIMITS.perTurn || total + bytes.byteLength > ARTIFACT_LIMITS.turnBytes) {
      skipped.push(rel);
      continue;
    }
    total += bytes.byteLength;
    // The next version number; a unique index stops two turns from taking the same one.
    for (let attempt = 0; attempt < 3; attempt++) {
      const last = await prisma.artifact.findFirst({ where: { threadId: art.threadId, name: rel }, orderBy: { version: "desc" }, select: { version: true } });
      try {
        const row = await prisma.artifact.create({
          data: { threadId: art.threadId, runId, name: rel, kind: type.kind, mime: type.mime, content: Buffer.from(bytes), size: bytes.byteLength, sha256: sum, version: (last?.version ?? 0) + 1 },
          select: { id: true, name: true, kind: true, version: true },
        });
        saved.push(row);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
      }
    }
  }
  return { saved, skipped };
}

export async function destroyArtifactsDir(art: ArtifactsDir): Promise<void> {
  await rm(art.dir, { recursive: true, force: true });
}
