"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Copy, Key, Trash } from "@phosphor-icons/react";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/harness";

interface TokenRow {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
}

interface RepoRow {
  repo: string;
  enabled: boolean;
  entries: number;
}

type Editor = "cursor" | "claude" | "codex";

function snippet(editor: Editor, url: string, token: string): string {
  if (editor === "cursor") {
    return JSON.stringify({ mcpServers: { cloudly: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  }
  if (editor === "claude") return `claude mcp add --transport http --scope user cloudly ${url} \\\n  --header "Authorization: Bearer ${token}"`;
  return `# ~/.codex/config.toml\n[mcp_servers.cloudly]\nurl = "${url}"\nbearer_token_env_var = "CLOUDLY_TOKEN"\n\n# and in your shell profile:\nexport CLOUDLY_TOKEN=${token}`;
}

const WHERE: Record<Editor, string> = {
  cursor: "Add to ~/.cursor/mcp.json (or .cursor/mcp.json in the repo, without committing the token).",
  claude: "Run once in a terminal.",
  codex: "Add to Codex's config, with the token in your environment.",
};

/** For AGENTS.md / CLAUDE.md / Cursor rules, so local agents use the context without being asked. */
const RULE = "Before starting on this repo, read its shared context with the cloudly MCP server (repo_context). When you finish, record what you did (record_work) and add notes for decisions or conventions (add_note).";

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-block">
      <pre className="mono">{text}</pre>
      <button
        type="button"
        className="icon-btn"
        aria-label="Copy"
        title="Copy"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <span className="dim" style={{ fontSize: 12 }}>Copied</span> : <Copy size={15} />}
      </button>
    </div>
  );
}

export function ContextSettings() {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>("cursor");
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("https://<your instance>/api/mcp");

  const load = useCallback(() => {
    api<{ tokens: TokenRow[] }>("/settings/tokens").then((r) => setTokens(r.tokens)).catch(() => setTokens([]));
    api<{ repos: RepoRow[] }>("/context").then((r) => setRepos(r.repos)).catch(() => {});
  }, []);
  useEffect(() => {
    setUrl(`${window.location.origin}/api/mcp`);
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { token } = await api<{ token: string }>("/settings/tokens", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setFresh(token);
      setName("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the token.");
    }
  }

  async function revoke(id: string) {
    await api(`/settings/tokens/${id}`, { method: "DELETE" }).catch(() => {});
    load();
  }

  const on = repos.filter((r) => r.enabled);

  return (
    <section className="set-sec" aria-labelledby="context-h" id="context">
      <header>
        <h2 id="context-h">Shared context</h2>
        <p>
          One set of notes and one work log per repo, for every agent: Cloudly&apos;s sessions, and Cursor, Claude Code or Codex on your machine through Cloudly&apos;s MCP endpoint. Turn it on per repo
          from a session&apos;s <b>Context</b> button.
        </p>
      </header>
      <div className="set-body">
        <div className="panel">
          <div className="panel-row field">
            <span className="label">On for</span>
            {on.length ? (
              <ul className="context-repos">
                {on.map((r) => (
                  <li key={r.repo}>
                    <span className="mono">{r.repo}</span>
                    <span className="dim">
                      {r.entries} entr{r.entries === 1 ? "y" : "ies"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">No repos yet. Open a session and click Context to turn it on for its repo.</p>
            )}
          </div>

          <div className="panel-row field">
            <span className="label">Connect an editor</span>
            <p className="hint">
              Create a token for each editor, then add Cloudly as an MCP server there. The editor gets four tools: list_repos, repo_context, add_note and record_work. A token
              only reaches shared context, nothing else in Cloudly.
            </p>
            {tokens?.length ? (
              <ul className="file-list">
                {tokens.map((t) => (
                  <li key={t.id}>
                    <Key size={15} />
                    <span className="path">{t.name}</span>
                    <span className="dim">{t.lastUsedAt ? `used ${relativeTime(t.lastUsedAt)}` : "never used"}</span>
                    <button type="button" className="icon-btn" onClick={() => revoke(t.id)} aria-label={`Revoke ${t.name}`} title="Revoke">
                      <Trash size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <form className="token-form" onSubmit={create}>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Cursor on my laptop" aria-label="Token name" maxLength={80} />
              <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
                Create token
              </button>
            </form>
            {error ? <p className="hint" style={{ color: "var(--danger)" }}>{error}</p> : null}
          </div>

          {fresh ? (
            <div className="panel-row field" style={{ background: "var(--warn-soft)" }}>
              <span className="label">Your new token: copy it now, it isn&apos;t shown again</span>
              <CopyBlock text={fresh} />
            </div>
          ) : null}

          <div className="panel-row field">
            <div className="segmented" role="group" aria-label="Editor">
              {(
                [
                  ["cursor", "Cursor"],
                  ["claude", "Claude Code"],
                  ["codex", "Codex CLI"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" aria-pressed={editor === id} onClick={() => setEditor(id)}>
                  {label}
                </button>
              ))}
            </div>
            <p className="hint">{WHERE[editor]}</p>
            <CopyBlock text={snippet(editor, url, fresh ?? "<your token>")} />
            <p className="hint">
              Then tell local agents to use it, in the repo&apos;s AGENTS.md, CLAUDE.md or Cursor rules:
            </p>
            <CopyBlock text={RULE} />
            <p className="hint">
              Needs HTTPS for editors outside this network. See <Link href="/docs/shared-context" className="text-link">Shared context</Link>.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
