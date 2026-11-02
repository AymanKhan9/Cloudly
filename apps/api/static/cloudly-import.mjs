#!/usr/bin/env node
// Cloudly's import command: brings a coding agent session from this machine
// into Cloudly, to carry on there. Run it in the repository you worked in:
//
//   curl -fsSL https://<your instance>/api/import.mjs -o cloudly-import.mjs
//   CLOUDLY_TOKEN=cly_... node cloudly-import.mjs
//
// It finds the sessions Claude Code, Codex, Pi, Gemini CLI and OpenCode keep for
// this repository, lets you pick one, pushes your work (commits and uncommitted
// changes) to a new branch, cloudly/import-..., and uploads the session. Your
// working tree, index and branches are left as they are. Or name any session
// file, from any agent: node cloudly-import.mjs path/to/session.jsonl
//
// Options:
//   --url URL        your Cloudly (or CLOUDLY_URL)
//   --token TOKEN    a personal token from Cloudly (or CLOUDLY_TOKEN)
//   --agent ID       the agent to carry on with (native-claude, native-codex, acp-pi, ...);
//                    the one that wrote the session when Cloudly has it
//   --repo O/R       the GitHub repository (from the git remote otherwise)
//   --message TEXT   a first message to send once it's imported
//   --no-code        don't push anything: the session starts from the base branch
//   --latest         take the newest session without asking
//   --list           only list the sessions found
//   --yes            don't ask before pushing

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { gzipSync } from "node:zlib";

const BAKED_URL = "__CLOUDLY_URL__";

// ---------- Arguments ----------

const argv = process.argv.slice(2);
const opts = { url: process.env.CLOUDLY_URL, token: process.env.CLOUDLY_TOKEN, files: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => {
    const v = argv[++i];
    if (v === undefined) die(`${a} needs a value.`);
    return v;
  };
  if (a === "--url") opts.url = value();
  else if (a === "--token") opts.token = value();
  else if (a === "--agent") opts.agent = value();
  else if (a === "--repo") opts.repo = value();
  else if (a === "--message") opts.message = value();
  else if (a === "--no-code") opts.noCode = true;
  else if (a === "--latest") opts.latest = true;
  else if (a === "--list") opts.list = true;
  else if (a === "--yes" || a === "-y") opts.yes = true;
  else if (a === "--help" || a === "-h") {
    console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    process.exit(0);
  } else if (a.startsWith("-")) die(`Unknown option ${a}. See --help.`);
  else opts.files.push(a);
}
if (!opts.url && !BAKED_URL.startsWith("__")) opts.url = BAKED_URL;

function die(message) {
  console.error(`cloudly-import: ${message}`);
  process.exit(1);
}

const git = (...args) => {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.trim() : null;
};

const root = git("rev-parse", "--show-toplevel") ?? process.cwd();
const home = homedir();
const inside = (dir) => typeof dir === "string" && (dir === root || dir.startsWith(root + path.sep));

// ---------- Finding sessions ----------

/** The first `bytes` of a file, as lines of JSON. */
function headLines(file, bytes = 256 * 1024) {
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(Math.min(bytes, statSync(file).size));
  readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  return buf.toString("utf8").split("\n").flatMap((l) => {
    try {
      const v = JSON.parse(l);
      return v && typeof v === "object" ? [v] : [];
    } catch {
      return [];
    }
  });
}

const textOf = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join(" ") : "";
const firstLine = (s) => (s ?? "").replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 70);

function files(dir, pattern, depth = 0) {
  if (!existsSync(dir) || depth > 5) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p, pattern, depth + 1));
    else if (pattern.test(e.name)) out.push(p);
  }
  return out;
}

function claudeSessions() {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "projects");
  if (!existsSync(projects)) return [];
  const enc = root.replace(/[^a-zA-Z0-9]/g, "-");
  return readdirSync(projects)
    .filter((d) => d === enc || d.startsWith(enc + "-"))
    .flatMap((d) => files(path.join(projects, d), /^[0-9a-f-]{36}\.jsonl$/))
    .flatMap((file) => {
      const lines = headLines(file);
      const cwd = lines.find((l) => l.cwd)?.cwd;
      if (cwd && !inside(cwd)) return [];
      const first = lines.find((l) => l.type === "user" && !l.isMeta && typeof l.message?.content === "string" && !/^\s*</.test(l.message.content));
      if (!lines.some((l) => l.type === "user" || l.type === "assistant")) return [];
      return [{ source: "Claude Code", file, title: firstLine(first?.message?.content) }];
    });
}

