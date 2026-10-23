import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  prisma, contextSnapshot, contextMarkdown, setContextNotes, addContextEntry, createAccessToken, accessTokenOwner, CONTEXT_LIMITS,
} from "@repo/db";
import type { AuthEnv } from "./middleware/auth_middleware";

// Shared context for a repo (opt-in): the web app's routes, personal tokens for
// local editors, and the MCP endpoint those editors connect to, so Cursor, Claude
// Code and Cloudly's own agents read and add to the same notes and work log.

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const repoOf = (c: { req: { param: (k: string) => string } }) => {
  const repo = `${c.req.param("owner")}/${c.req.param("name")}`;
  return SLUG.test(repo) ? repo : null;
};

// ---------- For the web app (session cookie) ----------

export const context = new Hono<AuthEnv>();

context.get("/", async (c) => {
  const rows = await prisma.repoContext.findMany({ orderBy: { repo: "asc" } });
  const counts = await prisma.contextEntry.groupBy({ by: ["repo"], _count: true });
  const byRepo = new Map(counts.map((r) => [r.repo, r._count]));
  return c.json({ repos: rows.map((r) => ({ repo: r.repo, enabled: r.enabled, entries: byRepo.get(r.repo) ?? 0, updatedAt: r.updatedAt })) });
});

context.get("/:owner/:name", async (c) => {
  const repo = repoOf(c);
  if (!repo) return c.json({ message: "Expected owner/repo" }, 400);
  const row = await prisma.repoContext.findUnique({ where: { repo } });
  const snap = await contextSnapshot(repo, { limit: 50 });
  return c.json({ repo, enabled: row?.enabled ?? false, notes: snap.notes, entries: snap.entries, limits: { notes: CONTEXT_LIMITS.notes } });
});

context.put(
  "/:owner/:name",
  zValidator("json", z.object({ enabled: z.boolean().optional(), notes: z.string().max(CONTEXT_LIMITS.notes).optional() })),
  async (c) => {
    const repo = repoOf(c);
    if (!repo) return c.json({ message: "Expected owner/repo" }, 400);
    const { enabled, notes } = c.req.valid("json");
    await prisma.repoContext.upsert({
      where: { repo },
      update: { ...(enabled !== undefined ? { enabled } : {}), ...(notes !== undefined ? { notes } : {}) },
      create: { repo, enabled: enabled ?? true, notes: notes ?? "" },
    });
    return c.json({ ok: true });
  },
);

context.delete("/:owner/:name/entries/:id", async (c) => {
  const repo = repoOf(c);
  if (!repo) return c.json({ message: "Expected owner/repo" }, 400);
  await prisma.contextEntry.deleteMany({ where: { id: c.req.param("id"), repo } });
  return c.json({ ok: true });
});

// The whole thing as one Markdown file, e.g. to commit as part of AGENTS.md.
context.get("/:owner/:name/export", async (c) => {
  const repo = repoOf(c);
  if (!repo) return c.json({ message: "Expected owner/repo" }, 400);
  const md = contextMarkdown(await contextSnapshot(repo, { limit: 50 }), 200_000);
  return new Response(md, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="CONTEXT.md"',
      "x-content-type-options": "nosniff",
    },
  });
});

// ---------- Personal tokens (Settings) ----------

export const tokens = new Hono<AuthEnv>();

tokens.get("/", async (c) => {
  const rows = await prisma.accessToken.findMany({
    where: { userId: c.get("user").id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, lastUsedAt: true, createdAt: true },
  });
  return c.json({ tokens: rows });
});

tokens.post("/", zValidator("json", z.object({ name: z.string().trim().min(1).max(80) })), async (c) => {
  const created = await createAccessToken(c.get("user").id, c.req.valid("json").name);
  return c.json(created, 201);
});

tokens.delete("/:id", async (c) => {
  await prisma.accessToken.deleteMany({ where: { id: c.req.param("id"), userId: c.get("user").id } });
  return c.json({ ok: true });
});

// ---------- The MCP endpoint for local editors (bearer token) ----------
// Streamable HTTP, answering every POST with JSON: no server-initiated stream,
// no session to keep. Cursor, Claude Code and Codex all accept that.

