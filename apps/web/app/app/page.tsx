"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError, type Repo } from "@/lib/api";
import { HARNESSES, type HarnessId } from "@/lib/harness";
import { useApp } from "@/components/app-context";
import { Oktas } from "@/components/notation";
import { ArrowIcon } from "@/components/icons";

export default function NewSessionPage() {
  const router = useRouter();
  const { budget } = useApp();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [harness, setHarness] = useState<HarnessId>("native-claude");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ repos: Repo[] }>("/repos")
      .then(({ repos }) => {
        setRepos(repos);
        if (repos[0]) {
          setRepo(repos[0].fullName);
          setBranch(repos[0].defaultBranch);
        }
      })
      .catch((e: Error) => setRepoError(e.message));
  }, []);

  const stopped = budget?.state === "storm";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>("/threads", {
        method: "POST",
        body: JSON.stringify({ repo, baseBranch: branch, prompt, harness }),
      });
      router.push(`/app/s/${id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the session.");
      setSubmitting(false);
    }
  }

  return (
    <div className="chat">
      <div className="page-head">
        <div>
          <h1 className="display">New session</h1>
          <p>Describe the first task. You can keep talking to the agent afterward, and everything lands on one branch and one pull request.</p>
        </div>
      </div>

      <form className="sheet" onSubmit={submit}>
        <div className="sheet-head">
          <span className="caps" style={{ color: "var(--slate)" }}>
            Observation sheet
          </span>
          <Oktas eighths={0} title="Not started" />
        </div>

        <div className="sheet-grid">
          <div className="field">
            <label className="field-label" htmlFor="repo">
              Repository
            </label>
            {repoError ? (
              <div className="error-box">{repoError}</div>
            ) : (
              <select
                id="repo"
                value={repo}
                disabled={!repos}
                onChange={(e) => {
                  setRepo(e.target.value);
                  const r = repos?.find((x) => x.fullName === e.target.value);
                  if (r) setBranch(r.defaultBranch);
                }}
              >
                {!repos ? <option>Loading repositories…</option> : null}
                {repos?.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            )}
            {repos && repos.length === 0 ? (
              <p className="field-hint">The GitHub App can't see any repositories yet. Add one to its installation on GitHub.</p>
            ) : null}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="branch">
              Base branch
            </label>
            <input id="branch" value={branch} onChange={(e) => setBranch(e.target.value)} required className="mono" />
            <p className="field-hint">The pull request targets this branch.</p>
          </div>
          <div className="field">
            <span className="field-label">Cost reporting</span>
            <div className="field-value">
              {HARNESSES.find((h) => h.id === harness)?.cost === "exact" ? "Exact, reported by the agent" : "Estimated from token counts"}
            </div>
          </div>
        </div>

        <fieldset className="field field-wide" style={{ border: 0, margin: 0, borderBottom: "1px solid var(--hair-ink)" }}>
          <legend className="field-label" style={{ float: "left", width: "100%" }}>
            Agent
          </legend>
          <div className="genus-pick">
            {HARNESSES.map((h) => (
              <label key={h.id}>
                <input type="radio" name="harness" value={h.id} checked={harness === h.id} onChange={() => setHarness(h.id)} />
                <span className="latin">{h.genus}</span>
                <span className="name">{h.name}</span>
                <span className="cost">{h.cost === "exact" ? "exact cost" : "estimated cost"}</span>
              </label>
            ))}
          </div>
          <p className="field-hint">The agent needs its API key in the server's .env. A session keeps one agent.</p>
        </fieldset>

        <div className="field field-wide">
          <label className="field-label" htmlFor="prompt">
            First task
          </label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Add per-key rate limiting to POST /invoices, 60 requests a minute, and cover the 429 path with a test."
            required
            maxLength={8000}
          />
        </div>

        <div className="sheet-foot">
          <span style={{ fontSize: 14, color: stopped ? "var(--storm)" : "var(--slate)" }} role={stopped || error ? "alert" : undefined}>
            {stopped
              ? "Your monthly spend limit is reached. Raise it in Settings to start sessions."
              : error ?? "Turns run one at a time; follow-ups wait for the current turn."}
          </span>
          <button type="submit" className="btn btn-signal" disabled={submitting || stopped || !repo || !prompt.trim()}>
            {submitting ? "Starting…" : "Start session"}
            <ArrowIcon />
          </button>
        </div>
      </form>
    </div>
  );
}
