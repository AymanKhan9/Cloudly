import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export interface Workspace {
  scratchDir: string;
  mirrorDir: string;
  runDir: string;
  baseSha: string;
  /** True when the mirror came from the repo cache rather than a full clone. */
  cached?: boolean;
  /**
   * The mirror's objects, which the run clone borrows its history from (git
   * alternates). Containers get it read-only at SHARED_OBJECTS; see workspaceMounts.
   */
  objectsDir?: string;
}

/** Where containers see the mirror's objects. The run clone's alternates point here. */
export const SHARED_OBJECTS = "/cloudly/git-objects";

/** The -v flags for a container that works on the run clone. */
export function workspaceMounts(ws: { runDir: string; objectsDir?: string }): string[] {
  return [
    "-v", `${ws.runDir}:/workspace`,
    ...(ws.objectsDir ? ["-v", `${ws.objectsDir}:${SHARED_OBJECTS}:ro`] : []),
  ];
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

// The repo cache. Every turn used to clone the whole repo from GitHub; now the
// worker keeps one bare copy per repo on the VM and fetches only what changed
// since the last turn, then makes the turn's mirror from it with a local clone
// (hardlinked objects, near-instant). The idea is the same as git-worktree-fast:
// keep a warm copy and make new checkouts from it cheaply.
//
// Safety: the cache and the turn's mirror are host-only. Neither is mounted into
// a container (the agent gets the run clone, which is still a --no-hardlinks
// copy, so it shares no inodes with either), and git never rewrites an object
// file in place, so hardlinks between them can't carry a change across. The
// cache stores no remote URL, so the GitHub token it was fetched with isn't
// written to disk. If anything about the cache fails, the turn falls back to a
// full clone, and a cache that a full clone succeeds past is thrown away.

/** Where the caches live, or null when CLOUDLY_REPO_CACHE=off. Read per call so tests can point it elsewhere. */
export function repoCacheRoot(): string | null {
  const setting = process.env.CLOUDLY_REPO_CACHE;
  if (setting === "off" || setting === "0" || setting === "false") return null;
  if (setting && path.isAbsolute(setting)) return setting;
  return path.join(process.env.CLOUDLY_DATA_DIR ?? path.join(homedir(), ".cloudly"), "repo-cache");
}

/** The repo a clone source names, without credentials: what a cache is keyed on. */
export function cacheKey(source: string): string {
  let identity = source;
  try {
    const url = new URL(source);
    if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "ssh:") {
      identity = `${url.host}${url.pathname.replace(/\.git$/, "")}`.toLowerCase();
    }
  } catch {
    identity = path.resolve(source);
  }
  const slug = identity.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-60);
  return `${slug}-${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

const LOCK_STALE_MS = 10 * 60_000;
const locks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` holding the cache's lock: in-process by a promise chain, across
 * worker processes by a lock directory (mkdir is atomic). A lock left behind by
 * a worker that died is taken over once it's older than any fetch should take.
 */
async function withCacheLock<T>(cacheDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(cacheDir) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  locks.set(cacheDir, chained);
  await prev;
  const lockDir = `${cacheDir}.lock`;
  try {
    await mkdir(path.dirname(cacheDir), { recursive: true });
    for (;;) {
      try {
        await mkdir(lockDir);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = Date.now() - (await stat(lockDir).then((s) => s.mtimeMs, () => Date.now()));
        if (age > LOCK_STALE_MS) await rm(lockDir, { recursive: true, force: true });
        else await Bun.sleep(150);
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  } finally {
    release();
    if (locks.get(cacheDir) === chained) locks.delete(cacheDir);
  }
}

/** Branches and tags, force-updated. Passed as values so Bun's shell doesn't glob them. */
const REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];

/** Brings the cache up to date with the source: branches, tags and the default branch. */
async function refreshCache(cacheDir: string, source: string): Promise<void> {
  const fresh = !(await Bun.file(path.join(cacheDir, "HEAD")).exists());
  if (fresh) {
    await rm(cacheDir, { recursive: true, force: true });
    await Bun.$`git init --quiet --bare ${cacheDir}`.quiet();
  }
  // The URL is given on the command line each time and never saved as a remote.
  await Bun.$`git --git-dir=${cacheDir} fetch --quiet --prune --no-write-fetch-head --no-tags ${source} ${REFSPECS}`.quiet();
  // A fetch doesn't move HEAD; point it at the source's default branch so a
  // turn with no branch asked for starts where a clone would.
  const symref = await Bun.$`git ls-remote --symref ${source} HEAD`.nothrow().quiet().text();
  const head = symref.match(/^ref:\s+(refs\/heads\/\S+)\s+HEAD/m)?.[1];
  if (head && (await branchExists(cacheDir, head.slice("refs/heads/".length)))) {
    await Bun.$`git --git-dir=${cacheDir} symbolic-ref HEAD ${head}`.quiet();
  } else if ((await Bun.$`git --git-dir=${cacheDir} rev-parse --verify --quiet HEAD`.nothrow().quiet()).exitCode !== 0) {
    // No default branch reported and HEAD names nothing: any branch beats none.
    const first = (await Bun.$`git --git-dir=${cacheDir} for-each-ref --count=1 ${"--format=%(refname)"} refs/heads/`.quiet().text()).trim();
    if (first) await Bun.$`git --git-dir=${cacheDir} symbolic-ref HEAD ${first}`.quiet();
  }
  // Last used, for eviction.
  await writeFile(path.join(cacheDir, "cloudly-last-used"), new Date().toISOString());
}

const EVICT_EVERY_MS = 60 * 60_000;
let lastEviction = 0;

/** Removes caches no turn has used in CLOUDLY_REPO_CACHE_DAYS days (default 14). */
export async function evictRepoCaches(now = Date.now()): Promise<string[]> {
  const root = repoCacheRoot();
  if (!root) return [];
  const days = Number(process.env.CLOUDLY_REPO_CACHE_DAYS ?? 14);
  const maxAge = (Number.isFinite(days) && days > 0 ? days : 14) * 86_400_000;
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (name.endsWith(".lock")) continue;
    const dir = path.join(root, name);
    const used = await stat(path.join(dir, "cloudly-last-used")).then((s) => s.mtimeMs, () => stat(dir).then((s) => s.mtimeMs, () => now));
    if (now - used < maxAge) continue;
    await withCacheLock(dir, async () => {
      await rm(dir, { recursive: true, force: true });
    });
    removed.push(name);
  }
  return removed;
}

