import { test, expect } from "bun:test";
import path from "node:path";
import { mkdir, symlink, writeFile, readFile } from "node:fs/promises";

import { prisma } from "@repo/db";
import { prepareArtifacts, collectArtifacts, destroyArtifactsDir } from "../src/artifacts";
import { runExtras } from "../src/preamble";

test("a turn's /artifacts: new files and changes become versions; the rest is left out", async () => {
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `art-${Date.now()}` } });
  const thread = await prisma.thread.create({ data: { userId: user.id, repo: "acme/a", baseBranch: "main", harness: "native-claude", title: "Charts", branch: "agent/a" } });
  try {
    // Turn 1 writes three things, one of them not an artifact, and a symlink out of the folder.
    const one = await prepareArtifacts(thread.id);
    expect(one.started.size).toBe(0);
    await writeFile(path.join(one.dir, "chart.html"), "<h1>v1</h1>");
    await mkdir(path.join(one.dir, "reports"));
    await writeFile(path.join(one.dir, "reports", "summary.md"), "# Summary");
    await writeFile(path.join(one.dir, "notes.exe"), "no");
    await writeFile(path.join(one.dir, ".hidden.md"), "no");
    await writeFile(path.join(one.dir, "empty.csv"), "");
    await symlink("/etc/passwd", path.join(one.dir, "passwd.txt"));
    const first = await collectArtifacts(one, "run-1");
    await destroyArtifactsDir(one);
    expect(first.saved.map((a) => [a.name, a.kind, a.version])).toEqual([["chart.html", "html", 1], ["reports/summary.md", "markdown", 1]]);
    expect(first.skipped.sort()).toEqual([".hidden.md", "empty.csv", "notes.exe"]);

    // Turn 2 starts with them in place; it changes one and leaves the other.
    const two = await prepareArtifacts(thread.id);
    expect(await readFile(path.join(two.dir, "chart.html"), "utf8")).toBe("<h1>v1</h1>");
    await writeFile(path.join(two.dir, "chart.html"), "<h1>v2</h1>");
    await writeFile(path.join(two.dir, "big.png"), Buffer.alloc(11 * 1024 * 1024));
    const second = await collectArtifacts(two, "run-2");
    await destroyArtifactsDir(two);
    expect(second.saved.map((a) => [a.name, a.version])).toEqual([["chart.html", 2]]);
    expect(second.skipped).toEqual(["big.png"]);

    const rows = await prisma.artifact.findMany({ where: { threadId: thread.id }, orderBy: [{ name: "asc" }, { version: "asc" }] });
    expect(rows.map((r) => [r.name, r.version, r.runId, r.mime])).toEqual([
      ["chart.html", 1, "run-1", "text/html"],
      ["chart.html", 2, "run-2", "text/html"],
      ["reports/summary.md", 1, "run-1", "text/markdown"],
    ]);
    expect(Buffer.from(rows[1]!.content).toString()).toBe("<h1>v2</h1>");
  } finally {
    await prisma.thread.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("the agent is told about /artifacts", () => {
  expect(runExtras({ artifacts: true }).join("\n")).toContain("write it to /artifacts");
  expect(runExtras({}).join("\n")).not.toContain("/artifacts");
});

test("in the sandbox, the agent can write /artifacts and change what's there", async () => {
  const { runContainerCommand, sandboxUser } = await import("../src/docker");
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `art-c-${Date.now()}` } });
  const thread = await prisma.thread.create({ data: { userId: user.id, repo: "acme/a", baseBranch: "main", harness: "native-claude", title: "x", branch: "agent/x" } });
  try {
    await prisma.artifact.create({ data: { threadId: thread.id, runId: "r0", name: "data.csv", kind: "csv", mime: "text/csv", content: Buffer.from("a,b\n1,2\n"), size: 8, sha256: "x", version: 1 } });
    const art = await prepareArtifacts(thread.id);
    const r = await runContainerCommand([
      "-v", `${art.dir}:/artifacts`, "--network", "none", "--user", sandboxUser(), "cloud-agents-base", "sh", "-c",
      "echo '3,4' >> /artifacts/data.csv && mkdir -p /artifacts/shots && printf '<svg/>' > /artifacts/shots/after.svg && echo ok",
    ]);
    expect(r.stdout.trim()).toBe("ok");
    const got = await collectArtifacts(art, "r1");
    await destroyArtifactsDir(art);
    expect(got.saved.map((a) => [a.name, a.version])).toEqual([["data.csv", 2], ["shots/after.svg", 1]]);
  } finally {
    await prisma.thread.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});
