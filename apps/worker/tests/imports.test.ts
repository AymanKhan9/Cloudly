import { test, expect } from "bun:test";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

import { prisma, seal } from "@repo/db";
import { claimRun } from "../src/claim";
import { processRun, threadHome } from "../src/process-run";
import { promptWithHistory } from "../src/transcript";
import { createFixtureRepo } from "./test-helpers";

const git = (repo: string, ...args: string[]) => Bun.$`git -C ${repo} ${args}`.quiet().text().then((s) => s.trim());
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("the import turn sets up the branch and hands Claude Code its own session back", async () => {
  const fixture = await createFixtureRepo();
  const repo = fixture.repoPath;
  // The user's work, on a branch of its own (as the import command pushes it).
  await git(repo, "checkout", "-q", "-b", "feature/cart");
  await Bun.write(path.join(repo, "cart.ts"), "export const cart = [];\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "cart");
  const work = await git(repo, "rev-parse", "HEAD");
  await git(repo, "checkout", "-q", "-");

  const raw = [
    { type: "user", uuid: "u1", parentUuid: null, sessionId: SID, cwd: "/Users/me/shop", message: { role: "user", content: "Add a cart" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: SID, cwd: "/Users/me/shop", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Write", input: { file_path: "/Users/me/shop/cart.ts" } }] } },
  ].map((l) => JSON.stringify(l)).join("\n");
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `imp-${Date.now()}` } });
  const thread = await prisma.thread.create({
    data: {
      userId: user.id, repo, baseBranch: "main", harness: "native-claude", title: "Cart", branch: `agent/import-${Date.now()}`,
      imported: { create: { source: "claude-code", sessionId: SID, cwd: "/Users/me/shop", fileName: `${SID}.jsonl`, file: await seal(gzipSync(raw).toString("base64")), startFrom: "feature/cart", turns: 1, summary: "Set up the shop." } },
    },
  });
  const t0 = Date.now() - 10_000;
  const turn = await prisma.run.create({ data: { userId: user.id, threadId: thread.id, repo, baseBranch: "main", harness: "native-claude", status: "succeeded", kind: "import_turn", prompt: "Add a cart", createdAt: new Date(t0) } });
  await prisma.runEvent.createMany({ data: [{ runId: turn.id, seq: 0, kind: "tool_call", data: { title: "Write /Users/me/shop/cart.ts" } }, { runId: turn.id, seq: 1, kind: "text", data: "Cart added." }] });
  const setup = await prisma.run.create({ data: { userId: user.id, threadId: thread.id, repo, baseBranch: "main", harness: "native-claude", status: "queued", kind: "import", prompt: "Import from Claude Code", createdAt: new Date(t0 + 1) } });
  try {
    await processRun((await claimRun("worker-imp"))!, "worker-imp");
    const done = await prisma.run.findUniqueOrThrow({ where: { id: setup.id } });
    expect(done.status).toBe("succeeded");
    expect(done.output).toBe("Imported 1 turn from Claude Code. Its branch starts from feature/cart. Claude Code picks up its own session from here.");
    // The session's branch has the work, and its diff shows it.
    expect(await git(repo, "rev-parse", thread.branch)).toBe(work);
    const after = await prisma.thread.findUniqueOrThrow({ where: { id: thread.id }, include: { imported: true } });
    expect(after.diff).toContain("+++ b/cart.ts");
    expect(after.agentSessionId).toBe(SID);
    expect(after.imported?.resumed).toBe(true);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: turn.id } })).commitSha).toBe(work);
    // Claude's file, where it looks for /workspace's sessions, with paths moved there.
    const placed = await readFile(path.join(await threadHome(thread.id), ".claude", "projects", "-workspace", `${SID}.jsonl`), "utf8");
    expect(placed).toContain('"cwd":"/workspace"');
    expect(placed).toContain('"file_path":"/workspace/cart.ts"');
    expect(placed).not.toContain("/Users/me");

    // Another agent gets the imported conversation in its prompt.
    const history = await promptWithHistory(thread.id, "none", "native-codex", "Add a checkout button");
    expect(history).toContain("This conversation started in Claude Code and was brought into Cloudly.");
    expect(history).toContain("Summary of the earliest part:\nSet up the shop.");
    expect(history).toContain("User: Add a cart\nYou: Cart added.\n(Write /Users/me/shop/cart.ts)");
    expect(history).not.toContain("Import from Claude Code");
    expect(history.endsWith("Add a checkout button")).toBe(true);
  } finally {
    await prisma.thread.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
  }
});

test("Pi's file goes where pi-acp finds it; a missing start branch fails clearly", async () => {
  const { placeSessionFile } = await import("../src/imports");
  const home = await threadHome(`pi-${Date.now()}`);
  const raw = [{ type: "session", version: 3, id: "pi-9", timestamp: "t", cwd: "/w/site" }, { type: "message", id: "u", parentId: null, timestamp: "t", message: { role: "user", content: "hi" } }].map((l) => JSON.stringify(l)).join("\n");
  const id = await placeSessionFile("pi", home, { sessionId: "pi-9", cwd: "/w/site", fileName: "2026_pi-9.jsonl", file: await seal(gzipSync(raw).toString("base64")) });
  expect(id).toBe("pi-9");
  const map = JSON.parse(await readFile(path.join(home, ".pi", "pi-acp", "session-map.json"), "utf8"));
  expect(map.sessions["pi-9"]).toMatchObject({ cwd: "/workspace", sessionFile: "/home/node/.pi/agent/sessions/--workspace--/2026_pi-9.jsonl" });
  expect(await readFile(path.join(home, ".pi", "agent", "sessions", "--workspace--", "2026_pi-9.jsonl"), "utf8")).toContain('"cwd":"/workspace"');

  const fixture = await createFixtureRepo();
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `imp2-${Date.now()}` } });
  try {
    const thread = await prisma.thread.create({
      data: { userId: user.id, repo: fixture.repoPath, baseBranch: "main", harness: "native-codex", title: "x", branch: `agent/import-x${Date.now()}`, imported: { create: { source: "chat", startFrom: "nope", turns: 0 } } },
    });
    const setup = await prisma.run.create({ data: { userId: user.id, threadId: thread.id, repo: fixture.repoPath, baseBranch: "main", harness: "native-codex", status: "queued", kind: "import", prompt: "Import" } });
    await processRun((await claimRun("worker-imp"))!, "worker-imp");
    const failed = await prisma.run.findUniqueOrThrow({ where: { id: setup.id } });
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain('There\'s no branch or commit "nope"');
  } finally {
    await prisma.thread.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
  }
});
