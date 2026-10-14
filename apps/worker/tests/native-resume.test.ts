import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma } from "@repo/db";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { createFixtureRepo } from "./test-helpers";

test("a Claude session resumes its own conversation across turns, and falls back to the transcript without one", async () => {
  process.env.CLOUDLY_DATA_DIR = await mkdtemp(path.join(tmpdir(), "resume-test-"));
  const fixture = await createFixtureRepo();
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `resume-${Date.now()}` } });
  const thread = await prisma.thread.create({
    data: { userId: user.id, repo: fixture.repoPath, baseBranch: "main", harness: "native-claude", title: "t", branch: "agent/thread-resume" },
  });
  const seen: { task: string; resume?: string; homeDir?: string }[] = [];
  async function* stub(_ws: unknown, task: string, _h: string, _id: string, o?: { resume?: string; homeDir?: string }) {
    seen.push({ task, resume: o?.resume, homeDir: o?.homeDir });
    yield { seq: 0, ts: Date.now(), kind: "text" as const, data: `reply ${seen.length}` };
    yield { seq: 1, ts: Date.now(), kind: "done" as const, data: { result: "ok", sessionId: "sess-1" } };
  }
  const turn = async (prompt: string) => {
    await prisma.run.create({ data: { status: "queued", repo: fixture.repoPath, baseBranch: "main", prompt, harness: "native-claude", userId: user.id, threadId: thread.id } });
    await processRun((await claimRun("worker-1"))!, "worker-1", stub as any);
  };
  try {
    await turn("first");
    expect(seen[0]!.resume).toBeUndefined();
    expect(seen[0]!.homeDir).toBeTruthy();
    expect((await prisma.thread.findUniqueOrThrow({ where: { id: thread.id } })).agentSessionId).toBe("sess-1");

    // No session file on disk (say, a cleaned data dir): start clean, history in the prompt.
    await turn("second");
    expect(seen[1]!.resume).toBeUndefined();
    expect(seen[1]!.task).toContain("Earlier in this conversation");

    // With Claude's session file present, it resumes and gets only the new message.
    const dir = path.join(seen[0]!.homeDir!, ".claude", "projects", "-workspace");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "sess-1.jsonl"), "{}\n");
    await turn("third");
    expect(seen[2]!.resume).toBe("sess-1");
    expect(seen[2]!.task).toBe("third");
  } finally {
    delete process.env.CLOUDLY_DATA_DIR;
    await prisma.run.deleteMany({ where: { threadId: thread.id } });
    await prisma.thread.delete({ where: { id: thread.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
  }
}, 60000);

test("a Codex session resumes its own thread when its session file is on disk", async () => {
  process.env.CLOUDLY_DATA_DIR = await mkdtemp(path.join(tmpdir(), "resume-codex-"));
  const fixture = await createFixtureRepo();
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `resume-cx-${Date.now()}` } });
  const thread = await prisma.thread.create({
    data: { userId: user.id, repo: fixture.repoPath, baseBranch: "main", harness: "native-codex", title: "t", branch: "agent/thread-cx" },
  });
  const seen: { task: string; resume?: string; homeDir?: string }[] = [];
  async function* stub(_ws: unknown, task: string, _h: string, _id: string, o?: { resume?: string; homeDir?: string }) {
    seen.push({ task, resume: o?.resume, homeDir: o?.homeDir });
    yield { seq: 0, ts: Date.now(), kind: "status" as const, data: { type: "thread.started", thread_id: "019-cx" } };
    yield { seq: 1, ts: Date.now(), kind: "done" as const, data: { usage: {} } };
  }
  const turn = async (prompt: string) => {
    await prisma.run.create({ data: { status: "queued", repo: fixture.repoPath, baseBranch: "main", prompt, harness: "native-codex", userId: user.id, threadId: thread.id } });
    await processRun((await claimRun("worker-1"))!, "worker-1", stub as any);
  };
  try {
    await turn("first");
    await turn("second");
    expect(seen[1]!.resume).toBeUndefined(); // no session file yet

    const dir = path.join(seen[0]!.homeDir!, ".codex", "sessions", "2026", "10", "14");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "rollout-2026-10-14T04-37-35-019-cx.jsonl"), "{}\n");
    await turn("third");
    expect(seen[2]!.resume).toBe("019-cx");
    expect(seen[2]!.task.endsWith("third")).toBe(true);
    expect(seen[2]!.task).not.toContain("Earlier in this conversation");
  } finally {
    delete process.env.CLOUDLY_DATA_DIR;
    await prisma.run.deleteMany({ where: { threadId: thread.id } });
    await prisma.thread.delete({ where: { id: thread.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
  }
}, 60000);

test("a session's chosen model reaches every turn; Codex's /model is answered without a container", async () => {
  const fixture = await createFixtureRepo();
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `model-${Date.now()}` } });
  try {
    const claude = await prisma.thread.create({
      data: { userId: user.id, repo: fixture.repoPath, baseBranch: "main", harness: "native-claude", title: "t", branch: "agent/thread-m1", model: "sonnet" },
    });
    let seenModel: string | undefined;
    async function* stub(_ws: unknown, _t: string, _h: string, _id: string, o?: { model?: string }) {
      seenModel = o?.model;
      yield { seq: 0, ts: Date.now(), kind: "done" as const, data: { result: "ok" } };
    }
    await prisma.run.create({ data: { status: "queued", repo: fixture.repoPath, baseBranch: "main", prompt: "hi", harness: "native-claude", userId: user.id, threadId: claude.id } });
    await processRun((await claimRun("worker-1"))!, "worker-1", stub as any);
    expect(seenModel).toBe("sonnet");

    const codex = await prisma.thread.create({
      data: { userId: user.id, repo: fixture.repoPath, baseBranch: "main", harness: "native-codex", title: "t", branch: "agent/thread-m2" },
    });
    let containerRan = false;
    async function* never() {
      containerRan = true;
      yield { seq: 0, ts: Date.now(), kind: "done" as const, data: {} };
    }
    const r = await prisma.run.create({ data: { status: "queued", repo: fixture.repoPath, baseBranch: "main", prompt: "/model gpt-5.1", harness: "native-codex", userId: user.id, threadId: codex.id } });
    await processRun((await claimRun("worker-1"))!, "worker-1", never as any);
    expect(containerRan).toBe(false);
    const final = await prisma.run.findUniqueOrThrow({ where: { id: r.id }, include: { events: true } });
    expect(final.status).toBe("succeeded");
    expect(final.events.some((e) => String(e.data).includes("gpt-5.1"))).toBe(true);
  } finally {
    await prisma.run.deleteMany({ where: { userId: user.id } });
    await prisma.thread.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
  }
}, 60000);
