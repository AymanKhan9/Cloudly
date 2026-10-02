/**
 * The WMO station-model sky-cover symbol. Meteorologists record cloud cover
 * in oktas (eighths of the sky); Cloudly records a run's progress the same
 * way. `obscured` is the WMO "sky obscured" symbol, used for failed runs.
 */
export function Oktas({
  eighths,
  size = 20,
  obscured = false,
  title,
}: {
  eighths: number;
  size?: number;
  obscured?: boolean;
  title?: string;
}) {
  const r = 9;
  const n = Math.max(0, Math.min(8, Math.round(eighths)));
  const angle = (n / 8) * Math.PI * 2;
  const x = 12 + r * Math.sin(angle);
  const y = 12 - r * Math.cos(angle);
  const large = angle > Math.PI ? 1 : 0;

  return (
    <svg className="oktas" width={size} height={size} viewBox="0 0 24 24" role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      {n === 8 ? (
        <circle cx="12" cy="12" r={r} fill="currentColor" />
      ) : n > 0 ? (
        <path d={`M12 12 L12 ${12 - r} A${r} ${r} 0 ${large} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`} fill="currentColor" />
      ) : null}
      <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth="1.6" />
      {obscured ? <path d="M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" stroke="currentColor" strokeWidth="1.6" /> : null}
    </svg>
  );
}

export type BudgetState = "fair" | "change" | "storm";

const ARC_START = Math.PI * 1.15;
const ARC_END = Math.PI * -0.15;
const SCALE_MAX = 1.25;
// Storm red is the maritime storm-warning flag: it marks only the hard stop.
const STORM = "#c2231b";
const ROSE = "#e8b9a6";

function polar(cx: number, cy: number, r: number, a: number) {
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)] as const;
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number) {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  const large = Math.abs(from - to) > Math.PI ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

function angleFor(ratio: number) {
  const t = Math.max(0, Math.min(SCALE_MAX, ratio)) / SCALE_MAX;
  return ARC_START + (ARC_END - ARC_START) * t;
}

/**
 * Aneroid barometer, re-read as a spend gauge: Fair below 80% of the limit,
 * Change from 80%, Storm at 100% (the hard stop). The zone words sit outside
 * the dial so the needle never crosses them.
 */
export function Barometer({
  ratio,
  spentLabel,
  limitLabel,
  tone = "dark",
  compact = false,
  className = "barometer-dial",
}: {
  ratio: number;
  spentLabel: string;
  limitLabel: string;
  tone?: "dark" | "light";
  compact?: boolean;
  className?: string;
}) {
  const cx = 200;
  const cy = 200;
  const ink = tone === "dark" ? "#eef2f7" : "#0f1b33";
  const dim = tone === "dark" ? "rgba(238,242,247,0.5)" : "rgba(15,27,51,0.45)";
  const roseText = tone === "dark" ? ROSE : "#8e3f27";
  const a = angleFor(ratio);
  const [nx, ny] = polar(cx, cy, 136, a);
  const [tx, ty] = polar(cx, cy, 24, a + Math.PI);
  const ticks = Array.from({ length: 26 }, (_, i) => i / 20);

  const zone = (from: number, to: number) => arcPath(cx, cy, 152, angleFor(from), angleFor(to));
  const word = (text: string, at: number, color: string, flag = false) => {
    const [lx, ly] = polar(cx, cy, 214, angleFor(at));
    return (
      <g>
        {flag ? (
          <g transform={`translate(${lx - 58} ${ly - 5})`}>
            <rect width="12" height="9" fill={STORM} />
            <rect x="4" y="2.5" width="4" height="4" fill="#0f1b33" />
          </g>
        ) : null}
        <text x={lx} y={ly} fill={color} textAnchor="middle" dominantBaseline="middle" className="caps" style={{ fontSize: compact ? 22 : 13 }}>
          {text}
        </text>
      </g>
    );
  };

  return (
    <svg className={className} viewBox="-70 -30 540 330" role="img" aria-label={`Spend gauge: ${spentLabel} of ${limitLabel}`}>
      <path d={zone(0, 0.8)} stroke={dim} strokeWidth={compact ? 14 : 2} fill="none" />
      <path d={zone(0.8, 1)} stroke={ROSE} strokeWidth={compact ? 36 : 14} fill="none" />
      <path d={zone(1, SCALE_MAX)} stroke={STORM} strokeWidth={compact ? 36 : 14} fill="none" />
      {(compact ? [] : ticks).map((t) => {
        const ta = angleFor(t);
        const major = Math.round(t * 20) % 5 === 0;
        const [x1, y1] = polar(cx, cy, 168, ta);
        const [x2, y2] = polar(cx, cy, major ? 184 : 176, ta);
        return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke={major ? ink : dim} strokeWidth={major ? 1.6 : 1} />;
      })}
      {compact ? null : (
        <>
          {word("Fair", 0.36, ink)}
          {word("Change", 0.9, roseText)}
          {word("Storm", 1.14, ink, true)}
        </>
      )}
      <line x1={tx} y1={ty} x2={nx} y2={ny} stroke={ink} strokeWidth={compact ? 12 : 3} strokeLinecap="round" style={{ transition: "all 600ms cubic-bezier(0.16,1,0.3,1)" }} />
      <circle cx={cx} cy={cy} r={compact ? 18 : 7} fill={ink} />
      {compact ? null : (
        <>
          <text x={cx} y={cy + 54} fill={ink} textAnchor="middle" className="num" style={{ fontSize: 26 }}>
            {spentLabel}
          </text>
          <text x={cx} y={cy + 78} fill={dim} textAnchor="middle" style={{ fontSize: 13 }}>
            of {limitLabel} this month
          </text>
        </>
      )}
    </svg>
  );
}

export function budgetStateFor(ratio: number, hasLimit = true): BudgetState {
  if (!hasLimit) return "fair";
  if (ratio >= 1) return "storm";
  if (ratio >= 0.8) return "change";
  return "fair";
}

export const STATE_WORD: Record<BudgetState, string> = {
  fair: "Fair",
  change: "Change",
  storm: "Storm",
};
