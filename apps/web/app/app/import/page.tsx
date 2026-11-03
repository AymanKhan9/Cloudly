"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DownloadSimple, FileArrowUp, Terminal } from "@phosphor-icons/react";
import { api, ApiError, type ImportPreview, type Repo } from "@/lib/api";
import { useApp } from "@/components/app-context";
import { AgentLogo } from "@/components/agent-logo";
import { CodeBlock } from "@/components/code-block";

/** Where each agent keeps its sessions, for picking a file by hand. */
const WHERE: [string, string][] = [
  ["Claude Code", "~/.claude/projects/<your folder, / as ->/<session id>.jsonl"],
  ["Codex", "~/.codex/sessions/<year>/<month>/<day>/rollout-…jsonl"],
  ["Pi", "~/.pi/agent/sessions/--<your folder>--/…jsonl"],
  ["Gemini CLI", "~/.gemini/tmp/<project>/chats/session-….json"],
  ["OpenCode", "the output of: opencode export <session id> > session.json"],
  ["Any other agent", 'JSON with {"messages": [{"role", "content"}]}, or text with User: and Assistant: lines'],
];

async function gzipBase64(file: File): Promise<string> {
  const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function ImportCommand() {
  const [origin, setOrigin] = useState("https://<your instance>");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setOrigin(window.location.origin), []);

  async function create() {
    setError(null);
    try {
      setToken((await api<{ token: string }>("/settings/tokens", { method: "POST", body: JSON.stringify({ name: "Import command" }) })).token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create a token.");
    }
  }

  return (
    <section className="import-way">
      <h2>
        <Terminal size={18} />
        From your computer
      </h2>
      <p className="hint">
        Run it in the repository you worked in. It lists that repository&apos;s sessions from Claude Code, Codex, Pi, Gemini CLI and OpenCode, newest first. Your work (commits and changes you
        haven&apos;t committed) goes to a new branch, <span className="mono">cloudly/import-…</span>, so the session carries on from exactly where you were. Your files and branches stay as they are.
        It needs Node 18 or later and git.
      </p>
      {token ? (
        <>
          <CodeBlock>{`curl -fsSL ${origin}/api/cloudly.mjs -o cloudly.mjs\nCLOUDLY_TOKEN=${token} node cloudly.mjs`}</CodeBlock>
          <p className="hint">Copy it now: the token isn&apos;t shown again. Remove it under Settings &gt; Shared context when you no longer need it.</p>
        </>
      ) : (
        <>
          <CodeBlock>{`curl -fsSL ${origin}/api/cloudly.mjs -o cloudly.mjs\nCLOUDLY_TOKEN=<token> node cloudly.mjs`}</CodeBlock>
          <div className="row-actions" style={{ justifyContent: "flex-start" }}>
            <button type="button" className="btn btn-secondary" onClick={create}>
              Create a token for it
            </button>
          </div>
        </>
      )}
      <p className="hint">
        Options: <span className="mono">--agent native-codex</span> to carry on with another agent, <span className="mono">--message &quot;…&quot;</span> to send a first message,{" "}
        <span className="mono">--no-code</span> to start from the base branch, or a file path to import that file.
      </p>
      {error ? (
        <p className="hint" role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

export default function ImportPage() {
  const router = useRouter();
  const { harnesses } = useApp();
  const [file, setFile] = useState<{ name: string; gzip: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repo, setRepo] = useState("");
  const [startFrom, setStartFrom] = useState("");
  const [harness, setHarness] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ repos: Repo[] }>("/repos").then((r) => setRepos(r.repos)).catch(() => setRepos([]));
  }, []);

  async function choose(f: File | undefined) {
    if (!f) return;
    setError(null);
    setPreview(null);
    setBusy(true);
    try {
      if (f.size > 64 * 1024 * 1024) throw new ApiError(413, "That file is too big to import (64 MB at most).");
      const picked = { name: f.name, gzip: await gzipBase64(f) };
      const { preview } = await api<{ preview: ImportPreview }>("/imports", { method: "POST", body: JSON.stringify({ file: picked, preview: true }) });
      setFile(picked);
      setPreview(preview);
      const known = repos?.find((r) => r.fullName.toLowerCase() === preview.repo?.toLowerCase());
      if (known) setRepo(known.fullName);
      setHarness(harnesses.some((h) => h.id === preview.sourceHarness) ? preview.sourceHarness! : harnesses[0]?.id ?? "");
    } catch (err) {
      setFile(null);
      setError(err instanceof ApiError ? err.message : "Couldn't read that file.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !repo) return;
    setBusy(true);
    setError(null);
    try {
      const base = repos?.find((r) => r.fullName === repo)?.defaultBranch;
      const { id } = await api<{ id: string }>("/imports", {
        method: "POST",
        body: JSON.stringify({
          file, repo, harness,
          ...(base ? { baseBranch: base } : {}),
          ...(startFrom.trim() ? { startFrom: startFrom.trim() } : {}),
          ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        }),
      });
      router.push(`/app/s/${id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't import it.");
      setBusy(false);
    }
  }

  const resumes = preview?.canResume && harness === preview.sourceHarness;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Import a session</h1>
        <p>Bring a conversation from Claude Code, Codex, Pi, Gemini CLI, OpenCode or any other agent into Cloudly, and carry on with it here.</p>
      </div>

      <div className="import-ways">
        <ImportCommand />

        <section className="import-way">
          <h2>
            <FileArrowUp size={18} />
            Upload a session file
          </h2>
          <label
            className="import-drop"
            data-dragging={dragging || undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              choose(e.dataTransfer.files[0]);
            }}
          >
            <DownloadSimple size={22} />
            <span>{busy && !preview ? "Reading it…" : file ? file.name : "Drop a session file here, or choose one"}</span>
            <input type="file" accept=".jsonl,.json,.md,.txt,application/json,text/plain" onChange={(e) => choose(e.target.files?.[0])} hidden />
          </label>
          <details className="import-where">
            <summary>Where each agent keeps its sessions</summary>
            <dl>
              {WHERE.map(([agent, where]) => (
                <div key={agent}>
                  <dt>{agent}</dt>
                  <dd className="mono">{where}</dd>
                </div>
              ))}
            </dl>
          </details>
          <p className="hint">A file has the conversation but not your uncommitted work: push that to a branch first and name it below, or use the command, which does it for you.</p>
        </section>
      </div>

      {error ? (
        <div className="notice" data-tone="danger" role="alert">
          {error}
        </div>
      ) : null}

      {preview ? (
        <form className="import-preview panel" onSubmit={submit}>
          <div className="import-found">
            {preview.sourceHarness ? <AgentLogo harness={preview.sourceHarness} size={22} /> : null}
            <div>
              <strong>{preview.title}</strong>
              <span className="dim">
                {preview.sourceName} · {preview.turns} turn{preview.turns === 1 ? "" : "s"}
                {preview.dropped ? ` (and ${preview.dropped} older ones left out)` : ""}
                {preview.toolCalls ? ` · ${preview.toolCalls} tool call${preview.toolCalls === 1 ? "" : "s"}` : ""}
                {preview.cwd ? ` · ran in ${preview.cwd}` : ""}
              </span>
            </div>
          </div>
          {preview.prompts.length ? (
            <ol className="import-prompts">
              {preview.prompts.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
              {preview.turns > preview.prompts.length && preview.lastPrompt ? (
                <>
                  {preview.turns > preview.prompts.length + 1 ? <li className="dim" aria-hidden>…</li> : null}
                  <li value={preview.turns}>{preview.lastPrompt}</li>
                </>
              ) : null}
            </ol>
          ) : null}

          <div className="checks-grid">
            <div className="field">
              <label className="label" htmlFor="imp-repo">
                Repository
              </label>
              <select id="imp-repo" className="select" value={repo} onChange={(e) => setRepo(e.target.value)} required>
                <option value="" disabled>
                  {repos === null ? "Loading…" : "Choose one"}
                </option>
                {(repos ?? []).map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="imp-agent">
                Carry on with
              </label>
              <select id="imp-agent" className="select" value={harness} onChange={(e) => setHarness(e.target.value)}>
                {harnesses.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="hint">
            {resumes
              ? `${preview.sourceName} picks up its own session, with everything it remembers.`
              : preview.sourceHarness && harness !== preview.sourceHarness
                ? `The agent gets the conversation so far with each message. Choose ${preview.sourceName} to have it pick up its own session instead.`
                : "The agent gets the conversation so far with each message."}
          </p>
          <div className="field">
            <label className="label" htmlFor="imp-branch">
              Branch with your work <span className="dim">(optional)</span>
            </label>
            <input
              id="imp-branch"
              className="input mono"
              value={startFrom}
              onChange={(e) => setStartFrom(e.target.value)}
              placeholder={preview.gitBranch ? `${preview.gitBranch}, if it's pushed` : "The base branch when left empty"}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="imp-msg">
              First message <span className="dim">(optional)</span>
            </label>
            <textarea id="imp-msg" className="textarea" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should it do next?" />
          </div>
          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !repo}>
              {busy ? "Importing…" : "Import"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
