import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { prisma, seal } from "@repo/db";
import { threadHome } from "./process-run";
import { findCodexRollout } from "./context-usage";
import { CODEX_HOME } from "./docker";
import { promptWithHistory } from "./transcript";
import { readRegular } from "./repo-files";
import { pause } from "./pause";

// A session going back to the user's computer (the import command's "pull";
// see SessionHandoff). Its code is on its branch; this gets the rest ready: the
// agent's own session file, which only this worker has (in the session's
// home), and the conversation as a prompt for any agent that can't open it.

const SANDBOX_HOME = "/home/node";
const MAX_FILE = 64 * 1024 * 1024;
const KEEP_MS = 24 * 3600_000;

/** Where the session's agent keeps the session it resumes, on this host. */
export async function sessionFilePath(harness: string, home: string, sessionId: string): Promise<string | null> {
  if (harness === "native-claude") {
    const p = path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`);
    return existsSync(p) ? p : null;
  }
  if (harness === "native-codex") return findCodexRollout([path.join(home, ".codex"), CODEX_HOME], sessionId);
  if (harness === "acp-pi") {
    // pi-acp maps the session to Pi's file, by its path inside the sandbox.
    try {
      const map = JSON.parse(await readFile(path.join(home, ".pi", "pi-acp", "session-map.json"), "utf8"));
      const file = map?.sessions?.[sessionId]?.sessionFile;
      if (typeof file === "string" && file.startsWith(`${SANDBOX_HOME}/`) && !file.includes("..")) {
        const p = path.join(home, file.slice(SANDBOX_HOME.length + 1));
        return existsSync(p) ? p : null;
      }
    } catch {}
  }
  return null;
}

const CONTINUE = "Carry on with this work on my computer. The code is on the current branch, as the session left it. Start by saying briefly where things stand.";

async function prepare(handoffId: string): Promise<void> {
  const h = await prisma.sessionHandoff.findUniqueOrThrow({ where: { id: handoffId }, include: { thread: true } });
  const t = h.thread;
  let file: string | null = null;
  let fileName: string | null = null;
  if (t.agentSessionId) {
    const p = await sessionFilePath(t.harness, await threadHome(t.id), t.agentSessionId);
    const bytes = p ? await readRegular(p, MAX_FILE) : null;
    if (p && bytes) {
      file = await seal(gzipSync(bytes).toString("base64"));
      fileName = path.basename(p);
    }
  }
  const transcript = await promptWithHistory(t.id, "none", t.harness, CONTINUE);
  await prisma.sessionHandoff.update({
    where: { id: h.id },
    data: { status: "ready", sessionId: file ? t.agentSessionId : null, fileName, file, transcript },
  });
}

/** Picks up waiting handoffs (claimed one at a time, so two workers don't both do one) and drops old ones. */
export async function processHandoffs(): Promise<number> {
  await prisma.sessionHandoff.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_MS) } } });
  const waiting = await prisma.sessionHandoff.findMany({ where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: 10, select: { id: true } });
  let done = 0;
  for (const { id } of waiting) {
    const claimed = await prisma.sessionHandoff.updateMany({ where: { id, status: "pending" }, data: { status: "working" } });
    if (!claimed.count) continue;
    try {
      await prepare(id);
      done++;
    } catch (err) {
      await prisma.sessionHandoff.update({ where: { id }, data: { status: "failed", error: err instanceof Error ? err.message : String(err) } });
    }
  }
  return done;
}

export async function runHandoffLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await processHandoffs().catch((err) => console.error("handoffs:", err));
    await pause(1500, signal);
  }
}
