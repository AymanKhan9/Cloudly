"use client";

import { useEffect, useState } from "react";
import { Trophy } from "@phosphor-icons/react";
import { api, type Repo } from "@/lib/api";
import { harnessById, usd } from "@/lib/harness";
import { AgentLogo } from "@/components/agent-logo";

interface AgentScore {
  harness: string;
  sessions: number;
  prs: number;
  merged: number;
  notMerged: number;
  open: number;
  mergeRate: number | null;
  costUsd: number;
  costPerMerged: number | null;
  checksFirstTry: number | null;
  fixTurnsPerPr: number | null;
  blockingPerReview: number | null;
  hoursToMerge: number | null;
  rewinds: number;
}

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const one = (v: number | null) => (v === null ? "–" : v.toFixed(1));
const hours = (v: number | null) => (v === null ? "–" : v < 1 ? `${Math.round(v * 60)} min` : v < 48 ? `${v.toFixed(1)} h` : `${(v / 24).toFixed(1)} d`);

/** How each agent has done, per repo or across all of them, and who Auto picks. */
export default function ScorecardPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repo, setRepo] = useState("");
  const [days, setDays] = useState(90);
  const [data, setData] = useState<{ agents: AgentScore[]; pick: { harness: string; reason: string } | null; best?: { harness: string; reason: string } | null } | null>(null);

  useEffect(() => {
    api<{ repos: Repo[] }>("/repos").then((r) => setRepos(r.repos)).catch(() => {});
  }, []);
  useEffect(() => {
    setData(null);
    api<{ agents: AgentScore[]; pick: { harness: string; reason: string } | null }>(`/scorecard?days=${days}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`)
      .then(setData)
      .catch(() => setData({ agents: [], pick: null }));
  }, [repo, days]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Agent scorecard</h1>
        <p>How each agent&apos;s sessions have gone: pull requests merged, what a merge cost, the checks on the first try, the fixes it needed and what the reviewer found.</p>
      </div>
      <div className="score-filters">
        <select className="select" aria-label="Repository" value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">All repositories</option>
          {repos.map((r) => (
            <option key={r.fullName} value={r.fullName}>
              {r.fullName}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Time" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[30, 90, 180, 365].map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </select>
      </div>

      {repo && data ? (
        <div className="score-pick" role="status">
          <Trophy size={18} />
          {data.pick ? (
            <span>
              <strong>Auto picks {harnessById(data.pick.harness).name} here:</strong> {data.pick.reason}. Choose <em>Auto</em> as the agent for a new session to use it.
            </span>
          ) : data.best ? (
            <span>
              <strong>{harnessById(data.best.harness).name} has the best record here</strong> ({data.best.reason}), but it isn&apos;t set up to run right now, so Auto uses the first ready
              agent. Set it up under Settings.
            </span>
          ) : (
            <span>Auto needs at least 3 merged or closed pull requests from an agent on this repo before it picks one; until then it uses the first ready agent.</span>
          )}
        </div>
      ) : null}

      {data === null ? (
        <div className="skeleton" style={{ height: 160 }} aria-busy="true" />
      ) : data.agents.length === 0 ? (
        <p className="hint">No sessions{repo ? ` on ${repo}` : ""} in this time yet.</p>
      ) : (
        <div className="md-table score-table">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th align="right">Sessions</th>
                <th align="right">Pull requests</th>
                <th>Merged</th>
                <th align="right" title="Its own turns, not the reviewer's">Cost per merge</th>
                <th align="right" title="Turns whose checks passed the first time">Checks first try</th>
                <th align="right" title="Fix turns (failing checks, CI, the reviewer's findings) per pull request">Fixes per PR</th>
                <th align="right" title="Blocking findings per review">Blocking per review</th>
                <th align="right" title="Median, from the session's start">Time to merge</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => (
                <tr key={a.harness} data-pick={data.pick?.harness === a.harness || undefined}>
                  <td>
                    <span className="score-agent">
                      <AgentLogo harness={a.harness} size={15} />
                      {harnessById(a.harness).name}
                    </span>
                  </td>
                  <td align="right">{a.sessions}</td>
                  <td align="right">{a.prs}</td>
                  <td>
                    <span className="score-rate" title={`${a.merged} merged, ${a.notMerged} not merged, ${a.open} still open`}>
                      <span className="score-track" aria-hidden>
                        <span className="score-fill" style={{ width: `${(a.mergeRate ?? 0) * 100}%` }} />
                      </span>
                      <span className="num">{pct(a.mergeRate)}</span>
                      <span className="dim num">
                        {a.merged}/{a.merged + a.notMerged}
                      </span>
                    </span>
                  </td>
                  <td align="right">{a.costPerMerged === null ? "–" : usd(a.costPerMerged)}</td>
                  <td align="right">{pct(a.checksFirstTry)}</td>
                  <td align="right">{one(a.fixTurnsPerPr)}</td>
                  <td align="right">{one(a.blockingPerReview)}</td>
                  <td align="right">{hours(a.hoursToMerge)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        Merged counts pull requests merged by anyone; one closed without merging, or open for two weeks, counts as not merged. For merges you make on GitHub to count right away,
        turn on the <span className="mono">Pull request</span> event in your GitHub App&apos;s webhook settings; otherwise Cloudly checks every few hours.
      </p>
    </div>
  );
}
