import { prisma, unseal, config } from "@repo/db";
import type { Run } from "@repo/shared/run";
import { IMPORT_SOURCES, rewriteCwd, type ImportSource } from "@repo/shared/session-import";
import { gunzipSync } from "node:zlib";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import { createWorkspace, destroyWorkspace, type Workspace } from "./workspace";
import { resolveCloneSource } from "./github";
import { insertEvents } from "./events";
import { branchDiff, baseRef } from "./review";
import { threadHome } from "./process-run";
import { CODEX_HOME } from "./docker";

// The import turn of a session brought in from elsewhere (see
// @repo/shared/session-import and the API's import-routes). The conversation
// is already there as finished turns; this sets up the rest:
//
//   code     the session's branch starts where its work was: the branch the
//            import command pushed (used as is), another branch (copied to the
//            session's own), or the base branch.
//   resume   when the session's agent is the one that wrote the file, the file
//            goes where that agent keeps its sessions, with the directory it ran
//            in rewritten to /workspace, so its next turn resumes its own session.
//            Any other agent gets the conversation written into its prompt.

const SANDBOX_HOME = "/home/node";

/** Puts the agent's own session file in the session's home; the id to resume. */
export async function placeSessionFile(
  source: ImportSource,
  home: string,
  imp: { sessionId: string; cwd: string; fileName: string | null; file: string },
): Promise<string> {
  const opened = await unseal(imp.file);
  if (opened === null) throw new Error("The imported file can't be opened with this instance's key.");
  const text = rewriteCwd(gunzipSync(Buffer.from(opened, "base64")).toString("utf8"), imp.cwd);
  const id = imp.sessionId;
  const safeName = (name: string | null, fallback: string, pattern: RegExp) =>
    name && pattern.test(name) && !name.includes("/") && !name.includes("..") ? name : fallback;

  if (source === "claude-code") {
    // Claude keeps a directory's sessions under its path with / as -.
    const dir = path.join(home, ".claude", "projects", "-workspace");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${id}.jsonl`), text, { mode: 0o600 });
    return id;
  }
  if (source === "codex") {
    const now = new Date();
    const day = [String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"), String(now.getUTCDate()).padStart(2, "0")];
    const name = safeName(imp.fileName, `rollout-${now.toISOString().slice(0, 19).replace(/:/g, "-")}-${id}.jsonl`, /^rollout-[\w.-]+\.jsonl$/);
    // The session's own Codex home, and the shared one a ChatGPT sign-in uses.
    const homes = [path.join(home, ".codex")];
    if (await config("CODEX_AUTH_JSON")) homes.push(CODEX_HOME);
    for (const h of homes) {
      const dir = path.join(h, "sessions", ...day);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, name), text, { mode: 0o600 });
    }
    return id;
  }
  if (source === "pi") {
    // Pi: ~/.pi/agent/sessions/--<dir>--/, and pi-acp's map from the ACP session id to the file.
    const dir = path.join(home, ".pi", "agent", "sessions", "--workspace--");
    const name = safeName(imp.fileName, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`, /^[\w.-]+\.jsonl$/);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), text, { mode: 0o600 });
    const mapFile = path.join(home, ".pi", "pi-acp", "session-map.json");
    let map: { version: 1; sessions: Record<string, unknown> } = { version: 1, sessions: {} };
    try {
      const parsed = JSON.parse(await readFile(mapFile, "utf8"));
      if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") map = parsed;
    } catch {}
    map.sessions[id] = { sessionId: id, cwd: "/workspace", sessionFile: `${SANDBOX_HOME}/.pi/agent/sessions/--workspace--/${name}`, updatedAt: new Date().toISOString() };
    await mkdir(path.dirname(mapFile), { recursive: true });
    await writeFile(mapFile, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
    return id;
  }
  throw new Error(`${IMPORT_SOURCES[source].name} sessions can't be resumed directly.`);
}

