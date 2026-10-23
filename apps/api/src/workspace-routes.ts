import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  prisma, listEnvSecrets, saveEnvSecret, envNameProblem, parseHostList, listRepoFiles, cleanFilePath,
  repoFileProblem, putRepoFile, REPO_FILE_MAX_BYTES, REPO_FILES_MAX_TOTAL, REPO_FILES_MAX_COUNT,
} from "@repo/db";
import type { AuthEnv } from "./middleware/auth_middleware";

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// ---------- Environment secrets (Settings) ----------

export const envSecrets = new Hono<AuthEnv>();

envSecrets.get("/", async (c) => c.json({ secrets: await listEnvSecrets() }));

const SecretSchema = z.object({
  name: z.string().trim().max(64),
  repo: z.string().trim().refine((r) => r === "*" || SLUG.test(r), "Pick a repository, or all of them."),
  value: z.string().max(20_000).optional(),
  hosts: z.string().max(5_000).default(""),
  exposed: z.boolean().default(false),
});

envSecrets.put("/", zValidator("json", SecretSchema), async (c) => {
  const body = c.req.valid("json");
  const problem = envNameProblem(body.name);
  if (problem) return c.json({ message: problem }, 400);
  const hosts = parseHostList(body.hosts).filter((h) => h !== "*");
  if (!body.exposed && hosts.length === 0) {
    return c.json({ message: "Name the hosts this value may be sent to, e.g. api.stripe.com. Or put the real value in the sandbox instead." }, 400);
  }
  try {
    await saveEnvSecret({ name: body.name, repo: body.repo, value: body.value || undefined, hosts: hosts.join("\n"), exposed: body.exposed });
  } catch (err) {
    return c.json({ message: err instanceof Error ? err.message : "Couldn't save." }, 400);
  }
  return c.json({ secrets: await listEnvSecrets() });
});

envSecrets.delete("/:id", async (c) => {
  await prisma.envSecret.deleteMany({ where: { id: c.req.param("id") } });
  return c.json({ secrets: await listEnvSecrets() });
});

// ---------- A repo's kept files (/files in every run) ----------

export const repoFiles = new Hono<AuthEnv>();

function repoOf(c: { req: { param: (k: string) => string } }): string | null {
  const repo = `${c.req.param("owner")}/${c.req.param("name")}`;
  return SLUG.test(repo) ? repo : null;
}

repoFiles.get("/:owner/:name", async (c) => {
  const repo = repoOf(c);
  if (!repo) return c.json({ message: "Expected owner/repo" }, 400);
  return c.json({
    files: await listRepoFiles(repo),
    limits: { fileBytes: REPO_FILE_MAX_BYTES, totalBytes: REPO_FILES_MAX_TOTAL, count: REPO_FILES_MAX_COUNT },
  });
});

repoFiles.put("/:owner/:name", async (c) => {
  const repo = repoOf(c);
  const path = cleanFilePath(c.req.query("path") ?? "");
  if (!repo || !path) return c.json({ message: "Give the file a plain relative path, like data/sample.csv." }, 400);
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > REPO_FILE_MAX_BYTES) return c.json({ message: `Files can be up to ${REPO_FILE_MAX_BYTES / 1048576} MB.` }, 413);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const problem = await repoFileProblem(repo, path, bytes.byteLength);
  if (problem) return c.json({ message: problem }, 413);
  await putRepoFile(repo, path, bytes);
  return c.json({ files: await listRepoFiles(repo) });
});

// Agent-written content: always a download, never rendered on Cloudly's origin.
repoFiles.get("/:owner/:name/content", async (c) => {
  const repo = repoOf(c);
  const path = cleanFilePath(c.req.query("path") ?? "");
  if (!repo || !path) return c.json({ message: "Not found" }, 404);
  const file = await prisma.repoFile.findUnique({ where: { repo_path: { repo, path } } });
  if (!file) return c.json({ message: "Not found" }, 404);
  const filename = path.split("/").at(-1)!.replace(/[^\w.-]+/g, "_");
  return new Response(new Uint8Array(file.content), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${filename}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "no-store",
    },
  });
});

repoFiles.delete("/:owner/:name", async (c) => {
  const repo = repoOf(c);
  const path = cleanFilePath(c.req.query("path") ?? "");
  if (!repo || !path) return c.json({ message: "Expected owner/repo and a path" }, 400);
  await prisma.repoFile.deleteMany({ where: { repo, OR: [{ path }, { path: { startsWith: `${path}/` } }] } });
  return c.json({ files: await listRepoFiles(repo) });
});
