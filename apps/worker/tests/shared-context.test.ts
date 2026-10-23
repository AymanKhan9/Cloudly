import { test, expect } from "bun:test";
import { writeFile, readFile, symlink, rm } from "node:fs/promises";
import path from "node:path";

import { prisma, setContextNotes, addContextEntry } from "@repo/db";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { type ContainerOptions } from "../src/docker";
import { createFixtureRepo } from "./test-helpers";

test("with shared context on, one agent's work and notes reach the next agent's turn, whichever agent it is", async () => {
  const fixture = await createFixtureRepo();
  const repo = fixture.repoPath;
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `ctx-${Date.now()}` } });
  const mk = (harness: string, branch: string) =>
    prisma.thread.create({ data: { userId: user.id, repo, baseBranch: "main", harness, title: "t", branch } });
  const claude = await mk("native-claude", "agent/ctx-claude");
  const gemini = await mk("gemini-acp", "agent/ctx-gemini");
  await setContextNotes(repo, "- Money is integer cents.");
  await addContextEntry({ repo, kind: "decision", author: "Cursor on laptop", source: "mcp", title: "Use the fetch wrapper in src/http.ts" });

  const seen: { task: string; system?: string; options: ContainerOptions; contextFile?: string }[] = [];
  const stub = (write: (dir: string) => Promise<void>, edit: boolean) =>
    async function* (ws: { runDir: string }, task: string, _h: string, _id: string, options: ContainerOptions = {}) {
      seen.push({ task, system: options.systemAppend, options, contextFile: options.contextDir && (await readFile(path.join(options.contextDir, "context.md"), "utf8")) });
      if (options.contextDir) await write(options.contextDir);
      if (edit) await writeFile(path.join(ws.runDir, "limits.ts"), "export const LIMIT = 60;\n");
      yield { seq: 0, ts: Date.now(), kind: "text" as const, data: "Added a 60/min limiter in limits.ts." };
      yield { seq: 1, ts: Date.now(), kind: "done" as const, data: { result: "ok" } };
    };
  const turn = async (thread: { id: string; harness: string }, prompt: string, s: ReturnType<typeof stub>) => {
    await prisma.run.create({ data: { status: "queued", repo, baseBranch: "main", prompt, harness: thread.harness, userId: user.id, threadId: thread.id } });
    await processRun((await claimRun("worker-1"))!, "worker-1", s as never);
  };

  const outside = path.join(repo, "..", `host-secret-${Date.now()}.txt`);
  await writeFile(outside, "HOST SECRET");
  try {
    // Claude works and leaves a decision for whoever comes next.
    await turn(claude, "Add rate limiting to the invoices API", stub(async (dir) => {
      await writeFile(path.join(dir, "new-notes.jsonl"), JSON.stringify({ kind: "decision", title: "Limits live in limits.ts", text: "One place to change them." }) + "\nnot json\n");
    }, true));
    // Claude gets the shared context in its system prompt, and the context tools' folder.
    expect(seen[0]!.system).toContain("Money is integer cents");
    expect(seen[0]!.system).toContain("Use the fetch wrapper in src/http.ts");
    expect(seen[0]!.contextFile).toContain("Money is integer cents");

    // Gemini, in another session, starts from what Claude did and decided.
    await turn(gemini, "Add a test for the limiter", stub(async (dir) => {
      // A symlink to a host file where the notes should be: ignored, never read.
      await rm(path.join(dir, "new-notes.jsonl"));
      await symlink(outside, path.join(dir, "new-notes.jsonl"));
    }, false));
    const task = seen[1]!.task;
    expect(task).toContain("Limits live in limits.ts");
    expect(task).toContain("Add rate limiting to the invoices API");
    expect(task).toContain("Changed 1 file (+1 −0)");
    expect(task).toContain("Added a 60/min limiter");

    const entries = await prisma.contextEntry.findMany({ where: { repo }, orderBy: { createdAt: "asc" } });
    expect(entries.map((e) => [e.kind, e.author, e.title])).toEqual([
      ["decision", "Cursor on laptop", "Use the fetch wrapper in src/http.ts"],
      ["decision", "native-claude", "Limits live in limits.ts"],
      ["turn", "native-claude", "Add rate limiting to the invoices API"],
      ["turn", "gemini-acp", "Add a test for the limiter"],
    ]);
    expect(JSON.stringify(entries)).not.toContain("HOST SECRET");

    // Turned off: no context in the turn, nothing recorded.
    await prisma.repoContext.update({ where: { repo }, data: { enabled: false } });
    await turn(gemini, "Another change", stub(async () => {}, false));
    expect(seen[2]!.options.contextDir).toBeUndefined();
    expect(seen[2]!.task).not.toContain("shared context");
    expect(await prisma.contextEntry.count({ where: { repo } })).toBe(4);
  } finally {
    await rm(outside, { force: true });
    await prisma.run.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.contextEntry.deleteMany({ where: { repo } });
    await prisma.repoContext.deleteMany({ where: { repo } });
    await fixture.cleanup();
  }
}, 60000);
