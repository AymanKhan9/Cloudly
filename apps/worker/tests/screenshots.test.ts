import { test, expect } from "bun:test";
import path from "node:path";
import { chmod } from "node:fs/promises";

import { prisma } from "@repo/db";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { patchFiles, touchesUi, pageSlug, withScreenshotSection } from "../src/screenshots";
import { createFixtureRepo } from "./test-helpers";

const git = (repo: string, ...args: string[]) => Bun.$`git -C ${repo} ${args}`.quiet().text().then((s) => s.trim());

test("which changes get screenshots, page names, and the pull request section", () => {
  const patch = "diff --git a/src/App.tsx b/src/App.tsx\n--- a/src/App.tsx\n+++ b/src/App.tsx\ndiff --git a/README.md b/README.md\n";
  expect(patchFiles(patch)).toEqual(["src/App.tsx", "README.md"]);
  expect(touchesUi(["src/App.tsx"])).toBe(true);
  expect(touchesUi(["styles/main.scss"])).toBe(true);
  expect(touchesUi(["public/logo.png"])).toBe(true);
  expect(touchesUi(["src/db.ts", "README.md", "package.json"])).toBe(false);
  expect(pageSlug("/")).toBe("home");
  expect(pageSlug("/settings/billing?tab=2")).toBe("settings-billing");
  const once = withScreenshotSection("Opened by Cloudly.", "### Screenshots\nA");
  expect(once).toBe("Opened by Cloudly.\n\n<!-- cloudly:screenshots -->\n### Screenshots\nA\n<!-- /cloudly:screenshots -->");
  expect(withScreenshotSection(`${once}\n\nAuthor's note`, "### Screenshots\nB")).toBe("Opened by Cloudly.\n\n<!-- cloudly:screenshots -->\n### Screenshots\nB\n<!-- /cloudly:screenshots -->\n\nAuthor's note");
});

test("the screenshots turn starts the app after and before the change, and keeps each page's pair", async () => {
  const fixture = await createFixtureRepo();
  const repo = fixture.repoPath;
  const branch = `agent/shots-${Date.now()}`;
  // A stand-in for Chromium: saves what the page served, so the test can tell the two apart.
  const browser = [
    "#!/bin/bash",
    'for a in "$@"; do case "$a" in --screenshot=*) out="${a#--screenshot=}";; http*) url="$a";; esac; done',
    'node -e "fetch(process.argv[1]).then(r=>r.text()).then(t=>require(\'fs\').writeFileSync(process.argv[2],t))" "$url" "$out"',
  ].join("\n");
  await Bun.write(path.join(repo, ".shot.sh"), browser + "\n");
  await chmod(path.join(repo, ".shot.sh"), 0o755);
  await Bun.write(path.join(repo, "page.txt"), "old\n");
  await Bun.write(path.join(repo, "server.js"), "require('http').createServer((q,s)=>s.end(require('fs').readFileSync('page.txt','utf8').trim()+' '+q.url)).listen(process.env.PORT)\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "app");
  await git(repo, "checkout", "-q", "-b", branch);
  await Bun.write(path.join(repo, "page.txt"), "new\n");
  await Bun.write(path.join(repo, "style.css"), "body{}\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "change");
  const after = await git(repo, "rev-parse", "HEAD");
  await git(repo, "checkout", "-q", "-");

  const prev = { image: process.env.CLOUDLY_SHOT_IMAGE, browser: process.env.CLOUDLY_SHOT_BROWSER, wait: process.env.CLOUDLY_SHOT_WAIT };
  process.env.CLOUDLY_SHOT_IMAGE = "cloud-agents-base";
  process.env.CLOUDLY_SHOT_BROWSER = "/workspace/.shot.sh";
  process.env.CLOUDLY_SHOT_WAIT = "30";
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `shots-${Date.now()}` } });
  await prisma.repoSettings.upsert({
    where: { repo },
    update: {},
    create: { repo, screenshots: true, screenshotCommand: "node server.js", screenshotPort: 4111, screenshotPaths: ["/", "/settings?tab=1"] },
  });
  try {
    const thread = await prisma.thread.create({ data: { userId: user.id, repo, baseBranch: "main", harness: "native-claude", title: "Restyle", branch } });
    const turn = await prisma.run.create({ data: { userId: user.id, threadId: thread.id, repo, baseBranch: "main", harness: "native-claude", prompt: "Restyle", status: "succeeded", commitSha: after, createdAt: new Date(Date.now() - 5000) } });
    const shoot = async () => {
      const r = await prisma.run.create({ data: { userId: user.id, threadId: thread.id, repo, baseBranch: "main", harness: "native-claude", status: "queued", kind: "screenshots", targetRunId: turn.id, prompt: "Screenshots of the change" } });
      await processRun((await claimRun("worker-shots"))!, "worker-shots");
      return prisma.run.findUniqueOrThrow({ where: { id: r.id } });
    };
    const first = await shoot();
    expect(first.error).toBeNull();
    expect(first.output).toBe("Screenshots of turn 1, before and after: `/`, `/settings?tab=1`.");
    const shots = await prisma.artifact.findMany({ where: { threadId: thread.id }, orderBy: { name: "asc" } });
    expect(shots.map((s) => [s.name, Buffer.from(s.content).toString(), s.runId === first.id])).toEqual([
      ["shots/home/after.png", "new /", true],
      ["shots/home/before.png", "old /", true],
      ["shots/settings/after.png", "new /settings?tab=1", true],
      ["shots/settings/before.png", "old /settings?tab=1", true],
    ]);
    // The same pages again: no new versions.
    const second = await shoot();
    expect(second.output).toContain("They look the same as last time.");
    expect(await prisma.artifact.count({ where: { threadId: thread.id } })).toBe(4);
  } finally {
    Object.assign(process.env, { CLOUDLY_SHOT_IMAGE: prev.image ?? "", CLOUDLY_SHOT_BROWSER: prev.browser ?? "", CLOUDLY_SHOT_WAIT: prev.wait ?? "" });
    for (const k of ["CLOUDLY_SHOT_IMAGE", "CLOUDLY_SHOT_BROWSER", "CLOUDLY_SHOT_WAIT"] as const) if (!process.env[k]) delete process.env[k];
    await prisma.repoSettings.deleteMany({ where: { repo } });
    await prisma.thread.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
  }
}, 180_000);
