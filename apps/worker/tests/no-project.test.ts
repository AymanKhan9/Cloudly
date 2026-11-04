import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma } from "@repo/db";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { NO_PROJECT, scratchPath } from "../src/scratch";

test("a session without a project keeps its work in its own repo from turn to turn, and pushes nowhere", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "scratch-data-"));
  const before = process.env.CLOUDLY_DATA_DIR;
  process.env.CLOUDLY_DATA_DIR = data;
  try {
    const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `noproj-${Date.now()}` } });
    const thread = await prisma.thread.create({
      data: { userId: user.id, repo: NO_PROJECT, baseBranch: "main", branch: "main", harness: "native-claude", title: "Notes" },
    });
    const tasks: string[] = [];
    const turn = async (prompt: string, write: (dir: string) => Promise<void>) => {
      const run = await prisma.run.create({ data: { status: "queued", repo: NO_PROJECT, baseBranch: "main", prompt, harness: "native-claude", userId: user.id, threadId: thread.id } });
      const claimed = await claimRun("worker-np");
      expect(claimed?.id).toBe(run.id);
      await processRun(claimed!, "worker-np", async function* (ws: { runDir: string }, _task: string, _h: string, _id: string, options: { systemAppend?: string } = {}) {
        tasks.push(options.systemAppend ?? "");
        await write(ws.runDir);
        yield { seq: 0, ts: Date.now(), kind: "text" as const, data: "ok" };
        yield { seq: 1, ts: Date.now(), kind: "done" as const, data: { result: "ok" } };
      });
      return prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    };

    const first = await turn("Write notes", async (dir) => { await Bun.write(path.join(dir, "notes.md"), "# Notes\n"); });
    expect(first.status).toBe("succeeded");
    expect(first.prUrl).toBeNull();
    expect(tasks[0]).toContain("This session has no project");

    let seen = "";
    const second = await turn("Add a line", async (dir) => {
      seen = await Bun.file(path.join(dir, "notes.md")).text();
      await Bun.write(path.join(dir, "notes.md"), seen + "- one\n");
    });
    expect(second.status).toBe("succeeded");
    expect(seen).toBe("# Notes\n");
    const kept = await Bun.$`git -C ${scratchPath(thread.id)} show main:notes.md`.text();
    expect(kept).toBe("# Notes\n- one\n");
  } finally {
    if (before === undefined) delete process.env.CLOUDLY_DATA_DIR;
    else process.env.CLOUDLY_DATA_DIR = before;
    await rm(data, { recursive: true, force: true });
  }
}, 60000);
