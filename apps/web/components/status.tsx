"use client";

import { CheckCircle, CircleDashed, CircleNotch, GitPullRequest, Prohibit, XCircle } from "@phosphor-icons/react";
import { STATUS_LABEL, type RunStatus } from "@/lib/harness";

export type BudgetState = "fair" | "change" | "storm";

export function budgetStateFor(ratio: number, hasLimit = true): BudgetState {
  if (!hasLimit) return "fair";
  if (ratio >= 1) return "storm";
  if (ratio >= 0.8) return "change";
  return "fair";
}

/** One glyph per run status. `pr` swaps the plain check for a pull-request mark. */
export function StatusIcon({ status, pr = false, size = 16 }: { status: RunStatus; pr?: boolean; size?: number }) {
  const props = { size, weight: "bold" as const, className: "status-icon", "data-s": status, "aria-label": STATUS_LABEL[status] };
  switch (status) {
    case "queued":
      return <CircleDashed {...props} />;
    case "running":
    case "finalizing":
      return <CircleNotch {...props} className="status-icon spin" />;
    case "succeeded":
      return pr ? <GitPullRequest {...props} /> : <CheckCircle {...props} />;
    case "failed":
      return <XCircle {...props} />;
    default:
      return <Prohibit {...props} />;
  }
}

/** Spend against the monthly limit, with the 80% warning marked. */
export function SpendBar({ ratio, state, large = false }: { ratio: number; state: BudgetState; large?: boolean }) {
  return (
    <div className={`bar${large ? " bar-lg" : ""}`} data-state={state} role="presentation">
      <i style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      {large ? <span className="bar-mark" style={{ left: "80%" }} /> : null}
    </div>
  );
}
