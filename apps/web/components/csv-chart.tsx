"use client";

import { useMemo, useRef, useState } from "react";

// A quick chart of a CSV artifact: the first column along the bottom, up to four
// columns of numbers as series on one axis. Dates or numbers along the bottom
// make a line chart; names make columns. The table view (in artifacts.tsx) is
// always one click away and holds every value.
//
// Palette: the dataviz reference categorical slots 1-4 (blue, orange, aqua,
// yellow), validated light and dark; two of the light steps are under 3:1 on
// the surface, which the legend, tooltip and table carry.

export interface Parsed {
  header: string[];
  rows: string[][];
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string, sep = ","): Parsed {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c !== "")) out.push(row);
      row = [];
    } else field += ch;
    if (out.length > 20_000) break;
  }
  row.push(field);
  if (row.some((c) => c !== "")) out.push(row);
  const [header = [], ...rows] = out;
  return { header: header.map((h) => h.trim()), rows };
}

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const t = v.replace(/[,$%\s]/g, "");
  if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  return Number(t);
};
const DATE = /^\d{4}-\d{2}(-\d{2})?([T ][\d:.]+Z?)?$/;

export interface ChartSpec {
  form: "line" | "bar";
  xName: string;
  xType: "num" | "date" | "cat";
  x: string[];
  xs: number[];
  series: { name: string; values: (number | null)[] }[];
  note?: string;
}

const MAX_SERIES = 4;

export function chartSpec(p: Parsed): ChartSpec | null {
  if (p.header.length < 2 || p.rows.length < 2) return null;
  const rows = p.rows.slice(0, 2000);
  const cols = p.header.map((name, i) => ({ name: name || `Column ${i + 1}`, i }));
  const numeric = cols.slice(1).filter((c) => rows.filter((r) => num(r[c.i]) !== null).length >= rows.length * 0.8);
  if (!numeric.length) return null;
  const xRaw = rows.map((r) => (r[0] ?? "").trim());
  const xType: ChartSpec["xType"] = xRaw.every((v) => num(v) !== null) ? "num" : xRaw.every((v) => DATE.test(v) && !Number.isNaN(Date.parse(v))) ? "date" : "cat";
  const form = xType === "cat" ? "bar" : "line";
  if (form === "bar" && rows.length > 40) return null;
  let order = rows.map((_, i) => i);
  const xv = (i: number) => (xType === "num" ? num(xRaw[i])! : xType === "date" ? Date.parse(xRaw[i]!) : i);
  if (form === "line") order = order.sort((a, b) => xv(a) - xv(b));
  const used = numeric.slice(0, MAX_SERIES);
  return {
    form, xType, xName: cols[0]!.name,
    x: order.map((i) => xRaw[i]!),
    xs: order.map(xv),
    series: used.map((c) => ({ name: c.name, values: order.map((i) => num(rows[i]![c.i])) })),
    note: numeric.length > MAX_SERIES ? `Charting the first ${MAX_SERIES} of ${numeric.length} number columns; the table has them all.` : undefined,
  };
}

/** Round tick steps: 1, 2, 5 × 10^n. */
function ticks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const axisNum = (v: number, top: number) => (Math.abs(top) >= 10_000 ? compact.format(v) : full.format(v));

function xLabel(spec: ChartSpec, i: number) {
  if (spec.xType === "date") {
    const d = new Date(spec.xs[i]!);
    return /T| /.test(spec.x[i]!) ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" }) : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: spec.x[i]!.length > 7 ? "numeric" : undefined });
  }
  return spec.x[i]!;
}

const W = 720;
const H = 300;
const M = { top: 14, right: 16, bottom: 34, left: 52 };

