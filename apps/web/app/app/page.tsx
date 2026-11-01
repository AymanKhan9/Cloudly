"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, CurrencyDollar, GitBranch, GithubLogo, Lightning, Monitor, Scales, UsersThree, Crown, Repeat } from "@phosphor-icons/react";
import { api, ApiError, type AgentReadiness, type Capabilities, type Repo } from "@/lib/api";
import { agentsAskedFor } from "@repo/shared/agent-names";
import { isProviderHarness } from "@repo/shared/providers";
import { costLabel } from "@/lib/harness";
import { useApp } from "@/components/app-context";
import { Picker } from "@/components/picker";
import { AgentLogo, providerOf } from "@/components/agent-logo";
import { EffortControl } from "@/components/effort-control";

const STARTERS = [
  "Explain how this repo is structured and where to start reading",
  "Find and fix the flakiest test, and explain what made it flaky",
  "Add input validation to the API routes that are missing it",
];

const COUNCIL_STARTERS = [
  "What's the state of the software job market right now, and where is it heading this year?",
  "Which managed Postgres providers are the best fit for a small team today, and why?",
  "What changed in AI coding agents in the last three months that matters to a small team?",
];

type Mode = "session" | "compare" | "council";

interface Estimate {
  turns: number;
  usd: number | null;
  onPlan: string[];
}

