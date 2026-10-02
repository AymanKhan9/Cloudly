"use client";

import { useState } from "react";
import { Barometer, Oktas, budgetStateFor } from "./notation";
import { StormFlag } from "./icons";

const LIMIT = 20;

function money(n: number) {
  return `$${n.toFixed(2)}`;
}

export function SpendDemo() {
  const [spent, setSpent] = useState(9.4);
  const ratio = spent / LIMIT;
  const state = budgetStateFor(ratio);
  const spentOf = `${money(spent)} of ${money(LIMIT)}`;

  return (
    <div className="spend">
      <div>
        <Barometer ratio={ratio} spentLabel={money(spent)} limitLabel={money(LIMIT)} />
        <div className="spend-control">
          <label htmlFor="spend-range">
            <span>Drag to spend this month</span>
            <span className="num">{Math.round(ratio * 100)}% of limit</span>
          </label>
          <input
            id="spend-range"
            type="range"
            min={0}
            max={25}
            step={0.1}
            value={spent}
            onChange={(e) => setSpent(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="consequence" data-state={state} aria-live="polite">
        {state === "fair" ? (
          <>
            <h3 className="display">Fair. Runs start normally.</h3>
            <p>Under 80% of your limit nothing interrupts you. Every run's cost is recorded the moment its harness reports it.</p>
            <div className="last-run">
              <Oktas eighths={8} title="Finished" />
              <span>Add per-key rate limiting to POST /invoices</span>
              <span className="num">$0.38</span>
            </div>
          </>
        ) : null}

        {state === "change" ? (
          <>
            <h3 className="display">Change. You get one warning.</h3>
            <p>At 80% Cloudly shows a banner in the app and sends one email for the month. Runs keep going.</p>
            <div className="mail">
              <div className="from">Cloudly · to you</div>
              <div className="subj">Cloudly: 80% of your monthly spend limit used ({spentOf})</div>
            </div>
          </>
        ) : null}

        {state === "storm" ? (
          <>
            <h3 className="display state-head">
              <StormFlag size={26} />
              Storm. Then it stops.
            </h3>
            <p>At 100%, new runs are refused and in-flight runs are cancelled. Cancelled runs keep their work: the patch is stored and the branch pushed.</p>
            <div className="mail">
              <div className="from">Cloudly · to you</div>
              <div className="subj">Cloudly stopped: spend limit reached ({spentOf})</div>
            </div>
            <div className="stopped-row">
              <span className="stamp" data-inked>
                Cancelled
              </span>
              <s>Refactor invoice export to streaming CSV</s>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