/** Makes the turn's mirror from the repo's cache. Throws if the cache can't be used. */
async function mirrorFromCache(root: string, source: string, mirrorDir: string): Promise<void> {
  const cacheDir = path.join(root, cacheKey(source));
  await withCacheLock(cacheDir, async () => {
    await refreshCache(cacheDir, source);
    // A local clone hardlinks the objects: no copying, and none of the network.
    await Bun.$`git clone --quiet --bare ${cacheDir} ${mirrorDir}`.quiet();
  });
  if (Date.now() - lastEviction > EVICT_EVERY_MS) {
    lastEviction = Date.now();
    void evictRepoCaches().catch((error) => console.warn("[workspace] cache eviction failed", error));
  }
}

/** Marks a cache as broken, so the next turn rebuilds it. */
async function dropCache(root: string, source: string): Promise<void> {
  const cacheDir = path.join(root, cacheKey(source));
  await withCacheLock(cacheDir, () => rm(cacheDir, { recursive: true, force: true }));
}

/** For tests and the cache's own touch: when a cache was last used. */
export async function cacheLastUsed(source: string): Promise<Date | null> {
  const root = repoCacheRoot();
  if (!root) return null;
  return stat(path.join(root, cacheKey(source), "cloudly-last-used")).then((s) => s.mtime, () => null);
}

/** Back-dates a cache's last use; tests use it to exercise eviction. */
export async function touchCache(source: string, when: Date): Promise<void> {
  const root = repoCacheRoot();
  if (!root) return;
  await utimes(path.join(root, cacheKey(source), "cloudly-last-used"), when, when);
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
    // Create the bare mirror: from the repo cache when there is one, else (or
    // when the cache fails) a full clone as before.
    const root = repoCacheRoot();
    let cached = false;
    if (root) {
      try {
        await mirrorFromCache(root, repoPath, mirrorDir);
        cached = true;
      } catch (error) {
        console.warn(`[workspace] repo cache failed, cloning in full: ${(error as Error).message.split("\n")[0]}`);
        await rm(mirrorDir, { recursive: true, force: true });
      }
    }
    if (!cached) {
      await Bun.$`git clone --bare --no-hardlinks ${repoPath} ${mirrorDir}`;
      // The source is fine, so it was the cache that wasn't.
      if (root) await dropCache(root, repoPath).catch(() => {});
    }

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

    // Create the working clone. It borrows the repo's history from the mirror
    // (--shared) instead of copying it, which on a big repo was most of the
    // time a turn took to start. Containers see the mirror's objects read-only,
    // so the agent can add objects to its own clone but can't change the
    // mirror's, or through its hardlinks, the cache's.
    const objectsDir = path.join(mirrorDir, "objects");
    let shared = false;
    try {
      await Bun.$`git clone --quiet --shared --no-checkout ${mirrorDir} ${runDir}`.quiet();
      shared = true;
    } catch {
      await rm(runDir, { recursive: true, force: true });
      await Bun.$`git clone --no-hardlinks --no-checkout ${mirrorDir} ${runDir}`;
    }
    // Writing the files is what's left of the time on a big repo; one checkout
    // worker per core roughly halves it.
    if (startBranch) {
      await Bun.$`git -C ${runDir} -c checkout.workers=0 checkout -q -B ${startBranch} ${baseSha}`;
    } else {
      await Bun.$`git -C ${runDir} -c checkout.workers=0 checkout -q`;
    }
    if (shared) {
      // From here on the run clone is only used inside containers, where the
      // objects are mounted at SHARED_OBJECTS.
      await writeFile(path.join(runDir, ".git", "objects", "info", "alternates"), `${SHARED_OBJECTS}\n`);
    }

    return {
      scratchDir,
      mirrorDir,
      runDir,
      baseSha,
      cached,
      ...(shared ? { objectsDir } : {}),
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
