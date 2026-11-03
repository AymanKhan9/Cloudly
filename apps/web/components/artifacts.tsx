"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsOut, ChartBar, Code, DownloadSimple, File, FileCsv, FilePdf, Image as ImageIcon, LinkSimple, Table, TreeStructure, X,
} from "@phosphor-icons/react";
import { framedHtml } from "@repo/shared/artifacts";
import { api, bytes, type ArtifactMeta } from "@/lib/api";
import { RichMarkdown, MermaidDiagram } from "./rich-markdown";
import { CodeBlock } from "./code-block";
import { CsvChart, chartSpec, parseCsv } from "./csv-chart";

// What an agent made for the user to look at (see @repo/shared/artifacts),
// shown in the turn that made it. HTML runs in a sandboxed frame with an opaque
// origin and a locked-down policy, so it can't reach Cloudly or call out.

type Kind = ArtifactMeta["kind"];

const ICON: Record<Kind, React.ReactNode> = {
  html: <Code size={15} />,
  svg: <ImageIcon size={15} />,
  image: <ImageIcon size={15} />,
  markdown: <File size={15} />,
  mermaid: <TreeStructure size={15} />,
  csv: <FileCsv size={15} />,
  pdf: <FilePdf size={15} />,
  text: <File size={15} />,
};

export const contentUrl = (a: { id: string }) => `/api/artifacts/${a.id}/content`;

function useText(url: string, enabled: boolean) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setText(null);
    setError(null);
    fetch(url, { credentials: "include" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Couldn't load it (${r.status})`))))
      .then((t) => live && setText(t))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [url, enabled]);
  return { text, error };
}

function HtmlFrame({ html, title, tall }: { html: string; title: string; tall?: boolean }) {
  // No allow-same-origin: the page gets an opaque origin, so no cookies, storage or Cloudly DOM.
  return <iframe className="artifact-frame" data-tall={tall || undefined} sandbox="allow-scripts allow-popups" srcDoc={framedHtml(html)} title={title} />;
}

