import { test, expect } from "bun:test";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { prisma, createAccessToken } from "@repo/db";
import { processHandoffs } from "../src/handoff";
import { threadHome } from "../src/process-run";
import { createFixtureRepo } from "./test-helpers";

const git = (repo: string, ...args: string[]) => Bun.$`git -C ${repo} ${args}`.quiet().text().then((s) => s.trim());
const SID = "5b2d7c10-1111-4222-8333-944455556666";
const SCRIPT = path.resolve(import.meta.dir, "../../api/static/cloudly-import.mjs");

test("pull: the branch checked out here, and Claude Code's own session where Claude looks for it", async () => {
  const fixture = await createFixtureRepo();
  const origin = fixture.repoPath;
  const branch = `agent/thread-${Date.now()}`;
  await git(origin, "checkout", "-q", "-b", branch);
  await Bun.write(path.join(origin, "cart.ts"), "export const cart = [];\n");
  await git(origin, "add", "-A");
  await git(origin, "commit", "-q", "-m", "cart");
  const sha = await git(origin, "rev-parse", "HEAD");
  await git(origin, "checkout", "-q", "-");

  const work = await mkdtemp(path.join(tmpdir(), "pull-"));
  const local = path.join(work, "shop");
  const home = path.join(work, "home");
  await Bun.$`git clone -q ${origin} ${local}`.quiet();

  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `pull-${Date.now()}` } });
  const thread = await prisma.thread.create({ data: { userId: user.id, repo: origin, baseBranch: "main", harness: "native-claude", title: "Cart", branch, agentSessionId: SID } });
  await prisma.run.create({ data: { userId: user.id, threadId: thread.id, repo: origin, baseBranch: "main", harness: "native-claude", prompt: "Add a cart", status: "succeeded", commitSha: sha } });
  // Claude's session in the sandbox, as Claude wrote it there.
  const claudeDir = path.join(await threadHome(thread.id), ".claude", "projects", "-workspace");
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, `${SID}.jsonl`), [
    { type: "user", uuid: "u1", parentUuid: null, sessionId: SID, cwd: "/workspace", message: { role: "user", content: "Add a cart" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: SID, cwd: "/workspace", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Write", input: { file_path: "/workspace/cart.ts" } }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const { token } = await createAccessToken(user.id, "test");

  // The API at /api, the way the web app serves it, and a worker picking up handoffs.
  // Loaded by path so the worker's typecheck doesn't take in the API's sources.
  const apiPath = "../../api/src/index";
  const { default: api } = (await import(apiPath)) as { default: { fetch: (req: Request) => Response | Promise<Response> } };
  const server = Bun.serve({ port: 0, fetch: (req) => {
    const u = new URL(req.url);
    return api.fetch(new Request(`http://api${u.pathname.replace(/^\/api/, "")}${u.search}`, req));
  } });
  const worker = setInterval(() => processHandoffs().catch(() => {}), 200);
  const pull = async (...extra: string[]) => {
    const p = Bun.spawn(["node", SCRIPT, "pull", `http://127.0.0.1:${server.port}/app/s/${thread.id}`, ...extra], {
      cwd: local, env: { PATH: process.env.PATH!, HOME: home, CLOUDLY_TOKEN: token }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };
  try {
    const first = await pull();
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(first.out).toContain(`claude --resume ${SID}`);
    expect(await git(local, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(await readFile(path.join(local, "cart.ts"), "utf8")).toBe("export const cart = [];\n");
    const placed = await readFile(path.join(home, ".claude", "projects", local.replace(/[^a-zA-Z0-9]/g, "-"), `${SID}.jsonl`), "utf8");
    expect(placed).toContain(`"cwd":"${local}"`);
    expect(placed).toContain(`"file_path":"${local}/cart.ts"`);
    expect(placed).not.toContain("/workspace");

    // Another agent: the conversation as its first message, kept inside .git so it's never committed.
    await writeFile(path.join(local, "scratch.txt"), "mine\n");
    const dirty = await pull("--agent", "codex");
    expect(dirty.code).toBe(1);
    expect(dirty.err).toContain("uncommitted changes");
    await rm(path.join(local, "scratch.txt"));
    const codex = await pull("--agent", "codex");
    expect(codex.code).toBe(0);
    expect(codex.out).toContain(`codex "$(cat '${path.join(local, ".git", `cloudly-handoff-${thread.id.slice(0, 8)}.md`)}')"`);
    const prompt = await readFile(path.join(local, ".git", `cloudly-handoff-${thread.id.slice(0, 8)}.md`), "utf8");
    expect(prompt).toContain("User: Add a cart");
    expect(prompt).toContain("Carry on with this work on my computer.");

    // A turn still running: not yet.
    await prisma.run.create({ data: { userId: user.id, threadId: thread.id, repo: origin, baseBranch: "main", harness: "native-claude", prompt: "more", status: "running" } });
    const busy = await pull();
    expect(busy.code).toBe(1);
    expect(busy.err).toContain("still running");
  } finally {
    clearInterval(worker);
    server.stop(true);
    await prisma.thread.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await fixture.cleanup();
    await rm(work, { recursive: true, force: true });
  }
}, 120_000);
