"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TreeStructure, Plus } from "@phosphor-icons/react";
import { api, type PlanSummary } from "@/lib/api";
import { relativeTime } from "@/lib/harness";

const LABEL: Record<PlanSummary["status"], string> = {
  planning: "Planning",
  ready: "Ready to start",
  running: "Running",
  done: "Done",
  failed: "Planning failed",
  cancelled: "Cancelled",
};

export default function PlansPage() {
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  useEffect(() => {
    api<{ plans: PlanSummary[] }>("/plans").then((r) => setPlans(r.plans)).catch(() => setPlans([]));
  }, []);
  return (
    <div className="page">
      <div className="page-head with-action">
        <div>
          <h1>Plans</h1>
          <p>Big tasks broken into sessions that run side by side, each with its own pull request.</p>
        </div>
        <Link href="/app?mode=plan" className="btn btn-primary">
          <Plus size={15} />
          New plan
        </Link>
      </div>
      {plans === null ? (
        <div className="skeleton" style={{ width: "50%" }} aria-busy="true" />
      ) : plans.length === 0 ? (
        <div className="empty-schedules">
          <TreeStructure size={28} />
          <p>No plans yet. Choose Plan on the new-session page and describe something big.</p>
        </div>
      ) : (
        <ul className="schedule-list">
          {plans.map((p) => (
            <li key={p.id} className="schedule">
              <div className="schedule-main">
                <div className="schedule-title">
                  <Link href={`/app/plans/${p.id}`}>
                    <strong>{p.goal.split("\n")[0]}</strong>
                  </Link>
                  <span className="sev">{LABEL[p.status]}</span>
                </div>
                <div className="schedule-meta">
                  <span className="mono">{p.repo}</span>
                  {p.total ? (
                    <span>
                      {p.done} of {p.total} tasks done
                    </span>
                  ) : null}
                  {p.needsYou ? <span style={{ color: "var(--warn)" }}>{p.needsYou} need you</span> : null}
                  <span>{relativeTime(p.createdAt)}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
