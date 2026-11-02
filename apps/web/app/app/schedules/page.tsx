"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CalendarBlank, Play, Pause, Trash, PencilSimple, Plus, ArrowRight } from "@phosphor-icons/react";
import { describeSchedule } from "@repo/shared/schedule";
import { api, ApiError, type Repo, type Schedule } from "@/lib/api";
import { HARNESSES, harnessById, relativeTime, type Harness } from "@/lib/harness";

type Draft = Omit<Schedule, "id" | "nextRunAt" | "lastRunAt" | "lastNote" | "lastThreadId" | "lastThreadTitle" | "description" | "enabled">;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
const zones = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
})();
const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function when(iso: string, timeZone: string) {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  try {
    return d.toLocaleString(undefined, { ...opts, timeZone });
  } catch {
    return d.toLocaleString(undefined, opts);
  }
}

function ScheduleForm({ initial, repos, agents, onDone, onCancel }: { initial: (Draft & { id?: string }) | null; repos: Repo[]; agents: Harness[]; onDone: () => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft & { id?: string }>(
    initial ?? {
      name: "",
      repo: repos[0]?.fullName ?? "",
      baseBranch: repos[0]?.defaultBranch ?? "main",
      harness: "native-claude",
      prompt: "",
      kind: "turn",
      mode: "new",
      frequency: "weekdays",
      minuteOfDay: 9 * 60,
      weekday: 1,
      timeZone: browserZone(),
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((cur) => ({ ...cur, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { ...d, id: undefined, weekday: d.frequency === "weekly" ? d.weekday ?? 1 : null };
    try {
      await api(d.id ? `/schedules/${d.id}` : "/schedules", { method: d.id ? "PATCH" : "POST", body: JSON.stringify(body) });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the schedule.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={save} aria-label={d.id ? "Edit schedule" : "New schedule"}>
      <div className="panel-row field">
        <label className="label" htmlFor="sch-name">
          Name
        </label>
        <input id="sch-name" className="input" value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="Nightly dependency updates" maxLength={80} required />
      </div>
      <div className="panel-row field">
        <span className="label">What to do</span>
        <div className="segmented" role="group" aria-label="Kind">
          <button type="button" aria-pressed={d.kind === "turn"} onClick={() => set("kind", "turn")}>
            A task
          </button>
          <button type="button" aria-pressed={d.kind === "audit"} onClick={() => set("kind", "audit")}>
            An audit
          </button>
        </div>
        <textarea
          className="textarea"
          rows={3}
          value={d.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          maxLength={8000}
          required
          aria-label="Instructions"
          placeholder={d.kind === "audit" ? "Audit the repository: focus on security and error handling" : "Update outdated dependencies, run the tests, and fix what breaks."}
        />
        <p className="hint">{d.kind === "audit" ? "The agent reviews the whole repo and lists findings. Nothing changes until you pick some." : "Runs like a message you sent, and opens a pull request when it changes something."}</p>
      </div>
      <div className="panel-row checks-grid">
        <div className="field">
          <label className="label" htmlFor="sch-repo">
            Repository
          </label>
          <select
            id="sch-repo"
            className="select"
            value={d.repo}
            onChange={(e) => {
              const r = repos.find((x) => x.fullName === e.target.value);
              setD((cur) => ({ ...cur, repo: e.target.value, baseBranch: r?.defaultBranch ?? cur.baseBranch }));
            }}
          >
            {repos.map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {r.fullName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="sch-branch">
            Branch
          </label>
          <input id="sch-branch" className="input mono" value={d.baseBranch} onChange={(e) => set("baseBranch", e.target.value)} required />
        </div>
        <div className="field">
          <label className="label" htmlFor="sch-agent">
            Agent
          </label>
          <select id="sch-agent" className="select" value={d.harness} onChange={(e) => set("harness", e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="sch-mode">
            Sessions
          </label>
          <select id="sch-mode" className="select" value={d.mode} onChange={(e) => set("mode", e.target.value as Draft["mode"])}>
            <option value="new">New each time</option>
            <option value="continue">One session</option>
          </select>
        </div>
      </div>
      <div className="panel-row field">
        <span className="label">When</span>
        <div className="segmented" role="group" aria-label="How often">
          {(["hourly", "daily", "weekdays", "weekly"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={d.frequency === f} onClick={() => set("frequency", f)}>
              {f === "hourly" ? "Hourly" : f === "daily" ? "Daily" : f === "weekdays" ? "Weekdays" : "Weekly"}
            </button>
          ))}
        </div>
        <div className="when-row">
          {d.frequency === "weekly" ? (
            <select className="select" value={d.weekday ?? 1} onChange={(e) => set("weekday", Number(e.target.value))} aria-label="Day">
              {DAYS.map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </select>
          ) : null}
          {d.frequency === "hourly" ? (
            <label className="when-inline">
              at minute
              <select className="select" value={d.minuteOfDay % 60} onChange={(e) => set("minuteOfDay", Number(e.target.value))} aria-label="Minute past the hour">
                {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                  <option key={m} value={m}>
                    :{String(m).padStart(2, "0")}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <input
              type="time"
              className="input"
              value={clock(d.minuteOfDay)}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                if (Number.isFinite(h) && Number.isFinite(m)) set("minuteOfDay", h! * 60 + m!);
              }}
              aria-label="Time"
              required
            />
          )}
          <select className="select" value={d.timeZone} onChange={(e) => set("timeZone", e.target.value)} aria-label="Time zone">
            {(zones.length ? zones : [d.timeZone, "UTC"]).filter((z, i, a) => a.indexOf(z) === i).map((z) => (
              <option key={z} value={z}>
                {z.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <p className="hint">{describeSchedule({ frequency: d.frequency, minuteOfDay: d.minuteOfDay, weekday: d.weekday })}, {d.timeZone.replaceAll("_", " ")} time. Each run is a turn, and costs like one.</p>
      </div>
      <div className="panel-row form-foot">
        <span className="msg" role="status" data-tone={error ? "danger" : undefined}>
          {error ?? ""}
        </span>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !d.name.trim() || !d.prompt.trim() || !d.repo}>
          {d.id ? "Save" : "Create schedule"}
        </button>
      </div>
    </form>
  );
}

export default function SchedulesPage() {
  const [list, setList] = useState<Schedule[] | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [agents, setAgents] = useState<Harness[]>(HARNESSES);
  const [editing, setEditing] = useState<(Draft & { id?: string }) | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<{ schedules: Schedule[] }>("/schedules")
      .then((r) => setList(r.schedules))
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
    api<{ repos: Repo[] }>("/repos").then((r) => setRepos(r.repos)).catch(() => {});
    api<{ harnesses: Harness[] }>("/harnesses").then((r) => r.harnesses.length && setAgents(r.harnesses)).catch(() => {});
  }, []);

  const act = async (path: string, init: RequestInit) => {
    setError(null);
    try {
      await api(path, init);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    }
  };

  const sorted = useMemo(() => [...(list ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.nextRunAt.localeCompare(b.nextRunAt)), [list]);

  return (
    <div className="page">
      <div className="page-head with-action">
        <div>
          <h1>Schedules</h1>
          <p>Tasks that run on their own: a nightly dependency update, a weekly audit, a morning triage of new issues.</p>
        </div>
        {editing ? null : (
          <button type="button" className="btn btn-primary" onClick={() => setEditing("new")} disabled={repos.length === 0}>
            <Plus size={15} />
            New schedule
          </button>
        )}
      </div>

      {error ? (
        <p className="notice" data-tone="danger" role="alert">
          {error}
        </p>
      ) : null}

      {editing ? (
        <ScheduleForm
          initial={editing === "new" ? null : editing}
          repos={repos}
          agents={agents}
          onDone={() => {
            setEditing(null);
            load();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {list === null ? (
        <div className="skeleton" style={{ width: "50%" }} aria-busy="true" />
      ) : sorted.length === 0 && !editing ? (
        <div className="empty-schedules">
          <CalendarBlank size={28} />
          <p>No schedules yet.</p>
        </div>
      ) : (
        <ul className="schedule-list">
          {sorted.map((s) => (
            <li key={s.id} className="schedule" data-paused={!s.enabled || undefined}>
              <div className="schedule-main">
                <div className="schedule-title">
                  <strong>{s.name}</strong>
                  {s.kind === "audit" ? <span className="sev">Audit</span> : null}
                  {!s.enabled ? <span className="sev">Paused</span> : null}
                </div>
                <div className="schedule-meta">
                  <span>
                    {s.description}, {s.timeZone.replaceAll("_", " ")}
                  </span>
                  <span className="mono">{s.repo}</span>
                  <span>{harnessById(s.harness).name}</span>
                  <span>{s.mode === "continue" ? "One session" : "New session each time"}</span>
                </div>
                <p className="schedule-prompt">{s.prompt}</p>
                <div className="schedule-meta">
                  {s.enabled ? <span>Next: {when(s.nextRunAt, s.timeZone)}</span> : null}
                  {s.lastRunAt ? (
                    <span>
                      Last {relativeTime(s.lastRunAt)}: {s.lastNote ?? ""}
                    </span>
                  ) : null}
                  {s.lastThreadId ? (
                    <Link href={`/app/s/${s.lastThreadId}`} className="schedule-link">
                      {s.lastThreadTitle ?? "Its session"}
                      <ArrowRight size={12} />
                    </Link>
                  ) : null}
                </div>
              </div>
              <div className="schedule-actions">
                <button type="button" className="btn btn-secondary btn-sm" disabled={!s.enabled} onClick={() => act(`/schedules/${s.id}/run`, { method: "POST" })} title="Run it within the next half minute">
                  <Play size={13} />
                  Run now
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => act(`/schedules/${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !s.enabled }) })}>
                  {s.enabled ? <Pause size={13} /> : <Play size={13} />}
                  {s.enabled ? "Pause" : "Resume"}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ ...s })} aria-label={`Edit ${s.name}`}>
                  <PencilSimple size={13} />
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => window.confirm(`Delete "${s.name}"? Its sessions stay.`) && act(`/schedules/${s.id}`, { method: "DELETE" })}
                  aria-label={`Delete ${s.name}`}
                >
                  <Trash size={13} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
