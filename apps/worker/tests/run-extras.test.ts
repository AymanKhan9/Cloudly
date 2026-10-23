import { test, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { prisma, saveEnvSecret, putRepoFile, sealMcpSecret } from "@repo/db";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { runExtras, sandboxRules } from "../src/preamble";
import { patchStats } from "../src/patch";
import { type ContainerOptions } from "../src/docker";
import { createFixtureRepo } from "./test-helpers";

test("a turn gets the repo's files, secrets as placeholders and the MCP servers; what it leaves in /files is kept", async () => {
  const fixture = await createFixtureRepo();
  const repo = fixture.repoPath;
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `extras-${Date.now()}` } });
  const thread = await prisma.thread.create({
    data: { userId: user.id, repo, baseBranch: "main", harness: "gemini-acp", title: "t", branch: "agent/thread-extras", autoPr: false },
  });
  await saveEnvSecret({ name: "X_API_TOKEN", repo, value: "real-token-value", hosts: "api.example.com", exposed: false });
  await saveEnvSecret({ name: "X_DB_PASSWORD", repo, value: "local-pw", hosts: "", exposed: true });
  await putRepoFile(repo, "input.csv", new TextEncoder().encode("a,b\n"));
  const mcp = await prisma.mcpServer.create({
    data: { name: "x-linear", url: "https://mcp.example.com/mcp", auth: "bearer", status: "connected", secret: await sealMcpSecret({ kind: "bearer", token: "t" }) },
  });

  let seen: { task: string; options: ContainerOptions; input: string } | null = null;
  async function* stub(ws: { runDir: string }, task: string, _h: string, _id: string, options: ContainerOptions = {}) {
    seen = { task, options, input: await readFile(path.join(options.filesDir!, "input.csv"), "utf8") };
    await writeFile(path.join(options.filesDir!, "result.json"), '{"ok":true}');
    await writeFile(path.join(ws.runDir, "README.md"), "# fixture\nchanged\nmore\n");
    yield { seq: 0, ts: Date.now(), kind: "text" as const, data: "done" };
    yield { seq: 1, ts: Date.now(), kind: "done" as const, data: { result: "done" } };
  }

  try {
    const run = await prisma.run.create({ data: { status: "queued", repo, baseBranch: "main", prompt: "go", harness: "gemini-acp", userId: user.id, threadId: thread.id } });
    await processRun((await claimRun("worker-1"))!, "worker-1", stub as never);

    expect(seen!.input).toBe("a,b\n");
    expect(seen!.options.mcpServers).toContain("x-linear");
    expect(seen!.options.env!.X_API_TOKEN).toMatch(/^cloudly-secret-/);
    expect(seen!.options.env!.X_DB_PASSWORD).toBe("local-pw");
    expect(JSON.stringify(seen!.options)).not.toContain("real-token-value");
    expect(seen!.options.desktopPassword).toBeUndefined();
    // The agent is told what it has, by name only.
    expect(seen!.task).toContain("/files");
    expect(seen!.task).toContain("X_API_TOKEN");
    expect(seen!.task).toContain("x-linear");

    const done = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(done.status).toBe("succeeded");
    expect({ files: done.filesChanged, add: done.additions, del: done.deletions }).toEqual({ files: 1, add: 2, del: 0 });
    // An arena session (autoPr false) gets no pull request.
    expect(done.prUrl).toBeNull();

    const kept = await prisma.repoFile.findUnique({ where: { repo_path: { repo, path: "result.json" } } });
    expect(Buffer.from(kept!.content).toString()).toBe('{"ok":true}');
    const events = await prisma.runEvent.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } });
    expect(events.some((e) => (e.data as { type?: string } | null)?.type === "files")).toBe(true);
  } finally {
    await prisma.run.deleteMany({ where: { threadId: thread.id } });
    await prisma.thread.delete({ where: { id: thread.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.envSecret.deleteMany({ where: { repo } });
    await prisma.repoFile.deleteMany({ where: { repo } });
    await prisma.mcpServer.delete({ where: { id: mcp.id } });
    await fixture.cleanup();
  }
}, 60000);

test("the preamble lists what a run has", () => {
  const lines = runExtras({ mcp: ["linear"], secrets: [{ name: "A", exposed: false }, { name: "B", exposed: true }], files: true, desktop: true });
  const text = sandboxRules(undefined, lines);
  expect(text).toContain("/files");
  expect(text).toContain("placeholders, not the real values: A.");
  expect(text).toContain("set for this repo: B.");
  expect(text).toContain("MCP servers connected by the user: linear");
  expect(text).toContain("virtual desktop");
  expect(runExtras({})).toEqual([]);
});

test("patch stats count files and changed lines, not headers", () => {
  const patch = [
    "diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1,2 @@", "-old", "+new", "+more",
    "diff --git a/y b/y", "new file mode 100644", "--- /dev/null", "+++ b/y", "@@ -0,0 +1 @@", "+y",
  ].join("\n");
  expect(patchStats(patch)).toEqual({ filesChanged: 2, additions: 3, deletions: 1 });
});
