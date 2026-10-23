"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, GitBranch, GithubLogo, Lightning, Monitor, Scales } from "@phosphor-icons/react";
import { api, ApiError, type Capabilities, type Repo } from "@/lib/api";
import { HARNESSES, type HarnessId } from "@/lib/harness";
import { useApp } from "@/components/app-context";
import { Picker } from "@/components/picker";
import { AgentLogo, providerOf } from "@/components/agent-logo";
import { EffortControl } from "@/components/effort-control";

const STARTERS = [
  "Explain how this repo is structured and where to start reading",
  "Find and fix the flakiest test, and explain what made it flaky",
  "Add input validation to the API routes that are missing it",
];

export default function NewSessionPage() {
  const router = useRouter();
  const { budget } = useApp();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [harness, setHarness] = useState<HarnessId>("native-claude");
  const [effort, setEffort] = useState<string | null>(null);
  // Compare mode: the same task to several agents at once (an arena).
  const [compare, setCompare] = useState(false);
  const [rivals, setRivals] = useState<HarnessId[]>(["native-claude", "native-codex"]);
  const [desktop, setDesktop] = useState(false);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

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
    api<Capabilities>("/capabilities").then(setCaps).catch(() => {});
  }, []);

  const stopped = budget?.state === "storm";
  const ready = !submitting && !stopped && Boolean(repo) && Boolean(branch.trim()) && Boolean(prompt.trim()) && (!compare || rivals.length >= 2);
  const h = HARNESSES.find((x) => x.id === harness)!;

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    try {
      if (compare) {
        const { id } = await api<{ id: string }>("/arenas", {
          method: "POST",
          body: JSON.stringify({ repo, baseBranch: branch, prompt, harnesses: rivals, desktop }),
        });
        router.push(`/app/arena/${id}`);
        return;
      }
      const { id } = await api<{ id: string }>("/threads", {
        method: "POST",
        body: JSON.stringify({ repo, baseBranch: branch, prompt, harness, effort, desktop }),
      });
      router.push(`/app/s/${id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the session.");
      setSubmitting(false);
    }
  }

  const note = stopped
    ? { tone: "danger", text: "Your monthly spend limit is reached. Raise it in Settings to start sessions." }
    : error
      ? { tone: "danger", text: error }
      : repoError
        ? { tone: "danger", text: `Couldn't load repositories: ${repoError}` }
        : repos && repos.length === 0
          ? { tone: "danger", text: "The GitHub App can't see any repositories yet. Add one to its installation on GitHub." }
          : null;

  return (
    <div className="start">
      <h1>What should the agent work on?</h1>
      <p>Everything in a session lands on one branch and one pull request. You can keep talking to the agent afterward.</p>

      <form onSubmit={submit}>
        <div className="composer">
          <label htmlFor="prompt" className="visually-hidden">
            First task
          </label>
          <textarea
            id="prompt"
            ref={input}
            autoFocus
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Add per-key rate limiting to POST /invoices, 60 requests a minute, and cover the 429 path with a test."
            maxLength={8000}
            style={{ minHeight: 112 }}
          />
          <div className="composer-bar">
            <Picker
              label="Repository"
              icon={<GithubLogo size={15} />}
              value={repo}
              placeholder={repos ? "No repositories" : "Loading repositories"}
              disabled={!repos || repos.length === 0}
              searchable
              options={(repos ?? []).map((r) => ({ value: r.fullName, label: r.fullName, hint: r.private ? "Private" : undefined }))}
              onChange={(v) => {
                setRepo(v);
                const r = repos?.find((x) => x.fullName === v);
                if (r) setBranch(r.defaultBranch);
              }}
            />
            <label className="pill" title="Base branch: the pull request targets it">
              <GitBranch size={15} />
              <span className="visually-hidden">Base branch</span>
              <input className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} required spellCheck={false} />
            </label>
            {compare ? (
              <span className="rivals" role="group" aria-label="Agents to compare">
                {HARNESSES.map((x) => {
                  const on = rivals.includes(x.id);
                  return (
                    <button
                      key={x.id}
                      type="button"
                      className="pill"
                      aria-pressed={on}
                      onClick={() => setRivals((r) => (on ? r.filter((id) => id !== x.id) : [...r, x.id]))}
                    >
                      {on ? <Check size={13} weight="bold" /> : <AgentLogo harness={x.id} size={14} />}
                      <span className="pill-text">{x.name}</span>
                    </button>
                  );
                })}
              </span>
            ) : (
            <Picker
              label="Agent"
              icon={<AgentLogo harness={harness} size={15} />}
              value={harness}
              options={HARNESSES.map((x) => ({
                value: x.id,
                label: x.name,
                sub: (
                  <>
                    <AgentLogo harness={x.id} size={13} />
                    {providerOf(x.id)}
                    <span className="dim">{x.cost === "exact" ? "Exact cost" : "Estimated cost"}</span>
                  </>
                ),
              }))}
              onChange={(v) => {
                setHarness(v as HarnessId);
                setEffort(null); // levels differ per agent
              }}
            />
            )}
            {compare ? null : <EffortControl harness={harness} value={effort} onChange={setEffort} />}
            <button type="button" className="pill" aria-pressed={compare} onClick={() => setCompare((c) => !c)} title="Give the same task to several agents and pick the best result">
              <Scales size={14} />
              <span className="pill-text">Compare</span>
            </button>
            {caps?.desktop ? (
              <button type="button" className="pill" aria-pressed={desktop} onClick={() => setDesktop((d) => !d)} title="Give the agent a virtual desktop and browser">
                <Monitor size={14} />
                <span className="pill-text">Desktop</span>
              </button>
            ) : null}
            <span className="spacer" />
            <button type="submit" className="send" disabled={!ready} aria-label="Start session">
              <ArrowUp size={18} weight="bold" />
            </button>
          </div>
        </div>

        <div className="composer-note" data-tone={note?.tone} role={note ? "alert" : undefined}>
          <span>
            {note?.text ??
              (compare
                ? rivals.length < 2
                  ? "Pick at least two agents to compare."
                  : `Each agent works on its own branch. Nothing opens a pull request until you pick a result. Each one's turn costs as usual.`
                : `${h.name} ${h.cost === "exact" ? "reports exact cost" : "cost is estimated from tokens"}. It needs its key or plan sign-in in Settings.`)}
          </span>
          <span>
            <kbd>Enter</kbd> to start, <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
          </span>
        </div>
      </form>

      {prompt.trim() ? null : (
        <div className="starters">
          <h2>Or start from</h2>
          {STARTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setPrompt(s);
                input.current?.focus();
              }}
            >
              <Lightning size={15} />
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