function codexSessions() {
  const dir = path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "sessions");
  return files(dir, /^rollout-.*\.jsonl$/)
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 400)
    .flatMap(({ file }) => {
      const lines = headLines(file, 128 * 1024);
      const meta = lines.find((l) => l.type === "session_meta")?.payload ?? lines[0];
      if (!inside(meta?.cwd)) return [];
      const first = lines.find((l) => l.type === "event_msg" && l.payload?.type === "user_message");
      return [{ source: "Codex", file, title: firstLine(first?.payload?.message) }];
    });
}

function piSessions() {
  const dir = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent"), "sessions");
  if (!existsSync(dir)) return [];
  const enc = root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return readdirSync(dir)
    .filter((d) => d === `--${enc}--` || d.startsWith(`--${enc}-`))
    .flatMap((d) => files(path.join(dir, d), /\.jsonl$/))
    .flatMap((file) => {
      const lines = headLines(file);
      const header = lines.find((l) => l.type === "session");
      if (header?.cwd && !inside(header.cwd)) return [];
      const first = lines.find((l) => l.type === "message" && l.message?.role === "user");
      return [{ source: "Pi", file, title: firstLine(textOf(first?.message?.content)) }];
    });
}

function geminiSessions() {
  const dir = path.join(home, ".gemini", "tmp");
  if (!existsSync(dir)) return [];
  const hash = createHash("sha256").update(root).digest("hex");
  return readdirSync(dir)
    .filter((d) => {
      if (d === hash) return true;
      try {
        return readFileSync(path.join(dir, d, ".project_root"), "utf8").trim() === root;
      } catch {
        return false;
      }
    })
    .flatMap((d) => files(path.join(dir, d, "chats"), /\.jsonl?$/))
    .flatMap((file) => {
      let title = "";
      try {
        const text = readFileSync(file, "utf8");
        const doc = text.trim().startsWith("{") && !text.includes("\n{") ? JSON.parse(text) : null;
        const msgs = doc?.messages ?? headLines(file);
        title = firstLine(textOf(msgs.find((m) => m.type === "user")?.content));
      } catch {}
      return [{ source: "Gemini CLI", file, title }];
    });
}

