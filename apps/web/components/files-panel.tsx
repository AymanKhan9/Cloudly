"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadSimple, FileText, Trash, UploadSimple } from "@phosphor-icons/react";
import { api, ApiError, bytes, type RepoFileRow } from "@/lib/api";
import { relativeTime } from "@/lib/harness";

/**
 * A repo's kept files: mounted at /files in every run, outside git. Drop files
 * here for the agent; whatever it leaves there shows up here too.
 */
export function FilesPanel({ repo, compact = false }: { repo: string; compact?: boolean }) {
  const [files, setFiles] = useState<RepoFileRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const base = `/files/${repo}`;

  const load = useCallback(() => {
    setFiles(null);
    api<{ files: RepoFileRow[] }>(base).then((r) => setFiles(r.files)).catch((e: Error) => {
      setFiles([]);
      setError(e.message);
    });
  }, [base]);
  useEffect(() => {
    if (repo) load();
  }, [repo, load]);

  async function upload(list: FileList | File[]) {
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(list)) {
        // Raw bytes, not JSON: api() would set a JSON content type.
        const res = await fetch(`/api${base}?path=${encodeURIComponent(file.name)}`, { method: "PUT", credentials: "include", body: file });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new ApiError(res.status, body.message ?? `Upload failed (${res.status})`);
        setFiles(body.files);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(path: string) {
    const r = await api<{ files: RepoFileRow[] }>(`${base}?path=${encodeURIComponent(path)}`, { method: "DELETE" }).catch(() => null);
    if (r) setFiles(r.files);
  }

  const total = files?.reduce((n, f) => n + f.size, 0) ?? 0;

  return (
    <div
      className="files"
      data-dragging={dragging || undefined}
      data-compact={compact || undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
      }}
    >
      {files === null ? (
        <div className="skeleton" style={{ width: "60%" }} aria-busy="true" />
      ) : files.length === 0 ? (
        <p className="hint">No files yet. Drop files here, or ask the agent to save something in /files.</p>
      ) : (
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.path}>
              <FileText size={15} />
              <span className="mono path" title={`/files/${f.path}`}>
                {f.path}
              </span>
              <span className="num dim">{bytes(f.size)}</span>
              <span className="dim hide-sm">{relativeTime(f.updatedAt)}</span>
              <a className="icon-btn" href={`/api${base}/content?path=${encodeURIComponent(f.path)}`} aria-label={`Download ${f.path}`} title="Download">
                <DownloadSimple size={15} />
              </a>
              <button type="button" className="icon-btn" onClick={() => remove(f.path)} aria-label={`Delete ${f.path}`} title="Delete">
                <Trash size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-foot">
        <span className="msg" role="status" data-tone={error ? "danger" : undefined}>
          {error ?? (files?.length ? `${files.length} file${files.length === 1 ? "" : "s"}, ${bytes(total)}` : "Up to 25 MB a file, 200 MB a repo.")}
        </span>
        <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
        <button type="button" className="btn btn-secondary" disabled={busy || !repo} onClick={() => input.current?.click()}>
          <UploadSimple size={15} />
          {busy ? "Uploading" : "Upload"}
        </button>
      </div>
    </div>
  );
}
