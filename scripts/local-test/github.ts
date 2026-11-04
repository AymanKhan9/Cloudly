/**
 * A stand-in for GitHub, for running Cloudly end to end on one machine.
 *
 * It serves the parts of the REST API Cloudly uses (installation tokens, the
 * installation's repos, pull requests, comments, reviews, merges, checks) over
 * bare repos in a directory, and a page per pull request. Point Cloudly at it:
 *
 *   CLOUDLY_GITHUB_API_URL=http://127.0.0.1:9797
 *   CLOUDLY_GITHUB_GIT_URL=/path/to/repos      (the same directory)
 *
 * Control endpoints, for tests:
 *   GET  /OWNER/REPO/pull/N              a pull request's page (links say github.com)
 *   POST /mcp[?token=T]                  an MCP server with one tool, echo
 *   GET  /_registry.json, POST /_registry   a stand-in ACP registry
 *   GET  /_files/NAME                    files under <repos>/_files (agent archives)
 *   GET  /_state                         every pull request, comment and review
 *   POST /_checks {sha?, runs:[...]}     the check runs a commit reports
 *   POST /_webhook {event, payload, secret, url}   sign and deliver a webhook
 *   POST /_repo {owner, repo, files}     make a repository from files
 *
 * Usage: bun scripts/local-test/github.ts <repos dir> [port]
 */
import { mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";

const root = path.resolve(process.argv[2] ?? "./local-github-repos");
const port = Number(process.argv[3] ?? 9797);
const statePath = path.join(root, "_state.json");
const base = `http://127.0.0.1:${port}`;

interface Pull {
  number: number;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergedSha?: string;
  createdAt: string;
}

interface State {
  next: number;
  pulls: Pull[];
  comments: { owner: string; repo: string; issue: number; id: number; body: string; at: string }[];
  reviews: { owner: string; repo: string; pull: number; body: string; event: string; comments: unknown[]; at: string }[];
  reactions: { comment: number; content: string }[];
  checks: Record<string, unknown[]>;
}

await mkdir(root, { recursive: true });
let state: State = (await Bun.file(statePath).exists())
  ? await Bun.file(statePath).json()
  : { next: 1, pulls: [], comments: [], reviews: [], reactions: [], checks: {} };
const save = () => Bun.write(statePath, JSON.stringify(state, null, 2));

const git = (repoDir: string, ...args: string[]) => Bun.$`git -C ${repoDir} ${args}`.quiet().nothrow();
const bare = (owner: string, repo: string) => path.join(root, owner, `${repo}.git`);

async function sha(owner: string, repo: string, ref: string): Promise<string | null> {
  const r = await git(bare(owner, repo), "rev-parse", "--verify", "-q", `refs/heads/${ref}^{commit}`);
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

async function defaultBranch(dir: string): Promise<string> {
  const r = await git(dir, "symbolic-ref", "--short", "HEAD");
  return r.exitCode === 0 ? r.stdout.toString().trim() : "main";
}

async function repos(): Promise<{ owner: string; repo: string; dir: string }[]> {
  const out: { owner: string; repo: string; dir: string }[] = [];
  for (const owner of await readdir(root, { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    for (const r of await readdir(path.join(root, owner.name), { withFileTypes: true })) {
      if (r.isDirectory() && r.name.endsWith(".git")) out.push({ owner: owner.name, repo: r.name.slice(0, -4), dir: path.join(root, owner.name, r.name) });
    }
  }
  return out;
}

// Links look like GitHub's, which is how Cloudly reads them; the same path here shows the pull request.
const htmlUrl = (p: Pull) => `https://github.com/${p.owner}/${p.repo}/pull/${p.number}`;

async function pullJson(p: Pull) {
  const headSha = (await sha(p.owner, p.repo, p.head)) ?? p.mergedSha ?? "0".repeat(40);
  return {
    number: p.number,
    html_url: htmlUrl(p),
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    merged_at: p.merged ? p.createdAt : null,
    closed_at: p.state === "closed" ? new Date().toISOString() : null,
    draft: false,
    mergeable: p.state === "open",
    mergeable_state: p.state === "open" ? "clean" : "unknown",
    head: { ref: p.head, sha: headSha, repo: { full_name: `${p.owner}/${p.repo}` } },
    base: { ref: p.base, repo: { full_name: `${p.owner}/${p.repo}` } },
    user: { login: "cloudly-test[bot]" },
  };
}

/** Merges the head into the base in a scratch clone, as GitHub's merge button does. */
async function merge(p: Pull, into = p.base, from = p.head): Promise<{ ok: boolean; sha?: string; message: string }> {
  const work = await mkdtemp(path.join(tmpdir(), "local-gh-merge-"));
  try {
    const dir = bare(p.owner, p.repo);
    if ((await Bun.$`git clone -q --branch ${into} ${dir} ${work}`.quiet().nothrow()).exitCode) return { ok: false, message: `No branch ${into}` };
    await Bun.$`git -C ${work} -c user.name=GitHub -c user.email=noreply@github.test fetch -q origin ${from}`.quiet();
    const m = await Bun.$`git -C ${work} -c user.name=GitHub -c user.email=noreply@github.test merge --no-ff -m ${`Merge pull request #${p.number} from ${from}`} FETCH_HEAD`.quiet().nothrow();
    if (m.exitCode) return { ok: false, message: "Merge conflict" };
    await Bun.$`git -C ${work} push -q origin HEAD:${into}`.quiet();
    return { ok: true, sha: (await Bun.$`git -C ${work} rev-parse HEAD`.text()).trim(), message: "Pull Request successfully merged" };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const notFound = (what: string) => (console.log(`[local-github] 404 ${what}`), json({ message: "Not Found" }, 404));

function page(title: string, body: string) {
  return new Response(
    `<!doctype html><meta charset=utf-8><title>${title}</title><style>body{font:14px system-ui;max-width:860px;margin:32px auto;padding:0 16px}pre{white-space:pre-wrap;background:#f6f8fa;padding:12px;border-radius:8px}.s{display:inline-block;padding:2px 8px;border-radius:99px;background:#1f883d;color:#fff}.m{background:#8250df}.c{background:#cf222e}</style>${body}`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
    let m: RegExpMatchArray | null;

    // A small MCP server (streamable HTTP, JSON replies), for testing MCP connections: one "echo" tool.
    if (p === "/mcp" && req.method === "POST") {
      const auth = req.headers.get("authorization");
      if (url.searchParams.get("token") && auth !== `Bearer ${url.searchParams.get("token")}`) return json({ error: "unauthorized" }, 401);
      const { id, method, params } = body;
      if (id === undefined) return new Response(null, { status: 202 });
      const result =
        method === "initialize"
          ? { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "local-echo", version: "1" } }
          : method === "tools/list"
            ? { tools: [{ name: "echo", description: "Echoes its text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }
            : method === "tools/call"
              ? { content: [{ type: "text", text: `echo: ${params?.arguments?.text ?? ""} (authorized: ${auth ? "yes" : "no"})` }] }
              : {};
      return Response.json({ jsonrpc: "2.0", id, result }, { headers: { "mcp-session-id": "local" } });
    }

    // A stand-in ACP registry, and files for it to point at (agent archives).
    if (p === "/_registry.json") {
      const f = Bun.file(path.join(root, "_registry.json"));
      return (await f.exists()) ? new Response(f, { headers: { "content-type": "application/json" } }) : json({ version: "1.0.0", agents: [] });
    }
    if (p === "/_registry" && req.method === "POST") {
      await Bun.write(path.join(root, "_registry.json"), JSON.stringify(body));
      return json({ ok: true });
    }
    if ((m = p.match(/^\/_files\/([\w.-]+)$/))) {
      const f = Bun.file(path.join(root, "_files", m[1]!));
      return (await f.exists()) ? new Response(f) : notFound(p);
    }

    // Control
    if (p === "/_state") return json(state);
    if (p === "/_checks" && req.method === "POST") {
      state.checks[body.sha ?? "*"] = body.runs ?? [];
      await save();
      return json({ ok: true });
    }
    if (p === "/_repo" && req.method === "POST") {
      const dir = bare(body.owner, body.repo);
      const work = await mkdtemp(path.join(tmpdir(), "local-gh-new-"));
      await rm(dir, { recursive: true, force: true });
      await mkdir(path.dirname(dir), { recursive: true });
      await Bun.$`git init -q --bare -b main ${dir}`.quiet();
      await Bun.$`git init -q -b main ${work}`.quiet();
      for (const [file, text] of Object.entries(body.files as Record<string, string>)) {
        await mkdir(path.dirname(path.join(work, file)), { recursive: true });
        await Bun.write(path.join(work, file), text);
      }
      await Bun.$`git -C ${work} add -A`.quiet();
      await Bun.$`git -C ${work} -c user.name=Test -c user.email=test@example.test commit -q -m ${"Initial commit"}`.quiet();
      await Bun.$`git -C ${work} push -q ${dir} HEAD:main`.quiet();
      await rm(work, { recursive: true, force: true });
      return json({ ok: true, dir });
    }
    if (p === "/_webhook" && req.method === "POST") {
      const raw = JSON.stringify(body.payload);
      const sig = "sha256=" + createHmac("sha256", body.secret).update(raw).digest("hex");
      const res = await fetch(body.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-github-event": body.event, "x-github-delivery": crypto.randomUUID(), "x-hub-signature-256": sig },
        body: raw,
      });
      return json({ status: res.status, body: await res.text() });
    }

    // Pull request pages
    if ((m = p.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/))) {
      const pr = state.pulls.find((x) => x.owner === m![1] && x.repo === m![2] && x.number === Number(m![3]));
      if (!pr) return notFound(p);
      const badge = pr.merged ? `<span class="s m">Merged</span>` : pr.state === "closed" ? `<span class="s c">Closed</span>` : `<span class="s">Open</span>`;
      const comments = state.comments.filter((c) => c.owner === pr.owner && c.repo === pr.repo && c.issue === pr.number);
      return page(pr.title, `<h1>${esc(pr.title)} #${pr.number}</h1><p>${badge} ${esc(pr.head)} → ${esc(pr.base)}</p><pre>${esc(pr.body)}</pre>${comments.map((c) => `<h3>Comment</h3><pre>${esc(c.body)}</pre>`).join("")}`);
    }

    // Auth
    if ((m = p.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) return json({ token: "ghs_localtesttoken", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {}, repository_selection: "all" }, 201);
    if ((m = p.match(/^\/app\/installations\/(\d+)$/))) return json({ id: Number(m[1]), account: { login: "local" } });
    if (p === "/installation/repositories") {
      const list = await Promise.all((await repos()).map(async (r) => ({ full_name: `${r.owner}/${r.repo}`, default_branch: await defaultBranch(r.dir), private: false })));
      return json({ total_count: list.length, repositories: url.searchParams.get("page") && url.searchParams.get("page") !== "1" ? [] : list });
    }

    if (!(m = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/))) return notFound(`${req.method} ${p}`);
    const [owner, repo, rest = ""] = [m[1]!, m[2]!, m[3]];
    let r: RegExpMatchArray | null;

    if (rest === "/pulls" && req.method === "POST") {
      if (state.pulls.some((x) => x.owner === owner && x.repo === repo && x.head === body.head && x.state === "open")) {
        return json({ message: "Validation Failed", errors: [{ message: `A pull request already exists for ${owner}:${body.head}.` }] }, 422);
      }
      if (!(await sha(owner, repo, body.head))) return json({ message: "Validation Failed", errors: [{ message: "head invalid" }] }, 422);
      const pr: Pull = { number: state.next++, owner, repo, head: body.head, base: body.base, title: body.title, body: body.body ?? "", state: "open", merged: false, createdAt: new Date().toISOString() };
      state.pulls.push(pr);
      await save();
      console.log(`[local-github] opened #${pr.number} ${owner}/${repo} ${pr.head} → ${pr.base}: ${pr.title}`);
      return json(await pullJson(pr), 201);
    }
    if (rest === "/pulls" && req.method === "GET") {
      const head = url.searchParams.get("head")?.split(":").pop();
      const want = url.searchParams.get("state") ?? "open";
      const list = state.pulls.filter((x) => x.owner === owner && x.repo === repo && (!head || x.head === head) && (want === "all" || x.state === want));
      return json(await Promise.all(list.map(pullJson)));
    }
    if ((r = rest.match(/^\/pulls\/(\d+)(\/.*)?$/))) {
      const pr = state.pulls.find((x) => x.owner === owner && x.repo === repo && x.number === Number(r![1]));
      if (!pr) return notFound(`${req.method} ${p}`);
      const sub = r[2] ?? "";
      if (!sub && req.method === "GET") return json(await pullJson(pr));
      if (!sub && req.method === "PATCH") {
        for (const k of ["title", "body", "state"] as const) if (typeof body[k] === "string") (pr as any)[k] = body[k];
        await save();
        return json(await pullJson(pr));
      }
      if (sub === "/merge" && req.method === "PUT") {
        if (pr.state !== "open") return json({ message: "Pull Request is not mergeable" }, 405);
        const res = await merge(pr);
        if (!res.ok) return json({ message: res.message }, 405);
        pr.merged = true;
        pr.state = "closed";
        pr.mergedSha = res.sha;
        await save();
        console.log(`[local-github] merged #${pr.number}`);
        return json({ merged: true, sha: res.sha, message: res.message });
      }
      if (sub === "/update-branch" && req.method === "PUT") {
        const res = await merge(pr, pr.head, pr.base);
        return json({ message: res.ok ? "Updating pull request branch." : res.message }, res.ok ? 202 : 422);
      }
      if (sub === "/reviews" && req.method === "POST") {
        state.reviews.push({ owner, repo, pull: pr.number, body: body.body ?? "", event: body.event ?? "COMMENT", comments: body.comments ?? [], at: new Date().toISOString() });
        await save();
        return json({ id: state.reviews.length }, 200);
      }
      if ((r = sub.match(/^\/reviews\/(\d+)\/comments$/))) return json([]);
    }
    if ((r = rest.match(/^\/issues\/(\d+)\/comments$/)) && req.method === "POST") {
      const id = 1000 + state.comments.length;
      state.comments.push({ owner, repo, issue: Number(r[1]), id, body: body.body ?? "", at: new Date().toISOString() });
      await save();
      return json({ id, html_url: `https://github.com/${owner}/${repo}/pull/${r[1]}#issuecomment-${id}` }, 201);
    }
    if ((r = rest.match(/^\/issues\/comments\/(\d+)\/reactions$/))) {
      state.reactions.push({ comment: Number(r[1]), content: body.content });
      await save();
      return json({ id: state.reactions.length }, 201);
    }
    if ((r = rest.match(/^\/commits\/([^/]+)\/check-runs$/))) {
      const runs = state.checks[r[1]!] ?? state.checks["*"] ?? [];
      return json({ total_count: runs.length, check_runs: runs });
    }
    if ((r = rest.match(/^\/commits\/([^/]+)\/status$/))) return json({ state: "success", statuses: [], total_count: 0 });
    if ((r = rest.match(/^\/check-suites\/(\d+)\/check-runs$/))) {
      const runs = Object.values(state.checks).flat().filter((c: any) => String(c?.check_suite?.id) === r![1]);
      return json({ total_count: runs.length, check_runs: runs });
    }
    if ((r = rest.match(/^\/check-runs\/(\d+)\/annotations$/))) return json([]);
    if ((r = rest.match(/^\/actions\/jobs\/(\d+)\/logs$/))) return new Response("test output\nError: expected 2, got 3\n");
    return notFound(`${req.method} ${p}`);
  },
});
console.log(`[local-github] ${base}, repos in ${root}`);