function CsvView({ text, tsv }: { text: string; tsv: boolean }) {
  const parsed = useMemo(() => parseCsv(text, tsv ? "\t" : ","), [text, tsv]);
  const spec = useMemo(() => chartSpec(parsed), [parsed]);
  const [view, setView] = useState<"chart" | "table">(spec ? "chart" : "table");
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return parsed.rows;
    const n = (v: string) => Number(v.replace(/[,$%\s]/g, ""));
    return [...parsed.rows].sort((a, b) => {
      const x = a[sort.col] ?? "";
      const y = b[sort.col] ?? "";
      const cmp = !Number.isNaN(n(x)) && !Number.isNaN(n(y)) && x.trim() && y.trim() ? n(x) - n(y) : x.localeCompare(y);
      return sort.desc ? -cmp : cmp;
    });
  }, [parsed, sort]);
  const shown = rows.slice(0, 500);
  return (
    <div className="csv-view">
      <div className="csv-bar">
        <span className="dim">
          {parsed.rows.length} row{parsed.rows.length === 1 ? "" : "s"} · {parsed.header.length} column{parsed.header.length === 1 ? "" : "s"}
        </span>
        <div className="seg" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={view === "chart"} disabled={!spec} title={spec ? undefined : "Needs a first column and at least one column of numbers"} onClick={() => setView("chart")}>
            <ChartBar size={14} /> Chart
          </button>
          <button type="button" role="tab" aria-selected={view === "table"} onClick={() => setView("table")}>
            <Table size={14} /> Table
          </button>
        </div>
      </div>
      {view === "chart" && spec ? (
        <CsvChart spec={spec} />
      ) : (
        <div className="md-table csv-table">
          <table>
            <thead>
              <tr>
                {parsed.header.map((h, i) => (
                  <th key={i} aria-sort={sort?.col === i ? (sort.desc ? "descending" : "ascending") : undefined}>
                    <button type="button" onClick={() => setSort(sort?.col === i ? { col: i, desc: !sort.desc } : { col: i, desc: false })}>
                      {h || `Column ${i + 1}`}
                      {sort?.col === i ? (sort.desc ? " ↓" : " ↑") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i}>
                  {parsed.header.map((_, j) => (
                    <td key={j}>{r[j] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > shown.length ? <p className="hint" style={{ padding: "8px 12px" }}>The first 500 rows of {rows.length}. Download it for the rest.</p> : null}
        </div>
      )}
    </div>
  );
}

/** An artifact's content, by kind. `url` is where its bytes are (signed in, or a share link). */
export function ArtifactBody({ a, url, tall, resolveImage }: { a: Pick<ArtifactMeta, "kind" | "name" | "size">; url: string; tall?: boolean; resolveImage?: (src: string) => string | null }) {
  const textKind = a.kind === "html" || a.kind === "markdown" || a.kind === "mermaid" || a.kind === "csv" || a.kind === "text";
  const { text, error } = useText(url, textKind);
  if (error) return <p className="hint" role="alert">{error}</p>;
  if (a.kind === "svg" || a.kind === "image") return <img className="artifact-img" data-tall={tall || undefined} src={url} alt={a.name} />;
  if (a.kind === "pdf") return <iframe className="artifact-frame" data-tall={tall || undefined} src={url} title={a.name} />;
  if (text === null) return <div className="skeleton" style={{ height: 160 }} aria-busy="true" />;
  if (a.kind === "html") return <HtmlFrame html={text} title={a.name} tall={tall} />;
  if (a.kind === "markdown")
    return (
      <div className="reply artifact-doc">
        <RichMarkdown resolveImage={resolveImage}>{text}</RichMarkdown>
      </div>
    );
  if (a.kind === "mermaid") return <MermaidDiagram code={text} />;
  if (a.kind === "csv") return <CsvView text={text} tsv={a.name.toLowerCase().endsWith(".tsv")} />;
  let pretty = text;
  if (a.name.toLowerCase().endsWith(".json")) {
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {}
  }
  return (
    <div className="reply">
      <CodeBlock>{pretty.length > 200_000 ? `${pretty.slice(0, 200_000)}\n…` : pretty}</CodeBlock>
    </div>
  );
}

function ShareButton({ a }: { a: ArtifactMeta }) {
  const [shared, setShared] = useState(a.shared);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => setShared(a.shared), [a.shared]);
  async function share() {
    const { token } = await api<{ token: string }>(`/artifacts/${a.id}/share`, { method: "POST" });
    const link = `${window.location.origin}/share/${token}`;
    setShared(true);
    await navigator.clipboard?.writeText(link).catch(() => {});
    setNote(link);
    setOpen(true);
  }
  async function stop() {
    await api(`/artifacts/${a.id}/share`, { method: "DELETE" });
    setShared(false);
    setNote(null);
    setOpen(false);
  }
  return (
    <span className="artifact-share">
      <button type="button" className="icon-btn" aria-label={shared ? "Shared: copy or turn off the link" : "Share a link"} title={shared ? "Shared" : "Share a link"} data-on={shared || undefined} onClick={() => (shared && !open ? share() : shared ? setOpen(false) : share())}>
        <LinkSimple size={15} />
      </button>
      {open && note ? (
        <span className="artifact-share-pop" role="status">
          <span>Link copied. Anyone with it can view this version.</span>
          <span className="mono">{note}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={stop}>
            Turn the link off
          </button>
        </span>
      ) : null}
    </span>
  );
}

/** One artifact, at a version, with its earlier and later versions a click away. */
export function ArtifactCard({ versions, initialId, all }: { versions: ArtifactMeta[]; initialId: string; all: ArtifactMeta[] }) {
  const [id, setId] = useState(initialId);
  useEffect(() => setId(initialId), [initialId]);
  const a = versions.find((v) => v.id === id) ?? versions.at(-1)!;
  const dialog = useRef<HTMLDialogElement>(null);
  const [full, setFull] = useState(false);
  // A report's images: the session's artifact of that name, as of this version.
  const resolveImage = (src: string) => {
    const name = src.replace(/^\.?\//, "").replace(/^artifacts\//, "").replace(/^\/artifacts\//, "");
    const match = all.filter((x) => x.name === name && new Date(x.createdAt) <= new Date(a.createdAt)).at(-1) ?? all.filter((x) => x.name === name).at(0);
    return match && (match.kind === "image" || match.kind === "svg") ? contentUrl(match) : null;
  };
  return (
    <figure className="artifact" data-kind={a.kind}>
      <figcaption className="artifact-head">
        <span className="artifact-name">
          {ICON[a.kind]}
          <span className="mono">{a.name}</span>
        </span>
        {versions.length > 1 ? (
          <select className="select select-sm" aria-label="Version" value={a.id} onChange={(e) => setId(e.target.value)}>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version}
                {v.id === initialId ? " (this turn)" : ""}
              </option>
            ))}
          </select>
        ) : null}
        <span className="dim artifact-size">{bytes(a.size)}</span>
        <span className="artifact-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Full screen"
            title="Full screen"
            onClick={() => {
              setFull(true);
              dialog.current?.showModal();
            }}
          >
            <ArrowsOut size={15} />
          </button>
          <a className="icon-btn" href={`${contentUrl(a)}?download=1`} aria-label="Download" title="Download">
            <DownloadSimple size={15} />
          </a>
          <ShareButton a={a} />
        </span>
      </figcaption>
      <div className="artifact-body">
        <ArtifactBody a={a} url={contentUrl(a)} resolveImage={resolveImage} />
      </div>
      <dialog ref={dialog} className="artifact-dialog" onClose={() => setFull(false)} aria-label={a.name}>
        <div className="artifact-dialog-head">
          <span className="mono">
            {a.name} · v{a.version}
          </span>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => dialog.current?.close()}>
            <X size={16} />
          </button>
        </div>
        {full ? <ArtifactBody a={a} url={contentUrl(a)} tall resolveImage={resolveImage} /> : null}
      </dialog>
    </figure>
  );
}