export default function NewSessionPage() {
  const router = useRouter();
  const { budget, harnesses } = useApp();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [harness, setHarness] = useState<string>("native-claude");
  const [effort, setEffort] = useState<string | null>(null);
  // Compare: the same task to several agents at once (an arena). Council: several
  // agents answer one question together, in rounds, and a chair writes the report.
  const [mode, setMode] = useState<Mode>("session");
  const compare = mode === "compare";
  const council = mode === "council";
  const [rivals, setRivals] = useState<string[]>(["native-claude", "native-codex"]);
  const [chair, setChair] = useState<string>("native-claude");
  const [rounds, setRounds] = useState(3);
  const [onRepo, setOnRepo] = useState(false);
  const [cap, setCap] = useState("5");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // A message that names agents ("use claude, chatgpt and pi for this") makes a
  // council of them; this is what it asked for, and which of them can't run.
  const [asked, setAsked] = useState<{ ids: string[]; checked: AgentReadiness[] } | null>(null);
  const applied = useRef("");

  useEffect(() => {
    // "New session on <repo>" from a session's menu comes with ?repo= and ?branch=.
    const asked = new URLSearchParams(window.location.search);
    api<{ repos: Repo[] }>("/repos")
      .then(({ repos }) => {
        setRepos(repos);
        const pick = repos.find((r) => r.fullName === asked.get("repo")) ?? repos[0];
        if (pick) {
          setRepo(pick.fullName);
          setBranch(pick.fullName === asked.get("repo") ? asked.get("branch") || pick.defaultBranch : pick.defaultBranch);
        }
      })
      .catch((e: Error) => setRepoError(e.message));
    api<Capabilities>("/capabilities").then(setCaps).catch(() => {});
  }, []);

  useEffect(() => {
    const ids = agentsAskedFor(prompt, harnesses.filter((h) => isProviderHarness(h.id)).map((h) => ({ id: h.id, name: h.name })));
    const key = ids.join(",");
    if (key === applied.current) return;
    if (ids.length < 2) {
      applied.current = "";
      setAsked(null);
      return;
    }
    // After a pause in typing: check who can run, then set the council up with them.
    const timer = window.setTimeout(async () => {
      const checked = (await api<{ checked?: AgentReadiness[] }>(`/harnesses?check=${encodeURIComponent(key)}`).catch(() => null))?.checked;
      if (!checked) return;
      applied.current = key;
      const can = checked.filter((r) => r.ready).map((r) => r.id);
      setAsked({ ids, checked });
      // An arena takes up to three; more than that is a council.
      setMode((m) => (m === "compare" && can.length <= 3 ? m : "council"));
      setRivals(can);
      setChair((c) => (can.includes(c) ? c : can.includes("native-claude") ? "native-claude" : can[0] ?? c));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [prompt, harnesses]);

  useEffect(() => {
    if (!council || rivals.length < 2) return setEstimate(null);
    const q = new URLSearchParams({ members: rivals.join(","), chair, rounds: String(rounds) });
    api<Estimate>(`/councils/estimate?${q}`).then(setEstimate).catch(() => setEstimate(null));
  }, [council, rivals, chair, rounds]);

  const stopped = budget?.state === "storm";
  const needsRepo = !council || onRepo;
  const ready =
    !submitting && !stopped && Boolean(prompt.trim()) && (!needsRepo || (Boolean(repo) && Boolean(branch.trim()))) && (mode === "session" || rivals.length >= 2);
  const h = harnesses.find((x) => x.id === harness) ?? harnesses[0]!;

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    try {
      if (council) {
        const { id } = await api<{ id: string }>("/councils", {
          method: "POST",
          body: JSON.stringify({
            question: prompt,
            members: rivals,
            chair,
            rounds,
            repo: onRepo ? repo : null,
            baseBranch: onRepo ? branch : null,
            budgetUsd: Number(cap) > 0 ? Number(cap) : null,
          }),
        });
        router.push(`/app/council/${id}`);
        return;
      }
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
      : repoError && needsRepo
        ? { tone: "danger", text: `Couldn't load repositories: ${repoError}` }
        : needsRepo && repos && repos.length === 0
          ? { tone: "danger", text: "The GitHub App can't see any repositories yet. Add one to its installation on GitHub." }
          : null;

  return (
    <div className="start">
      <h1>{council ? "What should the council answer?" : "What should the agent work on?"}</h1>
      <p>
        {council
          ? "Each agent researches on its own, then they review each other's findings and give final positions. The chair writes the report."
          : "Everything in a session lands on one branch and one pull request. You can keep talking to the agent afterward."}
      </p>

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
            placeholder={
              council
                ? "What's the state of the job market for software engineers right now? Where is hiring growing, where is it shrinking, and what's driving it?"
                : "Add per-key rate limiting to POST /invoices, 60 requests a minute, and cover the 429 path with a test."
            }
            maxLength={8000}
            style={{ minHeight: 112 }}
          />
          <div className="composer-bar">
            {council ? (
              <button type="button" className="pill" aria-pressed={onRepo} onClick={() => setOnRepo((r) => !r)} title="Without a repo, the council researches on the open web. With one, it reads the repo and changes nothing.">
                <GithubLogo size={14} />
                <span className="pill-text">{onRepo ? "On a repo" : "Web research"}</span>
              </button>
            ) : null}
            {needsRepo ? (
            <>
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
            </>
            ) : null}
            {mode !== "session" ? (
              <span className="rivals" role="group" aria-label={council ? "Council members" : "Agents to compare"}>
                {harnesses.map((x) => {
                  const on = rivals.includes(x.id);
                  const off = x.ready === false && !on;
                  return (
                    <button
                      key={x.id}
                      type="button"
                      className="pill"
                      aria-pressed={on}
                      disabled={off}
                      title={off ? x.reason : undefined}
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
              options={harnesses.map((x) => ({
                value: x.id,
                label: x.name,
                sub: (
                  <>
                    <AgentLogo harness={x.id} icon={x.icon} size={13} />
                    {x.missing?.length ? `Needs ${x.missing.join(" and ")}` : providerOf(x.id)}
                    <span className="dim">{costLabel(x.cost)}</span>
                  </>
                ),
              }))}
              onChange={(v) => {
                setHarness(v);
                setEffort(null); // levels differ per agent
              }}
            />
            )}
            {mode === "session" ? <EffortControl harness={harness} value={effort} onChange={setEffort} /> : null}
            {council ? (
              <>
                <Picker
                  label="Chair"
                  icon={<Crown size={14} />}
                  value={chair}
                  options={harnesses.map((x) => ({ value: x.id, label: `${x.name} chairs`, sub: <span className="dim">Writes the report</span> }))}
                  onChange={(v) => setChair(v)}
                />
                <Picker
                  label="Rounds"
                  icon={<Repeat size={14} />}
                  value={String(rounds)}
                  options={[
                    { value: "1", label: "1 round", sub: <span className="dim">Research only</span> },
                    { value: "2", label: "2 rounds", sub: <span className="dim">Research, cross-review</span> },
                    { value: "3", label: "3 rounds", sub: <span className="dim">Research, cross-review, final positions</span> },
                  ]}
                  onChange={(v) => setRounds(Number(v))}
                />
                <label className="pill" title="Spending cap for the whole council">
                  <CurrencyDollar size={14} />
                  <span className="visually-hidden">Spending cap in dollars</span>
                  <input className="mono num" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ""))} style={{ width: "5ch" }} />
                  <span className="dim">cap</span>
                </label>
              </>
            ) : null}
            <button type="button" className="pill" aria-pressed={compare} onClick={() => setMode(compare ? "session" : "compare")} title="Give the same task to several agents and pick the best result">
              <Scales size={14} />
              <span className="pill-text">Compare</span>
            </button>
            <button type="button" className="pill" aria-pressed={council} onClick={() => setMode(council ? "session" : "council")} title="Several agents research a question together and report">
              <UsersThree size={14} />
              <span className="pill-text">Council</span>
            </button>
            {caps?.desktop && !council ? (
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

        {asked && mode !== "session" ? (
          <div className="council-asked" role="status">
            {(() => {
              const ok = asked.checked.filter((r) => r.ready);
              const no = asked.checked.filter((r) => !r.ready);
              const names = (list: AgentReadiness[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(list.map((r) => r.name));
              return (
                <>
                  <p>
                    <UsersThree size={14} />
                    {no.length === 0
                      ? `From your message: a ${compare ? "comparison" : "council"} of ${names(ok)}.`
                      : ok.length >= 2
                        ? `From your message: ${names(ok)} will take part. ${no.length === 1 ? "One agent you named can't" : `${no.length} agents you named can't`} run yet:`
                        : `From your message: only ${ok.length ? names(ok) : "none of them"} can run, and it takes two. The others:`}
                  </p>
                  {no.length ? (
                    <ul>
                      {no.map((r) => (
                        <li key={r.id}>{r.reason}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              );
            })()}
          </div>
        ) : null}

        <div className="composer-note" data-tone={note?.tone} role={note ? "alert" : undefined}>
          <span>
            {note?.text ??
              (council
                ? rivals.length < 2
                  ? "Pick at least two agents for the council."
                  : `${estimate ? `${estimate.turns} turns` : "Several turns"}${estimate?.usd != null ? `, about $${estimate.usd.toFixed(2)} from your recent turns` : ""}${estimate?.onPlan.length ? ` (${estimate.onPlan.join(" and ")} on your plan)` : ""}. Stops at the cap.`
                : compare
                ? rivals.length < 2
                  ? "Pick at least two agents to compare."
                  : `Each agent works on its own branch. Nothing opens a pull request until you pick a result. Each one's turn costs as usual.`
                : h.missing?.length
                  ? `${h.name} needs ${h.missing.join(" and ")}. Add it under Settings > Agents.`
                  : h.cost === "none"
                    ? `${h.name}'s turns record no cost. It's installed in the sandbox image and uses the keys under Settings > Agents.`
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
          {(council ? COUNCIL_STARTERS : STARTERS).map((s) => (
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