function openCodeSessions() {
  const r = spawnSync("opencode", ["session", "list", "--format", "json"], { cwd: root, encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0) return [];
  try {
    const list = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")));
    return list.flatMap((s) => {
      if (!s?.id) return [];
      const updated = s.time?.updated ?? s.updated ?? s.updatedAt;
      return [{ source: "OpenCode", opencodeId: s.id, title: firstLine(s.title), mtime: typeof updated === "number" ? updated : Date.parse(updated) || 0 }];
    });
  } catch {
    return [];
  }
}

function findSessions() {
  const found = [];
  for (const find of [claudeSessions, codexSessions, piSessions, geminiSessions, openCodeSessions]) {
    try {
      found.push(...find());
    } catch (err) {
      console.error(`(skipped ${find.name}: ${err.message})`);
    }
  }
  for (const s of found) {
    if (s.file) {
      const st = statSync(s.file);
      s.mtime = st.mtimeMs;
      s.size = st.size;
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

// ---------- The code ----------

/** owner/repo of a GitHub remote URL. */
function githubRepo(url) {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url ?? "");
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * A commit with everything in the working tree (respecting .gitignore), on top of
 * HEAD, made with a separate index so the user's own index and files aren't touched.
 */
function workCommit() {
  const head = git("rev-parse", "HEAD");
  if (!head) return null;
  const tmp = mkdtempSync(path.join(tmpdir(), "cloudly-import-"));
  const index = path.join(tmp, "index");
  try {
    const own = git("rev-parse", "--git-path", "index");
    if (own && existsSync(path.resolve(own))) copyFileSync(path.resolve(own), index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    execFileSync("git", ["add", "-A"], { cwd: root, env, stdio: "ignore" });
    const tree = execFileSync("git", ["write-tree"], { cwd: root, env, encoding: "utf8" }).trim();
    if (tree === git("rev-parse", "HEAD^{tree}")) return { sha: head, dirty: false };
    const sha = execFileSync("git", ["commit-tree", tree, "-p", head, "-m", "Work in progress, imported into Cloudly"], { cwd: root, encoding: "utf8" }).trim();
    return { sha, dirty: true };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- Main ----------

async function ask(rl, q) {
  if (!process.stdin.isTTY) return "";
  return (await rl.question(q)).trim();
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let chosen;
    if (opts.files.length) {
      const file = path.resolve(opts.files[0]);
      if (!existsSync(file)) die(`No such file: ${file}`);
      chosen = { source: "file", file, title: path.basename(file) };
    } else {
      const sessions = findSessions();
      if (!sessions.length) {
        die(`No Claude Code, Codex, Pi, Gemini CLI or OpenCode sessions found for ${root}.\nName a session file instead: node cloudly-import.mjs path/to/session`);
      }
      const shown = sessions.slice(0, 20);
      console.log(`Sessions for ${root}:\n`);
      shown.forEach((s, i) => {
        const size = s.size ? ` · ${Math.max(1, Math.round(s.size / 1024))} KB` : "";
        console.log(`  ${String(i + 1).padStart(2)}. ${s.source.padEnd(11)} ${ago(s.mtime).padStart(8)}${size}  ${s.title || "(untitled)"}`);
      });
      if (opts.list) return;
      console.log("");
      if (opts.latest || !process.stdin.isTTY) chosen = shown[0];
      else {
        const pick = Number((await ask(rl, `Which one? [1-${shown.length}, Enter for 1] `)) || "1");
        chosen = shown[pick - 1];
        if (!chosen) die("No such session.");
      }
    }

    if (!opts.url) die("Which Cloudly? Pass --url https://your-instance (or set CLOUDLY_URL).");
    const base = opts.url.replace(/\/+$/, "");
    if (!opts.token) die(`Cloudly needs a personal token. Make one on ${base}/app/import and pass it with --token (or CLOUDLY_TOKEN).`);

    // The session file.
    let name;
    let content;
    if (chosen.opencodeId) {
      const r = spawnSync("opencode", ["export", chosen.opencodeId], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (r.status !== 0) die(`opencode export failed: ${r.stderr.trim().split("\n")[0]}`);
      content = r.stdout.slice(r.stdout.indexOf("{"));
      name = `opencode-${chosen.opencodeId}.json`;
    } else {
      content = readFileSync(chosen.file, "utf8");
      name = path.basename(chosen.file);
    }

    // The repository and the code.
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    const upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
    const remote = upstream?.split("/")[0] ?? (git("remote")?.split("\n").includes("origin") ? "origin" : git("remote")?.split("\n")[0]);
    const repo = opts.repo ?? githubRepo(remote ? git("remote", "get-url", remote) : null);
    if (!repo) die("Couldn't tell the GitHub repository from the git remote. Pass --repo owner/name.");

    let startFrom;
    if (!opts.noCode && git("rev-parse", "--is-inside-work-tree") === "true") {
      const work = workCommit();
      const pushed = work && !work.dirty && remote ? git("branch", "-r", "--contains", work.sha, "--list", `${remote}/*`) : null;
      if (work && pushed) {
        // Already on GitHub: start from that branch (the current one's if it's there).
        const names = pushed.split("\n").map((s) => s.trim().replace(/^.*?\//, "")).filter((s) => s && !s.startsWith("HEAD"));
        startFrom = names.includes(branch) ? branch : names[0];
        console.log(`Your work is on GitHub already (${startFrom}).`);
      } else if (work) {
        const changed = (git("status", "--porcelain") ?? "").split("\n").filter(Boolean);
        const target = `cloudly/import-${randomBytes(4).toString("hex")}`;
        console.log(`\nTo carry on, Cloudly needs your work on GitHub: ${branch === "HEAD" ? "this commit" : `the commits on ${branch}`}${changed.length ? ` and ${changed.length} uncommitted change${changed.length === 1 ? "" : "s"}` : ""}.`);
        if (changed.length) console.log(changed.slice(0, 15).map((l) => `    ${l}`).join("\n") + (changed.length > 15 ? `\n    ... and ${changed.length - 15} more` : ""));
        const ok = opts.yes || (await ask(rl, `Push it to a new branch, ${target}, on ${repo}? Your files and branches stay as they are. [Y/n] `)).toLowerCase() !== "n";
        if (ok) {
          const r = spawnSync("git", ["push", "--quiet", remote, `${work.sha}:refs/heads/${target}`], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
          if (r.status !== 0) die("The push failed. Fix that (or use --no-code to start from the base branch) and run it again.");
          startFrom = target;
        } else {
          console.log("Not pushed: the session will start from the base branch.");
        }
      }
    }

    console.log(`\nUploading ${name} (${Math.max(1, Math.round(content.length / 1024))} KB)...`);
    const res = await fetch(`${base}/api/imports`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({
        file: { name, gzip: gzipSync(Buffer.from(content, "utf8")).toString("base64") },
        repo,
        ...(startFrom ? { startFrom } : {}),
        ...(opts.agent ? { harness: opts.agent } : {}),
        ...(opts.message ? { prompt: opts.message } : {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) die(body.message ?? `Cloudly answered ${res.status}.`);
    const p = body.preview ?? {};
    console.log(`\nImported "${p.title}": ${p.turns} turn${p.turns === 1 ? "" : "s"} from ${p.sourceName}.`);
    console.log(p.canResume && body.harness === p.sourceHarness ? `${p.sourceName} will pick up its own session.` : `The agent (${body.harness}) gets the conversation with each message.`);
    console.log(`\n  ${base}/app/s/${body.id}\n`);
  } finally {
    rl.close();
  }
}

main().catch((err) => die(err?.message ?? String(err)));
