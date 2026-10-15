"use client";

import { useState } from "react";
import { Bell, Prohibit, CheckCircle } from "@phosphor-icons/react";
import { budgetStateFor } from "./status";

const LIMIT = 20;
const MAX = 25;
const money = (n: number) => `$${n.toFixed(2)}`;

const OUTCOME = {
  fair: {
    icon: <CheckCircle size={22} weight="bold" style={{ color: "var(--ok)" }} />,
    title: "Runs start normally.",
    body: "Under 80% of your limit nothing interrupts you. Each run's cost is recorded the moment the agent reports it.",
    preview: null,
  },
  change: {
    icon: <Bell size={22} weight="bold" style={{ color: "var(--warn)" }} />,
    title: "You get one warning.",
    body: "At 80% the app shows a banner and sends one email for the month. Runs keep going.",
    preview: "80% of your monthly spend limit used",
  },
  storm: {
    icon: <Prohibit size={22} weight="bold" style={{ color: "var(--danger)" }} />,
    title: "New runs are refused.",
    body: "A turn that's already running finishes, so nothing is left half done. Claude Agent turns can't run past 25% over your limit.",
    preview: "Spend limit reached. New runs are blocked",
  },
};

export function SpendDemo() {
  const [spent, setSpent] = useState(9.4);
  const state = budgetStateFor(spent / LIMIT);
  const o = OUTCOME[state];

  return (
    <div className="spend">
      <div className="spend-gauge">
        <div className="spend-read">
          <span className="big num">{money(spent)}</span>
          <span className="of">of {money(LIMIT)} this month</span>
        </div>
        <div className="meter" data-state={state}>
          <label htmlFor="spend-range" className="visually-hidden">
            Spend this month
          </label>
          <input
            id="spend-range"
            className="meter-range"
            type="range"
            min={0}
            max={MAX}
            step={0.1}
            value={spent}
            onChange={(e) => setSpent(Number(e.target.value))}
            aria-valuetext={`${money(spent)}, ${Math.round((spent / LIMIT) * 100)}% of the limit`}
            style={{ "--pct": `${(spent / MAX) * 100}%` } as React.CSSProperties}
          />
          <div className="meter-marks" aria-hidden="true">
            <span style={{ left: 0 }}>$0</span>
            <span style={{ left: `${(16 / MAX) * 100}%` }}>80%</span>
            <span style={{ left: `${(LIMIT / MAX) * 100}%` }}>Limit</span>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>Drag to spend the month.</p>
      </div>

      <div className="spend-outcome" aria-live="polite">
        <h3>
          {o.icon}
          {o.title}
        </h3>
        <p>{o.body}</p>
        {o.preview ? (
          <div className="preview-banner" key={state}>
            <span className="state-dot" style={{ background: state === "storm" ? "var(--danger)" : "var(--warn)", marginTop: 5 }} />
            <span>
              <small>Email and in-app banner</small>
              {o.preview} ({money(spent)} of {money(LIMIT)}).
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