const PAIR = /^(.*\/)(before|after)\.(png|jpe?g|webp|svg)$/i;

/** A page before and after a change: side by side, or one at a time to flick between. */
function ComparePair({ before, after }: { before?: ArtifactMeta; after?: ArtifactMeta }) {
  const [view, setView] = useState<"both" | "before" | "after">("both");
  const page = (after ?? before)!.name.replace(PAIR, "$1").replace(/^shots\//, "").replace(/\/$/, "");
  const shown = view === "both" ? [before, after] : [view === "before" ? before : after];
  return (
    <figure className="artifact compare">
      <figcaption className="artifact-head">
        <span className="artifact-name">
          <ImageIcon size={15} />
          <span>
            <span className="mono">{page === "home" ? "/" : `/${page}`}</span> <span className="dim">before and after</span>
          </span>
        </span>
        <div className="seg" role="tablist" aria-label="Show">
          {(["both", "before", "after"] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} disabled={(v === "before" && !before) || (v === "after" && !after)}>
              {v === "both" ? "Side by side" : v === "before" ? "Before" : "After"}
            </button>
          ))}
        </div>
      </figcaption>
      <div className="compare-body" data-view={view}>
        {shown.map((a, i) =>
          a ? (
            <a key={a.id} href={contentUrl(a)} target="_blank" rel="noreferrer" className="compare-side">
              <span className="compare-label">{a.name.match(PAIR)?.[2] === "before" ? "Before" : "After"}</span>
              <img src={contentUrl(a)} alt={`${page} ${a.name.match(PAIR)?.[2]}`} loading="lazy" />
            </a>
          ) : (
            <div key={i} className="compare-side compare-missing">{i === 0 ? "Before: didn't load" : "After: didn't load"}</div>
          ),
        )}
      </div>
    </figure>
  );
}

/** The artifacts a turn wrote, each with its other versions; before/after pairs side by side. */
export function TurnArtifacts({ turnId, all }: { turnId: string; all: ArtifactMeta[] }) {
  const mine = all.filter((a) => a.runId === turnId);
  if (!mine.length) return null;
  const pairs = new Map<string, { before?: ArtifactMeta; after?: ArtifactMeta }>();
  const single: ArtifactMeta[] = [];
  for (const a of mine) {
    const m = PAIR.exec(a.name);
    if (!m || (a.kind !== "image" && a.kind !== "svg")) {
      single.push(a);
      continue;
    }
    const p = pairs.get(m[1]!) ?? {};
    p[m[2]!.toLowerCase() as "before" | "after"] = a;
    pairs.set(m[1]!, p);
  }
  // A lone half (only "after" changed this turn): its partner is the session's latest.
  // With no partner at all it's just an image called after.png.
  for (const [prefix, p] of pairs) {
    for (const side of ["before", "after"] as const) {
      if (!p[side]) p[side] = all.filter((x) => PAIR.exec(x.name)?.[1] === prefix && PAIR.exec(x.name)?.[2]?.toLowerCase() === side).at(-1);
    }
    if (!p.before || !p.after) {
      single.push(...[p.before, p.after].filter((x): x is ArtifactMeta => Boolean(x) && x!.runId === turnId));
      pairs.delete(prefix);
    }
  }
  single.sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="artifacts">
      {[...pairs.values()].map((p) => (
        <ComparePair key={(p.after ?? p.before)!.id} before={p.before} after={p.after} />
      ))}
      {single.map((a) => (
        <ArtifactCard key={a.id} initialId={a.id} versions={all.filter((x) => x.name === a.name)} all={all} />
      ))}
    </div>
  );
}
