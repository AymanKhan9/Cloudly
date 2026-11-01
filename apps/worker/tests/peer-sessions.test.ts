import { test, expect } from "bun:test";
import { appendFile, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@repo/db";
import type { SessionsIndex } from "@repo/shared/sessions";
import { claimRun } from "../src/claim";
import { processRun } from "../src/process-run";
import { deliverMessages, prepareSessions, destroySessions } from "../src/peer-sessions";
import { type ContainerOptions } from "../src/docker";
import { createFixtureRepo } from "./test-helpers";

type Seen = { task: string; system?: string; options: ContainerOptions; index?: SessionsIndex; read?: Record<string, string> };

test("sessions read each other and talk: a message runs in the other session, and its reply comes back", async () => {
  const fixture = await createFixtureRepo();
  const other = await createFixtureRepo();
  const repo = fixture.repoPath;
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `peers-${Date.now()}` } });
  const mk = (harness: string, title: string, r = repo) =>
    prisma.thread.create({ data: { userId: user.id, repo: r, baseBranch: "main", harness, title, branch: `agent/peers-${title.replace(/\W+/g, "-")}` } });
  const parser = await mk("gemini-acp", "Build the date parser");
  const api = await mk("native-claude", "Add the invoices API");
  const elsewhere = await mk("native-codex", "Another repo's work", other.repoPath);

  const seen: Seen[] = [];
  const stub = (reply: string, act?: (dir: string) => Promise<void>) =>
    async function* (_ws: unknown, task: string, _h: string, _id: string, options: ContainerOptions = {}) {
      const entry: Seen = { task, system: options.systemAppend, options };
      if (options.sessionsDir) {
        entry.index = JSON.parse(await readFile(path.join(options.sessionsDir, "index.json"), "utf8"));
        entry.read = {};
        for (const s of entry.index!.sessions) entry.read[s.id] = await readFile(path.join(options.sessionsDir, `${s.id}.md`), "utf8");
        if (act) await act(options.sessionsDir);
      }
      seen.push(entry);
      yield { seq: 0, ts: Date.now(), kind: "text" as const, data: reply };
      yield { seq: 1, ts: Date.now(), kind: "done" as const, data: { result: "ok" } };
    };
  const next = async (s: ReturnType<typeof stub>) => processRun((await claimRun("worker-1"))!, "worker-1", s as never);
  const queue = (thread: { id: string; harness: string }, prompt: string) =>
    prisma.run.create({ data: { status: "queued", repo: thread.id === elsewhere.id ? other.repoPath : repo, baseBranch: "main", prompt, harness: thread.harness, userId: user.id, threadId: thread.id } });

  const outside = path.join(repo, "..", `peers-host-secret-${Date.now()}.txt`);
  await writeFile(outside, JSON.stringify({ to: parser.id, message: "HOST SECRET" }) + "\n");
  try {
    await queue(parser, "Build a date parser in parser.ts");
    await next(stub("The parser is in parser.ts and handles ISO dates."));

    // The API session sees this repo's sessions, not the other repo's, and reads the parser's work.
    await queue(api, "Use the parser from the other session for invoice dates");
    await next(stub("I asked the parser session.", async (dir) => {
      await appendFile(path.join(dir, "outbox.jsonl"), [
        JSON.stringify({ to: parser.id, message: "Does parse() handle time zones?", replyWanted: true }),
        JSON.stringify({ to: parser.id, message: "A second message to the same session" }),
        JSON.stringify({ to: elsewhere.id, message: "Not a session this one was shown" }),
        "not json",
        "",
      ].join("\n"));
    }));
    const apiTurn = seen.at(-1)!;
    expect(apiTurn.index!.self).toEqual({ id: api.id, title: "Add the invoices API" });
    expect(apiTurn.index!.sessions.map((s) => s.id)).toEqual([parser.id]);
    expect(apiTurn.index!.sessions[0]).toMatchObject({ title: "Build the date parser", agent: "Gemini CLI", status: "succeeded", turns: 1 });
    expect(apiTurn.read![parser.id]).toContain("User: Build a date parser in parser.ts");
    expect(apiTurn.read![parser.id]).toContain("Agent: The parser is in parser.ts and handles ISO dates.");
    expect(apiTurn.system).toContain("send_to_session");

    // The message became the parser session's next turn; nothing else was delivered.
    const sentRun = (await prisma.run.findMany({ where: { threadId: api.id } }))[0]!;
    const toParser = await prisma.run.findMany({ where: { threadId: parser.id, status: "queued" } });
    expect(toParser).toHaveLength(1);
    expect(toParser[0]).toMatchObject({ fromThreadId: api.id, fromRunId: sentRun.id, hops: 1, replyToThreadId: api.id, harness: "gemini-acp" });
    expect(toParser[0]!.prompt).toContain(`"Add the invoices API" (Claude Agent)`);
    expect(toParser[0]!.prompt).toContain("Does parse() handle time zones?");
    expect(await prisma.run.count({ where: { threadId: elsewhere.id } })).toBe(0);
    const sentEvent = await prisma.runEvent.findFirst({ where: { runId: sentRun.id, kind: "status" }, orderBy: { seq: "desc" } });
    expect(sentEvent?.data).toEqual({ type: "sessions.sent", to: [{ id: parser.id, title: "Build the date parser", replyWanted: true }] });

    // Delivering the same turn's messages again (a retried turn) sends nothing twice.
    await deliverMessages(sentRun, { ...api }, [{ to: parser.id, message: "Does parse() handle time zones?", replyWanted: true }]);
    expect(await prisma.run.count({ where: { threadId: parser.id, status: "queued" } })).toBe(1);

    // The parser session answers; its answer comes back to the API session as a turn.
    await next(stub("Yes: parse() keeps the offset and converts to UTC.", async (dir) => {
      // A symlink to a host file where the outbox should be: never read.
      await rm(path.join(dir, "outbox.jsonl"));
      await symlink(outside, path.join(dir, "outbox.jsonl"));
    }));
    expect(seen.at(-1)!.task).toContain("Does parse() handle time zones?");
    const back = await prisma.run.findMany({ where: { threadId: api.id, status: "queued" } });
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ fromThreadId: parser.id, hops: 2, replyToThreadId: null });
    expect(back[0]!.prompt).toContain(`"Build the date parser" (Gemini CLI)`);
    expect(back[0]!.prompt).toContain("Yes: parse() keeps the offset and converts to UTC.");
    expect(JSON.stringify(await prisma.run.findMany({ where: { userId: user.id } }))).not.toContain("HOST SECRET");

    // The reply turn runs like any other; it doesn't send a reply of its own.
    await next(stub("Using UTC dates for invoices."));
    expect(await prisma.run.count({ where: { userId: user.id, status: "queued" } })).toBe(0);
  } finally {
    await rm(outside, { force: true });
    await prisma.run.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
    await other.cleanup();
  }
});