export async function processImport(run: Run, workerId: string): Promise<void> {
  const fenced = { id: run.id, workerId, leaseGen: run.leaseGen };
  let ws: Workspace | undefined;
  try {
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: run.threadId! }, include: { imported: true } });
    const imp = thread.imported;
    if (!imp) throw new Error("This session has nothing imported.");
    const source = imp.source as ImportSource;
    const name = IMPORT_SOURCES[source]?.name ?? "elsewhere";
    const clone = await resolveCloneSource(run.repo);
    ws = await createWorkspace(clone, { branch: thread.branch, baseBranch: run.baseBranch });
    const sha = async (ref: string) => {
      const r = await Bun.$`git --git-dir=${ws!.mirrorDir} rev-parse --verify --quiet ${`${ref}^{commit}`}`.nothrow().quiet();
      return r.exitCode === 0 ? r.text().trim() : null;
    };

    // Where the code starts.
    let head: string | null = null;
    let codeNote: string;
    if (await sha(`refs/heads/${thread.branch}`)) {
      head = await sha(`refs/heads/${thread.branch}`);
      codeNote = `It carries on from the branch ${thread.branch}, with the work as it was.`;
    } else if (imp.startFrom) {
      head = (await sha(`refs/heads/${imp.startFrom}`)) ?? (/^[0-9a-f]{7,40}$/i.test(imp.startFrom) ? await sha(imp.startFrom) : null);
      if (!head) throw new Error(`There's no branch or commit "${imp.startFrom}" in ${run.repo}. Push it first, or import it starting from the base branch.`);
      const pushed = await Bun.$`git --git-dir=${ws.mirrorDir} push --quiet ${clone} ${`${head}:refs/heads/${thread.branch}`}`.nothrow().quiet();
      if (pushed.exitCode !== 0) throw new Error(`Couldn't make the branch ${thread.branch}: ${pushed.stderr.toString().split("\n")[0]}`);
      codeNote = `Its branch starts from ${imp.startFrom}.`;
    } else {
      codeNote = `Its code starts from ${run.baseBranch}: work that wasn't pushed isn't here.`;
    }
    const base = await baseRef(ws.mirrorDir, run.baseBranch, true);
    const diff = head ? await branchDiff(ws.mirrorDir, base, head) : null;

    // The agent's own session, when it's the agent that wrote the file.
    let resumeId: string | null = null;
    if (imp.file && imp.sessionId && imp.cwd && IMPORT_SOURCES[source]?.harness === thread.harness) {
      try {
        resumeId = await placeSessionFile(source, await threadHome(thread.id), { sessionId: imp.sessionId, cwd: imp.cwd, fileName: imp.fileName, file: imp.file });
      } catch (err) {
        console.error(`run ${run.id}: placing the imported session file:`, err);
      }
    }

    const turns = imp.turns + imp.dropped;
    const said = [
      `Imported ${turns} turn${turns === 1 ? "" : "s"} from ${name}${imp.dropped ? ` (the most recent ${imp.turns} are shown)` : ""}.`,
      codeNote,
      resumeId
        ? `${name} picks up its own session from here.`
        : "The agent gets the conversation so far with each message.",
    ].join(" ");

    const ok = await prisma.$transaction(async (tx) => {
      const r = await tx.run.updateMany({ where: fenced, data: { status: "succeeded", output: said } });
      if (r.count === 0) return false;
      await tx.thread.update({
        where: { id: thread.id },
        data: { diff: diff?.diff ?? "", diffBase: diff?.base ?? null, ...(resumeId ? { agentSessionId: resumeId } : {}), updatedAt: new Date() },
      });
      if (resumeId) await tx.sessionImport.update({ where: { id: imp.id }, data: { resumed: true } });
      // The last imported turn is where the code was: a checkpoint to rewind or fork to.
      if (head) {
        const last = await tx.run.findFirst({ where: { threadId: thread.id, kind: "import_turn" }, orderBy: { createdAt: "desc" }, select: { id: true } });
        if (last) await tx.run.update({ where: { id: last.id }, data: { commitSha: head } });
      }
      return true;
    });
    if (ok) {
      await insertEvents(run.id, [
        { seq: 0, ts: Date.now(), kind: "text", data: said },
        { seq: 1, ts: Date.now(), kind: "done", data: { result: said } },
      ]);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.run.updateMany({ where: fenced, data: { status: "failed", error: message } });
  } finally {
    if (ws) await destroyWorkspace(ws);
  }
}
