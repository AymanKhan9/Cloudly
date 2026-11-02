import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { gunzipSync, gzipSync } from "node:zlib";
import { prisma, harnessAvailable, budgetStatus, harnessUsesPlan, accessTokenOwner, seal } from "@repo/db";
import {
  parseSession, canResumeNatively, githubRepoFromUrl, IMPORT_SOURCES, IMPORT_LIMITS, type ParsedSession,
} from "@repo/shared/session-import";
import { userFromSessionCookie, type AuthEnv } from "./middleware/auth_middleware";
import { SESSION_COOKIE_NAME } from "./session";
import { HARNESSES, listHarnesses } from "./harnesses";
import { listInstallationRepos } from "./github";

// Importing a session from a coding agent run elsewhere (see
// @repo/shared/session-import): from the web app (signed in), or from the
// import command on the user's machine (a personal token from Settings).

export const imports = new Hono<AuthEnv>();

imports.use("*", createMiddleware<AuthEnv>(async (c, next) => {
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  if (bearer) {
    const owner = await accessTokenOwner(bearer);
    const user = owner ? await prisma.user.findUnique({ where: { id: owner.userId } }) : null;
    if (!user) return c.json({ message: "That token isn't valid. Create one in Cloudly under Settings > Shared context, or on the Import page." }, 401);
    c.set("user", { id: user.id, login: user.login, avatarUrl: user.avatarUrl });
    return next();
  }
  const user = await userFromSessionCookie(getCookie(c, SESSION_COOKIE_NAME));
  if (!user) return c.json({ message: "Sign in required" }, 401);
  c.set("user", user);
  await next();
}));

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

const ImportSchema = z.object({
  file: z.object({
    name: z.string().max(300),
    /** The file as text, or gzipped and base64-encoded (smaller to send). */
    content: z.string().optional(),
    gzip: z.string().optional(),
  }),
  /** Only read it and say what's in it. */
  preview: z.boolean().optional(),
  repo: z.string().regex(SLUG, "expected owner/repo").optional(),
  baseBranch: z.string().regex(REF).optional(),
  /** Where the session's code starts: a branch with its work on it. The base branch when left out. */
  startFrom: z.string().regex(REF).optional(),
  /** The agent that carries on; the one that wrote the session when it's available here. */
  harness: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
  /** A first message, sent once the session is set up. */
  prompt: z.string().trim().max(8000).optional(),
  title: z.string().trim().min(1).max(120).optional(),
});

function readFile(file: z.infer<typeof ImportSchema>["file"]): string | { error: string } {
  if (file.content !== undefined) return file.content;
  if (!file.gzip) return { error: "The file is missing." };
  try {
    const text = gunzipSync(Buffer.from(file.gzip, "base64"), { maxOutputLength: IMPORT_LIMITS.fileBytes }).toString("utf8");
    return text;
  } catch {
    return { error: "Couldn't unpack the file (it should be gzipped, then base64), or it's bigger than 64 MB." };
  }
}

/** The agent to carry on with: the one asked for, else the one that wrote the session, else the first one ready. */
async function pickHarness(asked: string | undefined, parsed: ParsedSession): Promise<{ id: string } | { error: string }> {
  const builtin = HARNESSES.map((h) => h.id);
  if (asked) return (await harnessAvailable(asked, builtin)) ? { id: asked } : { error: `The agent "${asked}" isn't available here.` };
  const own = IMPORT_SOURCES[parsed.source].harness;
  if (own && (await harnessAvailable(own, builtin))) return { id: own };
  const ready = (await listHarnesses()).find((h) => h.ready);
  return ready ? { id: ready.id } : { error: "No agent is set up yet. Add one under Settings." };
}

function preview(parsed: ParsedSession) {
  return {
    source: parsed.source,
    sourceName: IMPORT_SOURCES[parsed.source].name,
    sourceHarness: IMPORT_SOURCES[parsed.source].harness,
    title: parsed.title,
    sessionId: parsed.sessionId ?? null,
    cwd: parsed.cwd ?? null,
    gitBranch: parsed.gitBranch ?? null,
    repo: githubRepoFromUrl(parsed.repoUrl),
    turns: parsed.turns.length,
    dropped: parsed.dropped,
    toolCalls: parsed.turns.reduce((n, t) => n + t.steps.filter((s) => s.t === "tool").length, 0),
    hasSummary: Boolean(parsed.summary),
    canResume: canResumeNatively(parsed),
    prompts: parsed.turns.slice(0, 3).map((t) => t.prompt.slice(0, 200)),
    lastPrompt: parsed.turns.at(-1)?.prompt.slice(0, 200) ?? null,
  };
}

