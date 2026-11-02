"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import { ArrowCounterClockwise, CaretRight, ChatCircleText, MagnifyingGlass, PaperPlaneTilt, Plus, X } from "@phosphor-icons/react";
import { parseDiff, type DiffFile } from "@repo/shared/diff";
import { api, ApiError, type ReviewFinding, type SessionChanges } from "@/lib/api";
import { harnessById } from "@/lib/harness";

const SEVERITY_LABEL = { blocking: "Blocking", suggestion: "Suggestion", nit: "Nit" } as const;
const SEVERITY_ORDER = { blocking: 0, suggestion: 1, nit: 2 } as const;

type Comment = { file: string; line: number; body: string };
const key = (file: string, line: number) => `${file}:${line}`;

function FindingCard({
  f,
  picked,
  onPick,
  onStatus,
  showWhere,
}: {
  f: ReviewFinding;
  picked: boolean;
  onPick: (on: boolean) => void;
  onStatus: (status: "open" | "dismissed") => void;
  showWhere?: boolean;
}) {
  const dismissed = f.status === "dismissed";
  return (
    <div className="finding" data-severity={f.severity} data-status={f.status}>
      <div className="finding-head">
        {f.status === "open" ? (
          <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`Send "${f.title}" to the agent`} />
        ) : null}
        <span className="sev">{SEVERITY_LABEL[f.severity]}</span>
        <strong>{f.title}</strong>
        {showWhere && f.file ? (
          <code className="mono dim">
            {f.file}
            {f.line ? `:${f.line}` : ""}
          </code>
        ) : null}
        <span className="spacer" />
        {f.status === "sent" ? <span className="dim">Sent to the agent</span> : null}
        {f.status !== "sent" ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onStatus(dismissed ? "open" : "dismissed")} title={dismissed ? "Bring it back" : "Not worth fixing"}>
            {dismissed ? <ArrowCounterClockwise size={13} /> : <X size={13} />}
            {dismissed ? "Restore" : "Dismiss"}
          </button>
        ) : null}
      </div>
      {f.body && !dismissed ? (
        <div className="finding-body">
          <Markdown>{f.body}</Markdown>
        </div>
      ) : null}
    </div>
  );
}

