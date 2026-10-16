"use client";

import { useEffect, useRef, useState } from "react";
import { Gauge } from "@phosphor-icons/react";
import { DEFAULT_EFFORT, EFFORT_LABEL, effortLevels } from "@repo/shared/effort";

const HINT: Record<string, string> = {
  low: "Quickest answers, least thinking.",
  medium: "A balance of speed and depth.",
  high: "Thinks things through before acting.",
  xhigh: "Deeper reasoning for hard problems.",
  max: "As much thinking as the model allows.",
};

/**
 * How hard the agent thinks, as a stepped slider. `value` null means the
 * agent's own default; onChange(null) goes back to it.
 */
export function EffortControl({
  harness,
  value,
  onChange,
  up = false,
  note,
}: {
  harness: string;
  value: string | null;
  onChange: (effort: string | null) => void;
  up?: boolean;
  note?: string;
}) {
  const levels = effortLevels(harness);
  const fallback = DEFAULT_EFFORT[harness as keyof typeof DEFAULT_EFFORT];
  const shown = value ?? fallback;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(shown);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<number>(0);

  useEffect(() => setDraft(shown), [shown]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  if (levels.length === 0) return null;
  const index = Math.max(0, levels.indexOf(draft));

  // Save once the slider settles, not on every step it passes.
  const pick = (level: string) => {
    setDraft(level);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onChange(level), 350);
  };

  return (
    <div className="picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Effort: ${EFFORT_LABEL[shown] ?? shown}${value ? "" : ", the default"}`}
        title="How hard the agent thinks"
        onClick={() => setOpen((o) => !o)}
      >
        <Gauge size={15} />
        <span className="pill-text">{EFFORT_LABEL[shown] ?? shown}</span>
      </button>

      {open ? (
        <div
          className="menu effort"
          data-up={up || undefined}
          role="dialog"
          aria-label="Effort"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          <div className="effort-head">
            <span>Effort</span>
            <strong>{EFFORT_LABEL[draft] ?? draft}</strong>
          </div>
          <input
            type="range"
            className="effort-range"
            min={0}
            max={levels.length - 1}
            step={1}
            value={index}
            autoFocus
            aria-label="Effort"
            aria-valuetext={EFFORT_LABEL[draft] ?? draft}
            onChange={(e) => pick(levels[Number(e.target.value)]!)}
            style={{ "--pct": `${(index / Math.max(1, levels.length - 1)) * 100}%` } as React.CSSProperties}
          />
          <div className="effort-marks" aria-hidden="true">
            {levels.map((l) => (
              <button key={l} type="button" tabIndex={-1} data-on={l === draft || undefined} onClick={() => pick(l)}>
                {EFFORT_LABEL[l] ?? l}
              </button>
            ))}
          </div>
          <p className="effort-hint">{HINT[draft] ?? ""}</p>
          <div className="effort-foot">
            <span>{value ? "Saved for this session" : `Default for this agent: ${EFFORT_LABEL[fallback ?? ""] ?? fallback}`}</span>
            {value ? (
              <button type="button" className="link-btn" onClick={() => onChange(null)}>
                Use default
              </button>
            ) : null}
          </div>
          {note ? <p className="menu-note">{note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