export function CsvChart({ spec }: { spec: ChartSpec }) {
  const [hover, setHover] = useState<{ i: number; s?: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const { y, yTicks } = useMemo(() => {
    const vals = spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    // Bars grow from zero; a line keeps zero in view unless the data sits far from it.
    if (spec.form === "bar" || lo > 0 && lo < hi * 0.5) lo = Math.min(lo, 0);
    if (hi < 0 && spec.form === "bar") hi = 0;
    if (lo === hi) hi = lo + 1;
    const t = ticks(lo, hi);
    const a = Math.min(lo, t[0]!);
    const b = Math.max(hi, t.at(-1)!);
    return { y: (v: number) => M.top + plotH - ((v - a) / (b - a)) * plotH, yTicks: t };
  }, [spec, plotH]);

  const n = spec.x.length;
  const xMin = spec.xs[0]!;
  const xMax = spec.xs[n - 1]!;
  const lineX = (i: number) => M.left + (xMax === xMin ? plotW / 2 : ((spec.xs[i]! - xMin) / (xMax - xMin)) * plotW);
  const band = plotW / n;
  const k = spec.series.length;
  const barW = Math.max(2, Math.min(24, (band * 0.72 - (k - 1) * 2) / k));
  const barX = (i: number, s: number) => M.left + band * i + (band - (barW * k + 2 * (k - 1))) / 2 + s * (barW + 2);
  const zero = y(0);
  const xTickIdx = spec.form === "bar" ? spec.x.map((_, i) => i).filter((i) => n <= 12 || i % Math.ceil(n / 12) === 0) : [...new Set([0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1])];

  function nearest(clientX: number) {
    const r = box.current?.querySelector("svg")?.getBoundingClientRect();
    if (!r) return 0;
    const px = ((clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(lineX(i) - px) < Math.abs(lineX(best) - px)) best = i;
    return best;
  }

  const tipLeft = hover ? ((spec.form === "line" ? lineX(hover.i) : barX(hover.i, hover.s ?? 0) + barW / 2) / W) * 100 : 0;

  return (
    <div className="viz-root csv-chart" ref={box}>
      {spec.series.length > 1 ? (
        <ul className="viz-legend" aria-label="Series">
          {spec.series.map((s, j) => (
            <li key={s.name}>
              <span className={spec.form === "line" ? "key-line" : "key-rect"} style={{ background: `var(--series-${j + 1})` }} />
              {s.name}
            </li>
          ))}
        </ul>
      ) : (
        <p className="viz-title">
          {spec.series[0]!.name} <span className="dim">by {spec.xName}</span>
        </p>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${spec.form === "line" ? "Line" : "Column"} chart of ${spec.series.map((s) => s.name).join(", ")} by ${spec.xName}`}
        tabIndex={spec.form === "line" ? 0 : undefined}
        onKeyDown={(e) => {
          if (spec.form !== "line") return;
          if (e.key === "ArrowRight") setHover((h) => ({ i: Math.min(n - 1, (h?.i ?? -1) + 1) }));
          if (e.key === "ArrowLeft") setHover((h) => ({ i: Math.max(0, (h?.i ?? n) - 1) }));
        }}
        onBlur={() => setHover(null)}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line className="viz-grid" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
            <text className="viz-axis" x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {axisNum(t, Math.max(...yTicks.map(Math.abs)))}
            </text>
          </g>
        ))}
        {xTickIdx.map((i) => (
          <text key={i} className="viz-axis" x={spec.form === "line" ? lineX(i) : M.left + band * i + band / 2} y={H - M.bottom + 18} textAnchor={spec.form === "line" ? (i === 0 ? "start" : i === n - 1 ? "end" : "middle") : "middle"}>
            {xLabel(spec, i).length > 14 ? `${xLabel(spec, i).slice(0, 13)}…` : xLabel(spec, i)}
          </text>
        ))}

        {spec.form === "line" ? (
          <>
            {spec.series.map((s, j) => {
              let d = "";
              let pen = false;
              s.values.forEach((v, i) => {
                if (v === null) {
                  pen = false;
                  return;
                }
                d += `${pen ? "L" : "M"}${lineX(i).toFixed(1)},${y(v).toFixed(1)}`;
                pen = true;
              });
              return <path key={s.name} d={d} className="viz-line" style={{ stroke: `var(--series-${j + 1})` }} />;
            })}
            {hover ? (
              <g>
                <line className="viz-cross" x1={lineX(hover.i)} x2={lineX(hover.i)} y1={M.top} y2={M.top + plotH} />
                {spec.series.map((s, j) =>
                  s.values[hover.i] === null ? null : <circle key={s.name} className="viz-dot" cx={lineX(hover.i)} cy={y(s.values[hover.i]!)} r={4} style={{ fill: `var(--series-${j + 1})` }} />,
                )}
              </g>
            ) : null}
            {/* The crosshair finds the nearest point: the reader aims at an X, not a 2px line. */}
            <rect x={M.left} y={M.top} width={plotW} height={plotH} fill="transparent" onPointerMove={(e) => setHover({ i: nearest(e.clientX) })} onPointerLeave={() => setHover(null)} />
          </>
        ) : (
          spec.series.map((s, j) =>
            s.values.map((v, i) => {
              if (v === null) return null;
              const top = Math.min(y(v), zero);
              const h = Math.max(1, Math.abs(zero - y(v)));
              const r = Math.min(4, h, barW / 2);
              const x = barX(i, j);
              // Rounded at the data end, square at the baseline.
              const d = v >= 0
                ? `M${x},${zero}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${zero}Z`
                : `M${x},${zero}V${top + h - r}Q${x},${top + h} ${x + r},${top + h}H${x + barW - r}Q${x + barW},${top + h} ${x + barW},${top + h - r}V${zero}Z`;
              const on = hover?.i === i && hover?.s === j;
              return (
                <g key={`${j}-${i}`} tabIndex={0} role="graphics-symbol" aria-label={`${spec.x[i]}, ${s.name}: ${full.format(v)}`} onPointerEnter={() => setHover({ i, s: j })} onPointerLeave={() => setHover(null)} onFocus={() => setHover({ i, s: j })} onBlur={() => setHover(null)}>
                  {/* The hit area is the whole slot, not just the painted bar. */}
                  <rect x={x - 1} y={M.top} width={barW + 2} height={plotH} fill="transparent" />
                  <path d={d} className="viz-bar" data-on={on || undefined} style={{ fill: `var(--series-${j + 1})` }} />
                </g>
              );
            }),
          )
        )}
        <line className="viz-base" x1={M.left} x2={W - M.right} y1={zero} y2={zero} />
      </svg>
      {hover ? (
        // Beside the mark, never on it: to its right, or its left past the middle.
        <div className="viz-tip" data-flip={tipLeft > 60 || undefined} style={{ left: `${tipLeft}%` }} role="status">
          <div className="viz-tip-x">{xLabel(spec, hover.i)}</div>
          {spec.series.map((s, j) =>
            hover.s !== undefined && hover.s !== j ? null : (
              <div key={s.name} className="viz-tip-row">
                <span className="key-line" style={{ background: `var(--series-${j + 1})` }} />
                <strong>{s.values[hover.i] === null ? "–" : full.format(s.values[hover.i]!)}</strong>
                <span className="dim">{s.name}</span>
              </div>
            ),
          )}
        </div>
      ) : null}
      {spec.note ? <p className="hint">{spec.note}</p> : null}
    </div>
  );
}
