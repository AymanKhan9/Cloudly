"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import { ArrowSquareOut, CheckCircle, Circle, GitPullRequest, Plus, Trash, TreeStructure, WarningCircle, X } from "@phosphor-icons/react";
import { waves } from "@repo/shared/plan";
import { api, ApiError, type PlanTask, type PlanView } from "@/lib/api";
import { HARNESSES, harnessById, usd, type Harness } from "@/lib/harness";
import { StatusIcon } from "@/components/status";

const STATUS_LABEL: Record<PlanTask["status"], string> = {
  pending: "Waiting",
  running: "Working",
  review: "Pull request open",
  needs_you: "Needs you",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

type Draft = { key: string; title: string; prompt: string; dependsOn: string[] };

function TaskStatus({ status }: { status: PlanTask["status"] }) {
  const icon =
    status === "done" ? <CheckCircle size={14} weight="bold" /> : status === "failed" || status === "needs_you" ? <WarningCircle size={14} weight="bold" /> : status === "running" ? <StatusIcon status="running" size={14} /> : status === "review" ? <GitPullRequest size={14} /> : <Circle size={14} />;
  return (
    <span className="task-status" data-status={status}>
      {icon}
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The tasks before the plan starts: edit, add, remove, then start. */
function TaskEditor({ view, onSaved }: { view: PlanView; onSaved: () => void }) {
  const [drafts, setDrafts] = useState<Draft[]>(() => view.tasks.map((t) => ({ key: t.key, title: t.title, prompt: t.prompt, dependsOn: t.dependsOn })));
  const [dirty, setDirty] = useState(false);
  const [agents, setAgents] = useState<Harness[]>(HARNESSES);
  const [harness, setHarness] = useState(view.plan.harness);
  const [maxParallel, setMaxParallel] = useState(view.plan.maxParallel);
  const [autoMerge, setAutoMerge] = useState(view.plan.autoMerge);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ harnesses: Harness[] }>("/harnesses").then((r) => r.harnesses.length && setAgents(r.harnesses)).catch(() => {});
  }, []);

  const change = (i: number, patch: Partial<Draft>) => {
    setDrafts((d) => d.map((t, j) => (j === i ? { ...t, ...patch } : t)));
    setDirty(true);
  };
  const remove = (i: number) => {
    const key = drafts[i]!.key;
    setDrafts((d) => d.filter((_, j) => j !== i).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((k) => k !== key) })));
    setDirty(true);
  };
  const add = () => {
    let n = drafts.length + 1;
    while (drafts.some((t) => t.key === `task-${n}`)) n++;
    setDrafts((d) => [...d, { key: `task-${n}`, title: "", prompt: "", dependsOn: [] }]);
    setDirty(true);
  };

  async function save(): Promise<boolean> {
    setError(null);
    try {
      await api(`/plans/${view.plan.id}/tasks`, { method: "PUT", body: JSON.stringify({ tasks: drafts }) });
      setDirty(false);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the tasks.");
      return false;
    }
  }

  async function start() {
    setBusy(true);
    try {
      if (dirty && !(await save())) return;
      await api(`/plans/${view.plan.id}/start`, { method: "POST", body: JSON.stringify({ harness, maxParallel, autoMerge }) });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the plan.");
    } finally {
      setBusy(false);
    }
  }

  const order = waves(drafts);
  return (
    <div className="plan-editor">
      {drafts.map((t, i) => (
        <div key={i} className="plan-task" data-editing>
          <div className="plan-task-head">
            <span className="mono dim">{t.key}</span>
            <input className="input" value={t.title} onChange={(e) => change(i, { title: e.target.value })} placeholder="What this task is" maxLength={120} aria-label={`Title of ${t.key}`} />
            <button type="button" className="icon-btn" onClick={() => remove(i)} aria-label={`Remove ${t.key}`} title="Remove">
              <Trash size={15} />
            </button>
          </div>
          <textarea className="textarea" rows={3} value={t.prompt} onChange={(e) => change(i, { prompt: e.target.value })} placeholder="What the agent should do, where, and how to check it" maxLength={6000} aria-label={`Instructions for ${t.key}`} />
          {drafts.length > 1 ? (
            <div className="plan-deps">
              <span className="dim">Waits for</span>
              {drafts
                .filter((o) => o.key !== t.key)
                .map((o) => (
                  <label key={o.key} className="dep-chip" data-on={t.dependsOn.includes(o.key) || undefined}>
                    <input
                      type="checkbox"
                      checked={t.dependsOn.includes(o.key)}
                      onChange={(e) => change(i, { dependsOn: e.target.checked ? [...t.dependsOn, o.key] : t.dependsOn.filter((k) => k !== o.key) })}
                    />
                    {o.title || o.key}
                  </label>
                ))}
            </div>
          ) : null}
        </div>
      ))}
      <button type="button" className="btn btn-ghost" onClick={add} disabled={drafts.length >= 12}>
        <Plus size={15} />
        Add a task
      </button>

      <div className="plan-start">
        <p className="hint">
          {order
            ? `${drafts.length} task${drafts.length === 1 ? "" : "s"} in ${order.length} step${order.length === 1 ? "" : "s"}. Tasks in the same step run side by side; the next step starts once their pull requests are merged.`
            : "The tasks wait for each other in a circle; untick one of the Waits for boxes."}
        </p>
        <div className="checks-grid">
          <div className="field">
            <label className="label" htmlFor="plan-agent">
              Agent for the tasks
            </label>
            <select id="plan-agent" className="select" value={harness} onChange={(e) => setHarness(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="plan-parallel">
              At the same time
            </label>
            <select id="plan-parallel" className="select" value={maxParallel} onChange={(e) => setMaxParallel(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "task" : "tasks"}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={autoMerge} onChange={(e) => setAutoMerge(e.target.checked)} />
          Merge each task&apos;s pull request when it&apos;s ready, so the next tasks build on it
        </label>
        {!autoMerge ? <p className="hint">Then the next step waits for you to merge each pull request yourself.</p> : null}
        {error ? (
          <p className="hint" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
        <div className="row-actions">
          {dirty ? (
            <button type="button" className="btn btn-secondary" onClick={() => save().then((ok) => ok && onSaved())} disabled={busy}>
              Save changes
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={start} disabled={busy || !order || drafts.some((t) => !t.title.trim() || !t.prompt.trim())}>
            Start the plan
          </button>
        </div>
      </div>
    </div>
  );
}

/** A started plan: its tasks by step, each with its session and pull request. */
function TaskBoard({ view, onChange }: { view: PlanView; onChange: () => void }) {
  const steps = useMemo(() => waves(view.tasks) ?? [view.tasks], [view.tasks]);
  const skip = async (t: PlanTask) => {
    if (!window.confirm(`Skip "${t.title}"? The tasks waiting for it go ahead without it.`)) return;
    await api(`/plans/${view.plan.id}/tasks/${t.id}/skip`, { method: "POST" }).catch(() => {});
    onChange();
  };
  return (
    <div className="plan-board">
      {steps.map((step, i) => (
        <section key={i} className="plan-step">
          <h3>
            Step {i + 1}
            {step.length > 1 ? <span className="dim"> · {step.length} side by side</span> : null}
          </h3>
          {step.map((t) => (
            <div key={t.id} className="plan-task" data-status={t.status}>
              <div className="plan-task-head">
                <TaskStatus status={t.status} />
                <strong>{t.title}</strong>
                <span className="spacer" />
                {t.session ? (
                  <Link href={`/app/s/${t.session.id}`} className="btn btn-secondary btn-sm">
                    Session
                  </Link>
                ) : null}
                {t.session?.prUrl ? (
                  <a href={t.session.prUrl} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                    <GitPullRequest size={13} />
                    PR
                    <ArrowSquareOut size={11} />
                  </a>
                ) : null}
                {view.plan.status === "running" && ["pending", "failed", "needs_you", "review"].includes(t.status) ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => skip(t)}>
                    Skip
                  </button>
                ) : null}
              </div>
              {t.note ? <p className="hint">{t.note}</p> : null}
              <details className="plan-prompt">
                <summary>Instructions</summary>
                <p>{t.prompt}</p>
              </details>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export default function PlanPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<PlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<PlanView>(`/plans/${id}`)
        .then((v) => {
          setView(v);
          setError(null);
        })
        .catch((e: Error) => setError(e instanceof ApiError && e.status === 404 ? "This plan doesn't exist, or it belongs to someone else." : e.message)),
    [id],
  );
  useEffect(() => {
    load();
  }, [load]);
  // Planning and running change on their own: check back every few seconds.
  const live = view?.plan.status === "planning" || view?.plan.status === "running";
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  if (error) return <div className="page"><p className="notice" data-tone="danger">{error}</p></div>;
  if (!view) return <div className="page"><div className="skeleton" style={{ width: "50%" }} aria-busy="true" /></div>;

  const { plan, tasks, planner } = view;
  const done = tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
  const [title, ...rest] = plan.goal.split("\n");

  async function replan() {
    await api(`/plans/${plan.id}/replan`, { method: "POST", body: JSON.stringify(goal ? { goal } : {}) }).catch((e: Error) => setError(e.message));
    setGoal(null);
    load();
  }
  async function cancel() {
    if (!window.confirm("Cancel the plan? Sessions already working carry on; tasks that haven't started won't.")) return;
    await api(`/plans/${plan.id}/cancel`, { method: "POST" }).catch(() => {});
    load();
  }

  return (
    <div className="page plan-page">
      <div className="page-head with-action">
        <div>
          <div className="plan-kicker">
            <TreeStructure size={14} />
            Plan · <span className="mono">{plan.repo}</span> · {harnessById(plan.harness).name}
          </div>
          <h1>{title}</h1>
          {rest.join("\n").trim() ? <p>{rest.join("\n").trim()}</p> : null}
        </div>
        {plan.status === "running" ? (
          <button type="button" className="btn btn-ghost" onClick={cancel}>
            <X size={15} />
            Cancel plan
          </button>
        ) : null}
      </div>

      <div className="plan-state" data-status={plan.status}>
        {plan.status === "planning" ? (
          <p className="shimmer-text">{harnessById(plan.planner).name} is reading the repo and breaking this into tasks…</p>
        ) : plan.status === "failed" ? (
          <p>
            <WarningCircle size={15} weight="bold" /> Planning didn&apos;t work: {plan.error}
          </p>
        ) : plan.status === "ready" ? (
          <p>Look over the tasks, change anything you like, then start the plan.</p>
        ) : plan.status === "running" ? (
          <p>
            {done} of {tasks.length} done. {tasks.some((t) => t.status === "failed" || t.status === "needs_you") ? "Some tasks need you; open their sessions." : "Tasks start as the ones they wait for are merged."}
          </p>
        ) : plan.status === "done" ? (
          <p>
            <CheckCircle size={15} weight="bold" /> All {tasks.length} tasks are done.
          </p>
        ) : (
          <p>Cancelled. {done} of {tasks.length} tasks were done.</p>
        )}
        {planner?.costUsd ? <span className="dim num">Planning cost {usd(planner.costUsd)}</span> : null}
      </div>

      {plan.summary ? (
        <div className="plan-summary">
          <Markdown>{plan.summary}</Markdown>
        </div>
      ) : null}

      {plan.status === "ready" ? <TaskEditor key={tasks.map((t) => t.id).join()} view={view} onSaved={load} /> : null}
      {plan.status === "running" || plan.status === "done" || plan.status === "cancelled" ? <TaskBoard view={view} onChange={load} /> : null}

      {plan.status === "ready" || plan.status === "failed" ? (
        <div className="plan-replan">
          {goal === null ? (
            <button type="button" className="btn btn-ghost" onClick={() => setGoal(plan.goal)}>
              Plan it again
            </button>
          ) : (
            <form
              className="field"
              onSubmit={(e) => {
                e.preventDefault();
                replan();
              }}
            >
              <label className="label" htmlFor="replan-goal">
                The goal
              </label>
              <textarea id="replan-goal" className="textarea" rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={8000} />
              <div className="row-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setGoal(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={!goal.trim()}>
                  Plan again
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
