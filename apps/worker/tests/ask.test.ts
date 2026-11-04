import { test, expect } from "bun:test";
import { rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@repo/db";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { type ContainerOptions } from "../src/docker";
import { createFixtureRepo } from "./test-helpers";

test("a question the agent asks with ask_user flags its session until the user answers", async () => {
  const fixture = await createFixtureRepo();
  const repo = fixture.repoPath;
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `ask-${Date.now()}` } });
  const thread = await prisma.thread.create({
    data: { userId: user.id, repo, baseBranch: "main", harness: "native-claude", title: "Dates", branch: "agent/ask-test", settledAt: new Date() },
  });
  const outside = path.join(repo, "..", `ask-host-secret-${Date.now()}.json`);
  await writeFile(outside, JSON.stringify({ question: "HOST SECRET" }));
  const seen: ContainerOptions[] = [];
  const stub = (write: (dir: string) => Promise<void>) =>
    async function* (_ws: unknown, _task: string, _h: string, _id: string, options: ContainerOptions = {}) {
      seen.push(options);
      if (options.askDir) await write(options.askDir);
      yield { seq: 0, ts: Date.now(), kind: "text" as const, data: "Parsed the easy ones; I need one decision from you." };
      yield { seq: 1, ts: Date.now(), kind: "done" as const, data: { result: "ok" } };
    };
  const turn = async (write: (dir: string) => Promise<void>) => {
    const s = stub(write);
    await prisma.run.create({ data: { status: "queued", repo, baseBranch: "main", prompt: "Parse the dates", harness: "native-claude", userId: user.id, threadId: thread.id } });
    const run = (await claimRun("worker-1"))!;
    await processRun(run, "worker-1", s as never);
    return run.id;
  };
  try {
    const runId = await turn(async (dir) => writeFile(path.join(dir, "question.json"), JSON.stringify({ question: "Should dates without a zone be UTC or local?" })));
    expect(seen[0]!.systemAppend).toContain("ask_user");
    const t = await prisma.thread.findUnique({ where: { id: thread.id } });
    expect(t).toMatchObject({ needsInput: "Should dates without a zone be UTC or local?", settledAt: null });
    const event = await prisma.runEvent.findFirst({ where: { runId, kind: "status" }, orderBy: { seq: "desc" } });
    expect(event?.data).toEqual({ type: "ask_user", question: "Should dates without a zone be UTC or local?" });

    // A symlink where the question should be is never followed; the old question stands until the user answers.
    await turn(async (dir) => symlink(outside, path.join(dir, "question.json")));
    expect((await prisma.thread.findUnique({ where: { id: thread.id } }))!.needsInput).toBe("Should dates without a zone be UTC or local?");
    expect(JSON.stringify(await prisma.thread.findUnique({ where: { id: thread.id } }))).not.toContain("HOST SECRET");
  } finally {
    await rm(outside, { force: true });
    await prisma.run.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
  }
});

test("a secret the agent asks for is read as a name and hosts, never anything else", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { readSecretRequest } = await import("../src/ask");
  const dir = await mkdtemp(path.join(tmpdir(), "ask-secret-"));
  try {
    expect(await readSecretRequest(dir)).toBeNull();
    await writeFile(path.join(dir, "secret.json"), JSON.stringify({ name: "STRIPE_KEY", description: "Test key", hosts: ["api.stripe.com", "not a host"], value: "x" }));
    expect(await readSecretRequest(dir)).toEqual({ name: "STRIPE_KEY", description: "Test key", hosts: ["api.stripe.com"] });
    await writeFile(path.join(dir, "secret.json"), JSON.stringify({ name: "bad name", hosts: ["api.stripe.com"] }));
    expect(await readSecretRequest(dir)).toBeNull();
    await writeFile(path.join(dir, "secret.json"), JSON.stringify({ name: "STRIPE_KEY", hosts: [] }));
    expect(await readSecretRequest(dir)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