imports.post("/", zValidator("json", ImportSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const content = readFile(body.file);
  if (typeof content !== "string") return c.json({ message: content.error }, 400);
  const parsed = parseSession(body.file.name, content);
  if ("error" in parsed) return c.json({ message: parsed.error }, 400);
  if (parsed.turns.length === 0 && !parsed.summary) return c.json({ message: "There's no conversation in that file to import." }, 400);
  if (body.preview) return c.json({ preview: preview(parsed) });

  const repo = body.repo ?? githubRepoFromUrl(parsed.repoUrl);
  if (!repo) return c.json({ message: "Which repository is this session about? Choose one." }, 400);
  // The GitHub App has to reach it, or no turn can clone it. (If GitHub can't be asked, the first turn will say.)
  const reachable = await listInstallationRepos().catch(() => null);
  const found = reachable?.find((r) => r.fullName.toLowerCase() === repo.toLowerCase());
  if (reachable && !found) return c.json({ message: `Cloudly's GitHub App can't reach ${repo}. Add it to the app's installation first.` }, 400);
  const baseBranch = body.baseBranch ?? found?.defaultBranch ?? "main";
  const startFrom = body.startFrom && body.startFrom !== baseBranch ? body.startFrom : null;

  const picked = await pickHarness(body.harness, parsed);
  if ("error" in picked) return c.json({ message: picked.error }, 400);
  const harness = picked.id;
  const budget = await budgetStatus(user.id);
  if (budget.state === "storm" && !(await harnessUsesPlan(harness))) {
    return c.json({ message: "Monthly spend limit reached. Raise it in Settings to start new sessions.", budget }, 402);
  }

  const source = IMPORT_SOURCES[parsed.source];
  const id = crypto.randomUUID();
  // The import command pushes the local work to a branch of its own: the session carries on there.
  const branch = startFrom?.startsWith("cloudly/import-") ? startFrom : `agent/import-${id.slice(0, 8)}`;
  // The original file, for the agent that wrote it to resume its own session.
  const file = canResumeNatively(parsed) ? await seal(gzipSync(content).toString("base64")) : null;
  const turnHarness = source.harness ?? harness;
  const t0 = Date.now() - parsed.turns.length - 5;
  const turnIds = parsed.turns.map(() => crypto.randomUUID());

  await prisma.$transaction(async (tx) => {
    await tx.thread.create({
      data: {
        id, userId: user.id, repo: found?.fullName ?? repo, baseBranch, harness, branch,
        title: body.title ?? parsed.title,
        autoMerge: (await tx.repoSettings.findUnique({ where: { repo }, select: { autoMerge: true } }))?.autoMerge ?? false,
        imported: {
          create: {
            source: parsed.source, sessionId: parsed.sessionId ?? null, cwd: parsed.cwd ?? null,
            fileName: file ? body.file.name.split(/[\\/]/).pop()!.slice(0, 200) : null, file,
            summary: parsed.summary ?? null, startFrom, turns: parsed.turns.length, dropped: parsed.dropped,
          },
        },
      },
    });
    // The conversation so far, as finished turns.
    await tx.run.createMany({
      data: parsed.turns.map((t, i) => ({
        id: turnIds[i]!, repo, baseBranch, harness: turnHarness, userId: user.id, threadId: id,
        status: "succeeded" as const, kind: "import_turn", prompt: t.prompt,
        output: t.steps.filter((s) => s.t === "text").map((s) => (s as { text: string }).text).join("\n\n").slice(0, 20_000) || null,
        createdAt: new Date(t0 + i),
      })),
    });
    await tx.runEvent.createMany({
      data: parsed.turns.flatMap((t, i) =>
        t.steps.map((s, seq) => ({
          runId: turnIds[i]!, seq, kind: s.t === "text" ? ("text" as const) : ("tool_call" as const),
          data: s.t === "text" ? s.text : { title: s.title, imported: true },
        })),
      ),
    });
    // The worker sets up the branch and the agent's own session, then the first message runs.
    await tx.run.create({
      data: {
        repo, baseBranch, harness, userId: user.id, threadId: id, status: "queued", kind: "import",
        prompt: `Import from ${source.name}`, createdAt: new Date(t0 + parsed.turns.length),
      },
    });
    if (body.prompt) {
      await tx.run.create({
        data: { repo, baseBranch, harness, userId: user.id, threadId: id, status: "queued", prompt: body.prompt, createdAt: new Date(t0 + parsed.turns.length + 1) },
      });
    }
  }, { timeout: 30_000 });
  return c.json({ id, harness, branch, preview: preview(parsed) }, 201);
});

/** The import command, to run on the machine the sessions are on, with this instance's address in it. */
export async function importCommand(): Promise<string> {
  const text = await Bun.file(new URL("../static/cloudly-import.mjs", import.meta.url)).text();
  const origin = process.env.WEB_ORIGIN ? new URL(process.env.WEB_ORIGIN).origin : null;
  return origin ? text.replace('"__CLOUDLY_URL__"', JSON.stringify(origin)) : text;
}