test("scope, and the cap on chains of messages", async () => {
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `peers-scope-${Date.now()}` } });
  const mk = (repo: string, title: string, peers = "repo") =>
    prisma.thread.create({ data: { userId: user.id, repo, baseBranch: "main", harness: "native-claude", title, branch: `b-${title}`, peers } });
  const stranger = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `peers-other-${Date.now()}` } });
  try {
    const self = await mk("acme/a", "self");
    const same = await mk("acme/a", "same");
    const far = await mk("acme/b", "far");
    await prisma.thread.create({ data: { userId: stranger.id, repo: "acme/a", baseBranch: "main", harness: "native-claude", title: "theirs", branch: "x" } });

    const ids = async (thread: typeof self, hops = 0) => {
      const s = await prepareSessions({ userId: user.id, hops }, thread);
      if (!s) return null;
      await destroySessions(s);
      return { ids: s.index.sessions.map((x) => x.id).sort(), canSend: s.index.canSend };
    };
    // This repo's sessions by default; never another user's.
    expect(await ids(self)).toEqual({ ids: [same.id], canSend: 3 });
    // All of the user's, when asked for.
    expect(await ids({ ...self, peers: "all" })).toEqual({ ids: [same.id, far.id].sort(), canSend: 3 });
    expect(await ids({ ...self, peers: "off" })).toBeNull();
    // Four messages deep, a turn can read but not send.
    expect((await ids(self, 4))?.canSend).toBe(0);

    // Out of scope at delivery is refused even if the agent names it.
    const run = await prisma.run.create({ data: { status: "running", repo: "acme/a", baseBranch: "main", prompt: "x", harness: "native-claude", userId: user.id, threadId: self.id } });
    expect(await deliverMessages(run, self, [{ to: far.id, message: "hi", replyWanted: false }])).toEqual([]);
    expect(await prisma.run.count({ where: { threadId: far.id } })).toBe(0);
  } finally {
    await prisma.run.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.user.delete({ where: { id: stranger.id } });
  }
});
