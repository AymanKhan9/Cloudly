"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DownloadSimple, GitPullRequest, Lightbulb, NotePencil, Plugs, Trash, Wrench } from "@phosphor-icons/react";
import { api, ApiError } from "@/lib/api";
import { harnessById, relativeTime } from "@/lib/harness";
import { AgentLogo } from "./agent-logo";

interface Entry {
  id: string;
  kind: "turn" | "note" | "decision";
  author: string;
  source: "cloudly" | "mcp";
  title: string;
  body: string;
  threadId: string | null;
  prUrl: string | null;
  createdAt: string;
}

interface ContextView {
  repo: string;
  enabled: boolean;
  notes: string;
  entries: Entry[];
  limits: { notes: number };
}

const KIND = { turn: { icon: Wrench, label: "Work" }, note: { icon: NotePencil, label: "Note" }, decision: { icon: Lightbulb, label: "Decision" } };

/**
 * A repo's shared context: notes every agent follows, and what each session and
 * connected editor did. Off until the user turns it on for the repo.
 */
export function ContextPanel({ repo }: { repo: string }) {
  const [view, setView] = useState<ContextView | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(
    () =>
      api<ContextView>(`/context/${repo}`).then((v) => {
        setView(v);
        return v;
      }),
    [repo],
  );
  useEffect(() => {
    load()
      .then((v) => setNotes(v.notes))
      .catch((e: Error) => setMessage({ ok: false, text: e.message }));
  }, [load]);

  async function save(body: { enabled?: boolean; notes?: string }) {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/context/${repo}`, { method: "PUT", body: JSON.stringify(body) });
      await load();
      if (body.notes !== undefined) setMessage({ ok: true, text: "Saved. Every agent sees it from its next turn." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Couldn't save." });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await api(`/context/${repo}/entries/${id}`, { method: "DELETE" }).catch(() => {});
    await load();
  }

  if (!view) {
    return message ? (
      <p className="hint" role="alert">
        {message.text}
      </p>
    ) : (
      <div className="skeleton" style={{ width: "50%" }} aria-busy="true" />
    );
  }

  if (!view.enabled) {
    return (
      <div className="context-off">
        <p className="hint">
          With shared context on, every agent working on <span className="mono">{repo}</span> starts from the same notes and sees what the others did: Claude, Codex and
          Gemini sessions here, and Cursor or Claude Code on your machine through the context MCP endpoint. Agents add notes as they work, and each turn is logged.
        </p>
        <div className="form-foot" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save({ enabled: true })}>
            Turn on shared context
          </button>
          <Link href="/app/settings#context" className="btn btn-secondary">
            <Plugs size={15} />
            Connect an editor
          </Link>
        </div>
      </div>
    );
  }

  const dirty = notes !== view.notes;

  return (
    <div className="context">
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          save({ notes });
        }}
      >
        <label className="label" htmlFor="ctx-notes">
          Notes every agent follows
        </label>
        <textarea
          id="ctx-notes"
          className="textarea code-area"
          rows={Math.min(14, Math.max(4, notes.split("\n").length + 1))}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={view.limits.notes}
          placeholder={"- Money is integer cents everywhere; never floats.\n- Use the repo's own fetch wrapper in src/lib/http.ts.\n- Don't touch the generated files in src/gen."}
        />
        <div className="form-foot">
          <span className="msg" role="status" data-tone={message ? (message.ok ? undefined : "danger") : undefined}>
            {message?.text ?? "Conventions, decisions, gotchas. Agents add their own below."}
          </span>
          <a className="btn btn-secondary" href={`/api/context/${repo}/export`} title="Notes and recent work as one Markdown file, e.g. to commit next to AGENTS.md">
            <DownloadSimple size={15} />
            Export
          </a>
          <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
            Save notes
          </button>
        </div>
      </form>

      <div className="field">
        <span className="label">Recent work and notes</span>
        {view.entries.length === 0 ? (
          <p className="hint">Nothing yet. Each turn on this repo, and each note an agent or editor adds, shows up here.</p>
        ) : (
          <ul className="context-log">
            {view.entries.map((e) => {
              const Icon = KIND[e.kind]?.icon ?? NotePencil;
              const fromCloudly = e.source === "cloudly";
              return (
                <li key={e.id}>
                  <span className="who" title={fromCloudly ? harnessById(e.author).name : `${e.author}, through the context MCP endpoint`}>
                    {fromCloudly ? <AgentLogo harness={e.author} size={15} /> : <Plugs size={15} />}
                  </span>
                  <div className="what">
                    <div className="line">
                      <Icon size={13} />
                      <span className="kind">{KIND[e.kind]?.label ?? e.kind}</span>
                      <span className="title">{e.title}</span>
                    </div>
                    {e.body ? <p className="body">{e.body}</p> : null}
                    <div className="meta">
                      {fromCloudly ? harnessById(e.author).name : e.author} · {relativeTime(e.createdAt)}
                      {e.threadId ? (
                        <>
                          {" · "}
                          <Link href={`/app/s/${e.threadId}`}>session</Link>
                        </>
                      ) : null}
                      {e.prUrl ? (
                        <>
                          {" · "}
                          <a href={e.prUrl} target="_blank" rel="noreferrer">
                            <GitPullRequest size={12} /> PR
                          </a>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <button type="button" className="icon-btn" onClick={() => remove(e.id)} aria-label={`Remove "${e.title}"`} title="Remove">
                    <Trash size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="form-foot" style={{ justifyContent: "space-between" }}>
        <Link href="/app/settings#context" className="text-link">
          Connect Cursor or Claude Code to this context
        </Link>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => save({ enabled: false })}>
          Turn off
        </button>
      </div>
    </div>
  );
}