function FileDiff({
  file,
  findings,
  comments,
  composing,
  setComposing,
  addComment,
  removeComment,
  card,
}: {
  file: DiffFile;
  findings: Map<number, ReviewFinding[]>;
  comments: Comment[];
  composing: string | null;
  setComposing: (k: string | null) => void;
  addComment: (c: Comment) => void;
  removeComment: (c: Comment) => void;
  card: (f: ReviewFinding) => React.ReactNode;
}) {
  const [text, setText] = useState("");
  const count = [...findings.values()].reduce((n, l) => n + l.length, 0) + comments.length;
  return (
    <details className="diff-file" open>
      <summary>
        <CaretRight size={12} weight="bold" className="chev" />
        <span className="mono path" title={file.path}>
          {file.status === "renamed" && file.oldPath ? `${file.oldPath} → ` : ""}
          {file.path}
        </span>
        {file.status === "added" || file.status === "deleted" ? <span className="file-tag">{file.status === "added" ? "New" : "Deleted"}</span> : null}
        {count ? (
          <span className="file-tag" title="Findings and comments on this file">
            <ChatCircleText size={12} /> {count}
          </span>
        ) : null}
        <span className="spacer" />
        <span className="num diffstat">
          <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
        </span>
      </summary>
      {file.binary ? (
        <p className="hint diff-note">Binary file, not shown.</p>
      ) : (
        <table className="diff-table mono">
          <tbody>
            {file.hunks.map((h, hi) => (
              <Fragment key={hi}>
                <tr className="hunk">
                  <td colSpan={4}>{h.header}</td>
                </tr>
                {h.lines.map((l, li) => {
                  const line = l.newLine;
                  const k = line ? key(file.path, line) : null;
                  const here = line ? findings.get(line) ?? [] : [];
                  const mine = line ? comments.filter((c) => c.line === line) : [];
                  return (
                    <Fragment key={li}>
                      <tr className="line" data-type={l.type}>
                        <td className="ln">{l.oldLine ?? ""}</td>
                        <td className="ln">{l.newLine ?? ""}</td>
                        <td className="add-btn">
                          {k ? (
                            <button
                              type="button"
                              aria-label={`Comment on line ${line}`}
                              title="Comment on this line"
                              onClick={() => {
                                setText("");
                                setComposing(composing === k ? null : k);
                              }}
                            >
                              <Plus size={11} weight="bold" />
                            </button>
                          ) : null}
                        </td>
                        <td className="code">
                          <span className="sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
                          {l.text}
                        </td>
                      </tr>
                      {here.length || mine.length || composing === k ? (
                        <tr className="inline">
                          <td colSpan={4}>
                            {here.map((f) => card(f))}
                            {mine.map((c, ci) => (
                              <div key={ci} className="my-comment">
                                <ChatCircleText size={14} />
                                <span>{c.body}</span>
                                <span className="spacer" />
                                <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeComment(c)}>
                                  Remove
                                </button>
                              </div>
                            ))}
                            {composing === k && line ? (
                              <form
                                className="comment-form"
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  if (!text.trim()) return;
                                  addComment({ file: file.path, line, body: text.trim() });
                                  setComposing(null);
                                }}
                              >
                                <textarea
                                  className="textarea"
                                  rows={2}
                                  autoFocus
                                  value={text}
                                  maxLength={4000}
                                  onChange={(e) => setText(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Escape") setComposing(null);
                                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
                                  }}
                                  placeholder="What should change here?"
                                  aria-label={`Comment on ${file.path} line ${line}`}
                                />
                                <div className="comment-actions">
                                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setComposing(null)}>
                                    Cancel
                                  </button>
                                  <button type="submit" className="btn btn-secondary btn-sm" disabled={!text.trim()}>
                                    Add comment
                                  </button>
                                </div>
                              </form>
                            ) : null}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

/**
 * A session's Changes tab: everything it has changed so far, the reviewer's
 * findings on the lines they're about, and the user's own line comments. Picked
 * findings and comments go to the agent together, as one turn.
 */
export function ChangesPanel({ threadId, agent, busy, version, audit }: { threadId: string; agent: string; busy: boolean; version: string; audit: boolean }) {
  const [data, setData] = useState<SessionChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [comments, setComments] = useState<Comment[]>([]);
  const [composing, setComposing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);

  const load = () =>
    api<SessionChanges>(`/threads/${threadId}/changes`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));

  // Again whenever a turn starts or ends: a commit or a review changes what's here.
  useEffect(() => {
    load();
  }, [threadId, version]);

  const files = useMemo(() => (data?.diff ? parseDiff(data.diff) : []), [data?.diff]);

  // Findings on a line of the diff go there; the rest are listed above it.
  const { byLine, general } = useMemo(() => {
    const byLine = new Map<string, Map<number, ReviewFinding[]>>();
    const general: ReviewFinding[] = [];
    const visible = (data?.findings ?? []).filter((f) => showDismissed || f.status !== "dismissed");
    for (const f of [...visible].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])) {
      const file = f.file ? files.find((x) => x.path === f.file) : undefined;
      const onLine = file && f.line && file.hunks.some((h) => h.lines.some((l) => l.newLine === f.line));
      if (!file || !f.line || !onLine) {
        general.push(f);
        continue;
      }
      const lines = byLine.get(file.path) ?? new Map<number, ReviewFinding[]>();
      lines.set(f.line, [...(lines.get(f.line) ?? []), f]);
      byLine.set(file.path, lines);
    }
    return { byLine, general };
  }, [data?.findings, files, showDismissed]);

  if (error) return <p className="hint" role="alert">{error}</p>;
  if (!data) return <div className="skeleton" style={{ width: "50%" }} aria-busy="true" />;

  const open = data.findings.filter((f) => f.status === "open");
  const dismissedCount = data.findings.filter((f) => f.status === "dismissed").length;
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const reviewer = data.reviewer ? harnessById(data.reviewer).name : null;
  const selected = picked.size + comments.length;

  async function setStatus(f: ReviewFinding, status: "open" | "dismissed") {
    setData((d) => (d ? { ...d, findings: d.findings.map((x) => (x.id === f.id ? { ...x, status } : x)) } : d));
    setPicked((p) => {
      const n = new Set(p);
      n.delete(f.id);
      return n;
    });
    try {
      await api(`/threads/${threadId}/findings/${f.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update the finding.");
      load();
    }
  }

  async function review() {
    setError(null);
    try {
      await api(`/threads/${threadId}/review`, { method: "POST", body: JSON.stringify({}) });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't start the review.");
    }
  }

  async function send() {
    setSending(true);
    setError(null);
    try {
      await api(`/threads/${threadId}/feedback`, {
        method: "POST",
        body: JSON.stringify({ findingIds: [...picked], comments, note: note.trim() || undefined }),
      });
      setPicked(new Set());
      setComments([]);
      setNote("");
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't send.");
    } finally {
      setSending(false);
    }
  }

  const card = (f: ReviewFinding) => (
    <FindingCard
      key={f.id}
      f={f}
      picked={picked.has(f.id)}
      showWhere={!byLine.get(f.file ?? "")?.get(f.line ?? 0)?.includes(f)}
      onPick={(on) =>
        setPicked((p) => {
          const n = new Set(p);
          if (on) n.add(f.id);
          else n.delete(f.id);
          return n;
        })
      }
      onStatus={(s) => setStatus(f, s)}
    />
  );

  return (
    <div className="changes">
      <div className="changes-bar">
        {files.length ? (
          <span>
            {files.length} file{files.length === 1 ? "" : "s"} changed{" "}
            <span className="num diffstat">
              <span className="add">+{additions}</span> <span className="del">−{deletions}</span>
            </span>
          </span>
        ) : (
          <span className="dim">{audit ? "Nothing changed yet. Pick findings below to have them fixed." : "No changes yet."}</span>
        )}
        {open.length ? (
          <span className="dim">
            {open.length} open finding{open.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {dismissedCount ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowDismissed((v) => !v)}>
            {showDismissed ? "Hide" : "Show"} {dismissedCount} dismissed
          </button>
        ) : null}
        <span className="spacer" />
        {files.length ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={review}
            disabled={busy}
            title={reviewer ? `${reviewer} reviews everything this session changed` : `${agent} reviews everything this session changed. Pick a reviewer for this repo in Settings > Checks and review.`}
          >
            <MagnifyingGlass size={14} />
            Review {reviewer ? `with ${reviewer}` : "now"}
          </button>
        ) : null}
      </div>

      {selected > 0 ? (
        <div className="changes-send">
          <textarea className="textarea" rows={1} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything to add (optional)" maxLength={4000} aria-label="Note for the agent" />
          <button type="button" className="btn btn-primary" onClick={send} disabled={sending || busy} title={busy ? "Wait for the current turn to finish" : undefined}>
            <PaperPlaneTilt size={15} />
            Send {selected} to {agent}
          </button>
        </div>
      ) : null}

      {general.length ? (
        <div className="findings-general">
          <h3>{audit && !files.length ? "Findings" : "Findings not on a changed line"}</h3>
          {general.map(card)}
        </div>
      ) : null}

      {files.map((f) => (
        <FileDiff
          key={f.path}
          file={f}
          findings={byLine.get(f.path) ?? new Map()}
          comments={comments.filter((c) => c.file === f.path)}
          composing={composing}
          setComposing={setComposing}
          addComment={(c) => setComments((list) => [...list, c])}
          removeComment={(c) => setComments((list) => list.filter((x) => x !== c))}
          card={card}
        />
      ))}

    </div>
  );
}
