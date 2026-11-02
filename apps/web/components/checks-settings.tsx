"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type Repo, type RepoCheckSettings } from "@/lib/api";
import { relativeTime, HARNESSES, type Harness } from "@/lib/harness";

type Mode = RepoCheckSettings["settings"]["checks"];

/**
 * A repo's checks: what Cloudly runs after every turn that changes code, and how
 * many times the agent may try to fix them when they fail.
 */
export function ChecksSettings() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repo, setRepo] = useState("");
  const [view, setView] = useState<RepoCheckSettings | null>(null);
  const [mode, setMode] = useState<Mode>("auto");
  const [command, setCommand] = useState("");
  const [fixes, setFixes] = useState(2);
  const [minutes, setMinutes] = useState(10);
  const [reviewer, setReviewer] = useState("");
  const [rounds, setRounds] = useState(2);
  const [postToGitHub, setPostToGitHub] = useState(true);
  const [agents, setAgents] = useState<Harness[]>(HARNESSES);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ repos: Repo[] }>("/repos")
      .then((r) => {
        setRepos(r.repos);
        setRepo(r.repos[0]?.fullName ?? "");
      })
      .catch(() => setRepos([]));
    api<{ harnesses: Harness[] }>("/harnesses")
      .then((r) => r.harnesses.length && setAgents(r.harnesses))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!repo) return;
    setView(null);
    setMessage(null);
    api<RepoCheckSettings>(`/settings/repos/${repo}`)
      .then((v) => {
        setView(v);
        setMode(v.settings.checks);
        setCommand(v.settings.checkCommand ?? "");
        setFixes(v.settings.fixAttempts);
        setMinutes(Math.round(v.settings.checkTimeoutSec / 60));
        setReviewer(v.settings.reviewer ?? "");
        setRounds(v.settings.reviewRounds);
        setPostToGitHub(v.settings.reviewPostToGitHub);
      })
      .catch((e: Error) => setMessage({ ok: false, text: e.message }));
  }, [repo]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api(`/settings/repos/${repo}`, {
        method: "PUT",
        body: JSON.stringify({
          checks: mode, checkCommand: mode === "custom" ? command : command || null, fixAttempts: fixes, checkTimeoutSec: minutes * 60,
          reviewer: reviewer || null, reviewRounds: rounds, reviewPostToGitHub: postToGitHub,
        }),
      });
      setMessage({ ok: true, text: "Saved. Applies from the next turn." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Couldn't save." });
    } finally {
      setBusy(false);
    }
  }

  const last = view?.last;

  return (
    <section className="set-sec" aria-labelledby="checks-h" id="checks">
      <header>
        <h2 id="checks-h">Checks and review</h2>
        <p>
          After every turn that changes code, Cloudly runs the repo&apos;s checks (its tests, usually) before committing. When they fail, the agent gets another turn to fix
          them. Once they pass, a second agent can review the change: blocking findings go back to the first one, and the rest wait for you in the session&apos;s Changes tab.
        </p>
      </header>
      <div className="set-body">
        <form className="panel" onSubmit={save}>
          <div className="panel-row field">
            <label className="label" htmlFor="checks-repo">
              Repository
            </label>
            <select id="checks-repo" className="select" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={!repos?.length} style={{ maxWidth: 360 }}>
              {(repos ?? []).map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                </option>
              ))}
            </select>
            {repos && repos.length === 0 ? <p className="hint">No repositories yet.</p> : null}
          </div>
          {view ? (
            <>
              <div className="panel-row field">
                <span className="label">What to run</span>
                <div className="segmented" role="group" aria-label="Checks">
                  {(
                    [
                      ["auto", "Detect"],
                      ["custom", "Command"],
                      ["off", "Off"],
                    ] as const
                  ).map(([value, label]) => (
                    <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>
                      {label}
                    </button>
                  ))}
                </div>
                {mode === "auto" ? (
                  <p className="hint">
                    From the repo&apos;s own files: its <code className="mono">package.json</code> test script, pytest, <code className="mono">go test</code>,{" "}
                    <code className="mono">cargo test</code> or <code className="mono">make test</code>.
                    {last?.checkCommand ? (
                      <>
                        {" "}
                        Last run {relativeTime(last.createdAt)}: <code className="mono">{last.checkCommand.split("\n").at(-1)}</code>
                      </>
                    ) : null}
                  </p>
                ) : mode === "custom" ? (
                  <>
                    <textarea
                      className="textarea mono code-area"
                      rows={3}
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      placeholder={"bun install && bun run typecheck && bun test"}
                      spellCheck={false}
                      aria-label="Check command"
                    />
                    <p className="hint">Runs with bash in the repo&apos;s root, in a sandbox like the agent&apos;s: the same network rules and secrets, no model keys.</p>
                  </>
                ) : (
                  <p className="hint">Nothing runs after a turn, and the agent isn&apos;t asked to fix anything.</p>
                )}
              </div>
              {mode !== "off" ? (
                <div className="panel-row checks-grid">
                  <div className="field">
                    <label className="label" htmlFor="checks-fixes">
                      Fix attempts
                    </label>
                    <select id="checks-fixes" className="select" value={fixes} onChange={(e) => setFixes(Number(e.target.value))}>
                      {[0, 1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n === 0 ? "None: just report" : `${n} in a row`}
                        </option>
                      ))}
                    </select>
                    <p className="hint">Then the session waits for you.</p>
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="checks-timeout">
                      Time limit
                    </label>
                    <select id="checks-timeout" className="select" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                      {[2, 5, 10, 20, 30, 60].map((n) => (
                        <option key={n} value={n}>
                          {n} minutes
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}
              <div className="panel-row field">
                <label className="label" htmlFor="review-agent">
                  Reviewer
                </label>
                <select id="review-agent" className="select" value={reviewer} onChange={(e) => setReviewer(e.target.value)} style={{ maxWidth: 360 }}>
                  <option value="">None</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <p className="hint">
                  {reviewer
                    ? "Reviews what the session changed, not the whole repo. A different agent from the one doing the work catches more."
                    : "No automatic review. You can still start one from a session's Changes tab."}
                </p>
              </div>
              {reviewer ? (
                <div className="panel-row checks-grid">
                  <div className="field">
                    <label className="label" htmlFor="review-rounds">
                      Fix rounds
                    </label>
                    <select id="review-rounds" className="select" value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
                      {[0, 1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n === 0 ? "None: just report" : `${n} round${n === 1 ? "" : "s"}`}
                        </option>
                      ))}
                    </select>
                    <p className="hint">For blocking findings. Then the session waits for you.</p>
                  </div>
                  <div className="field">
                    <span className="label">Pull request</span>
                    <label className="check-row">
                      <input type="checkbox" checked={postToGitHub} onChange={(e) => setPostToGitHub(e.target.checked)} />
                      Post the findings as a review, with comments on the lines
                    </label>
                  </div>
                </div>
              ) : null}
              <div className="panel-row form-foot">
                <span className="msg" role="status" data-tone={message && !message.ok ? "danger" : undefined}>
                  {message?.text ?? "Each fix attempt and each review is a turn, and costs like one."}
                </span>
                <button type="submit" className="btn btn-primary" disabled={busy || !repo || (mode === "custom" && !command.trim())}>
                  Save
                </button>
              </div>
            </>
          ) : repo ? (
            <div className="panel-row" aria-busy="true">
              <div className="skeleton" style={{ width: "40%" }} />
            </div>
          ) : null}
        </form>
      </div>
    </section>
  );
}
