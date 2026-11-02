import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma } from "@repo/db";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { detectCheckCommand, checkCommandFor } from "../src/checks";
import { createFixtureRepo } from "./test-helpers";

async function dirWith(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "detect-"));
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
  return dir;
}

test("the check command comes from the repo's own files", async () => {
  const cases: [Record<string, string>, string | null][] = [
    [{ "package.json": '{"scripts":{"test":"vitest run"}}', "bun.lock": "" }, "bun install && bun run test"],
    [{ "package.json": '{"scripts":{"test":"jest"}}', "pnpm-lock.yaml": "" }, "corepack pnpm install && corepack pnpm test"],
    [{ "package.json": '{"scripts":{"test":"jest"}}' }, "npm install --no-audit --no-fund && npm test"],
    // npm init's placeholder isn't a test suite.
    [{ "package.json": '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' }, null],
    [{ "pyproject.toml": "[tool.pytest.ini_options]\n", "requirements.txt": "requests\n" }, "python3 -m pip install -q -r requirements.txt && python3 -m pytest -q"],
    [{ "go.mod": "module x\n" }, "go test ./..."],
    [{ "Cargo.toml": "[package]\n" }, "cargo test"],
    [{ Makefile: "build:\n\tcc x.c\ntest:\n\t./run-tests\n" }, "make test"],
    [{ "README.md": "# nothing to run" }, null],
    [{ "package.json": "{not json" }, null],
  ];
  for (const [files, expected] of cases) {
    const dir = await dirWith(files);
    try {
      expect(await detectCheckCommand(dir)).toBe(expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("detection reads regular files only, and settings decide", async () => {
  const dir = await dirWith({});
  try {
    // An agent's symlink to a host file isn't followed.
    await symlink("/etc/hostname", path.join(dir, "package.json"));
    expect(await detectCheckCommand(dir)).toBeNull();
    expect(await checkCommandFor({ checks: "off", checkCommand: "make test" }, dir)).toBeNull();
    expect(await checkCommandFor({ checks: "custom", checkCommand: "  make lint  " }, dir)).toBe("make lint");
    expect(await checkCommandFor({ checks: "custom", checkCommand: null }, dir)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

type Stub = (ws: { runDir: string }) => Promise<void>;

/** A session on a fixture repo, with the repo's checks set to `command`. */
async function session(command: string | null, extra: { fixAttempts?: number; checkTimeoutSec?: number; checks?: string } = {}) {
  const fixture = await createFixtureRepo();
  const repo = fixture.repoPath;
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `checks-${Date.now()}` } });
  const thread = await prisma.thread.create({ data: { userId: user.id, repo, baseBranch: "main", harness: "gemini-acp", title: "t", branch: `agent/checks-${Date.now()}` } });
  await prisma.repoSettings.create({ data: { repo, checks: extra.checks ?? "custom", checkCommand: command, fixAttempts: extra.fixAttempts ?? 2, checkTimeoutSec: extra.checkTimeoutSec ?? 120 } });
  const prompts: string[] = [];
  /** Runs whatever is queued next in the session with this stand-in agent. */
  const next = async (agent: Stub) => {
    const run = await claimRun("worker-checks");
    if (!run) return null;
    async function* stub(ws: { runDir: string }, task: string) {
      prompts.push(task);
      await agent(ws);
      yield { seq: 0, ts: Date.now(), kind: "text" as const, data: "did it" };
      yield { seq: 1, ts: Date.now(), kind: "done" as const, data: { result: "ok" } };
    }
    await processRun(run, "worker-checks", stub as never);
    return prisma.run.findUniqueOrThrow({ where: { id: run.id } });
  };
  const ask = (prompt: string) =>
    prisma.run.create({ data: { status: "queued", repo, baseBranch: "main", prompt, harness: "gemini-acp", userId: user.id, threadId: thread.id } });
  const cleanup = async () => {
    await prisma.repoSettings.deleteMany({ where: { repo } });
    await prisma.run.deleteMany({ where: { threadId: thread.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
  };
  return { thread, next, ask, prompts, cleanup };
}

const write = (name: string, text = "x\n"): Stub => async (ws) => {
  await Bun.write(path.join(ws.runDir, name), text);
};

test("checks run after a change; when they fail the agent gets turns to fix them, then the session waits for the user", async () => {
  // Passes once ok.txt exists; prints what it found either way.
  const s = await session('ls; test -f ok.txt && echo "all good" || { echo "ok.txt is missing"; exit 1; }');
  try {
    await s.ask("Add the feature");
    const first = (await s.next(write("feature.txt")))!;
    expect(first.status).toBe("succeeded");
    expect(first.checkStatus).toBe("failed");
    expect(first.checkOutput).toContain("ok.txt is missing");
    expect(first.commitSha).toBeTruthy(); // the change is still committed, with its failing checks noted

    // Fix attempt 1: the agent gets the command and the output, and fails again.
    const fix1 = (await s.next(write("other.txt")))!;
    expect(fix1.kind).toBe("fix");
    expect(fix1.prompt).toStartWith("Fix the failing checks (attempt 1 of 2)");
    expect(s.prompts[1]).toContain("ok.txt is missing");
    expect(s.prompts[1]).toContain("Don't skip, delete or weaken tests");
    expect(fix1.checkStatus).toBe("failed");

    // Attempt 2 fails too: no third, and the session asks the user.
    const fix2 = (await s.next(write("still-not-it.txt")))!;
    expect(fix2.prompt).toStartWith("Fix the failing checks (attempt 2 of 2)");
    expect(await s.next(write("never.txt"))).toBeNull();
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: s.thread.id } });
    expect(thread.needsInput).toContain("still fail after 2 fix attempts");
    const events = await prisma.runEvent.findMany({ where: { runId: fix2.id } });
    expect(events.some((e) => (e.data as { type?: string } | null)?.type === "checks.gave_up")).toBe(true);

    // The user's next message starts a fresh count; this time the agent fixes it.
    await s.ask("Try creating ok.txt");
    const fixed = (await s.next(write("ok.txt")))!;
    expect(fixed.checkStatus).toBe("passed");
    expect(fixed.checkOutput).toContain("all good");
    expect(await s.next(write("never.txt"))).toBeNull();
  } finally {
    await s.cleanup();
  }
}, 180000);

test("a missing tool, checks that are off, and a turn without changes queue nothing", async () => {
  const missing = await session("definitely-not-installed-tool --run");
  try {
    await missing.ask("Change something");
    const run = (await missing.next(write("a.txt")))!;
    expect(run.checkStatus).toBe("error");
    expect(run.checkOutput).toContain("isn't installed in the sandbox");
    expect(await missing.next(write("b.txt"))).toBeNull();
  } finally {
    await missing.cleanup();
  }

  const off = await session(null, { checks: "off" });
  try {
    await off.ask("Change something");
    const run = (await off.next(write("a.txt")))!;
    expect(run.checkStatus).toBe("skipped");
    // A question with no change isn't checked at all.
    await off.ask("Just explain the code");
    expect((await off.next(async () => {}))!.checkStatus).toBeNull();
  } finally {
    await off.cleanup();
  }

  const noFixes = await session("exit 1", { fixAttempts: 0 });
  try {
    await noFixes.ask("Change something");
    expect((await noFixes.next(write("a.txt")))!.checkStatus).toBe("failed");
    expect(await noFixes.next(write("b.txt"))).toBeNull();
  } finally {
    await noFixes.cleanup();
  }
}, 180000);

test("checks that hang are stopped at the time limit and count as failing", async () => {
  const s = await session("sleep 60", { checkTimeoutSec: 3, fixAttempts: 0 });
  try {
    await s.ask("Change something");
    const run = (await s.next(write("a.txt")))!;
    expect(run.checkStatus).toBe("failed");
    expect(run.checkOutput).toContain("Cloudly stopped the checks");
    expect(run.checkMs!).toBeLessThan(30_000);
  } finally {
    await s.cleanup();
  }
}, 120000);