type Json = Record<string, any>;
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

export const MCP_TOOLS = [
  {
    name: "list_repos",
    description: "Repos whose shared context is turned on in Cloudly.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "repo_context",
    description:
      "A repo's shared context: the notes and decisions every agent and editor working on it follows, and recent work by Cloudly's agents and other editors. Read it when you start on a repo.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "owner/repo" }, limit: { type: "integer", minimum: 1, maximum: 50 } },
      required: ["repo"],
    },
  },
  {
    name: "add_note",
    description: "Add a note or decision to a repo's shared context, for every other agent and editor working on it. Short and specific; no secrets.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo" },
        title: { type: "string" },
        text: { type: "string" },
        kind: { type: "string", enum: ["note", "decision"] },
      },
      required: ["repo", "title"],
    },
  },
  {
    name: "record_work",
    description: "Record what you just did on a repo (what changed and why), so Cloudly's agents and other editors know about it.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "owner/repo" }, title: { type: "string" }, summary: { type: "string" } },
      required: ["repo", "title"],
    },
  },
];

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function enabledRepo(repo: unknown): Promise<string | Json> {
  const name = String(repo ?? "");
  if (!SLUG.test(name)) return text("Give the repo as owner/repo.", true);
  const row = await prisma.repoContext.findUnique({ where: { repo: name } });
  if (!row?.enabled) return text(`Shared context is off for ${name}. Turn it on in Cloudly: open a session on it, then Context.`, true);
  return name;
}

export async function callContextTool(name: string, args: Json, author: string): Promise<Json> {
  if (name === "list_repos") {
    const rows = await prisma.repoContext.findMany({ where: { enabled: true }, orderBy: { repo: "asc" } });
    return text(rows.length ? rows.map((r) => r.repo).join("\n") : "No repo has shared context turned on yet.");
  }
  const repo = await enabledRepo(args.repo);
  if (typeof repo !== "string") return repo;
  if (name === "repo_context") return text(contextMarkdown(await contextSnapshot(repo, { limit: Number(args.limit) || 15 })));
  if (name === "add_note" || name === "record_work") {
    const title = String(args.title ?? "").trim();
    if (!title) return text("A title is needed.", true);
    await addContextEntry({
      repo,
      kind: name === "record_work" ? "turn" : args.kind === "decision" ? "decision" : "note",
      author,
      source: "mcp",
      title,
      body: String((name === "record_work" ? args.summary : args.text) ?? ""),
    });
    return text("Saved to the shared context. Cloudly's agents see it from their next turn.");
  }
  throw new Error(`unknown tool: ${name}`);
}

async function handleRpc(message: Json, author: string): Promise<Json | null> {
  const { id, method, params } = message ?? {};
  if (id === undefined || id === null) return null;
  const reply = (result: Json) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "cloudly-context", version: "1.0.0" },
        instructions: "Shared context for your repos, the same one Cloudly's agents use. Read repo_context when you start on a repo; add notes and record your work so the next agent knows.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: MCP_TOOLS });
    case "tools/call":
      try {
        return reply(await callContextTool(String(params?.name), params?.arguments ?? {}, author));
      } catch (err) {
        return reply(text(err instanceof Error ? err.message : String(err), true));
      }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

export const mcpEndpoint = new Hono();

mcpEndpoint.post("/", async (c) => {
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  const owner = await accessTokenOwner(bearer);
  // No WWW-Authenticate challenge: this endpoint takes a token from Settings, not an OAuth sign-in.
  if (!owner) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Create a token in Cloudly under Settings > Shared context, and send it as a bearer token." } }, 401);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(body)) {
    // In order: a batch that adds then reads should see what it added.
    const out: Json[] = [];
    for (const m of body) {
      const r = await handleRpc(m, owner.name);
      if (r) out.push(r);
    }
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const out = await handleRpc(body as Json, owner.name);
  return out ? c.json(out) : c.body(null, 202);
});

// No server-initiated stream and no sessions to end.
mcpEndpoint.on(["GET", "DELETE"], "/", (c) => c.body(null, 405, { allow: "POST" }));
