"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, GitBranch, GithubLogo, Lightning, Monitor, Scales, UsersThree, Crown, Repeat, MagnifyingGlass, TreeStructure, Plus, X } from "@phosphor-icons/react";
import { api, ApiError, type AgentReadiness, type Capabilities, type Repo } from "@/lib/api";
import { agentsAskedFor } from "@repo/shared/agent-names";
import { isProviderHarness } from "@repo/shared/providers";
import { costLabel, MODELS, type HarnessId } from "@/lib/harness";
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

type Mode = "session" | "compare" | "council" | "audit" | "plan";

const MODES: { id: Exclude<Mode, "session">; label: string; about: string; Icon: typeof Plus }[] = [
  { id: "plan", label: "Plan", about: "Break a big task into sessions that run side by side", Icon: TreeStructure },
  { id: "audit", label: "Audit", about: "Review the whole repo, then pick what to fix", Icon: MagnifyingGlass },
  { id: "compare", label: "Compare", about: "The same task to several agents; keep the best", Icon: Scales },
  { id: "council", label: "Council", about: "Several agents research a question and report", Icon: UsersThree },
];

/** The composer's "+": what kind of start this is, and the desktop. */
function MoreMenu({ mode, setMode, desktop, setDesktop }: { mode: Mode; setMode: (m: Mode) => void; desktop: boolean | null; setDesktop: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="more-menu" ref={root}>
      <button type="button" className="pill icon-pill" aria-label="More ways to start" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Plus size={15} weight="bold" />
      </button>
      {open ? (
        <div className="menu more-menu-pop" role="menu">
          {MODES.map(({ id, label, about, Icon }) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={mode === id}
              onClick={() => {
                setMode(mode === id ? "session" : id);
                setOpen(false);
              }}
            >
              <Icon size={15} />
              <span>
                {label}
                <span className="dim">{about}</span>
              </span>
              {mode === id ? <Check size={14} weight="bold" className="more-check" /> : null}
            </button>
          ))}
          {desktop !== null ? (
            <>
              <hr />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={desktop}
                onClick={() => {
                  setDesktop(!desktop);
                  setOpen(false);
                }}
              >
                <Monitor size={15} />
                <span>
                  Desktop
                  <span className="dim">Give the agent a virtual desktop and browser</span>
                </span>
                {desktop ? <Check size={14} weight="bold" className="more-check" /> : null}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface Estimate {
  turns: number;
  usd: number | null;
  onPlan: string[];
}

/** The repository picker's "No project". */
const NO_PROJECT = "__none__";

export type Created = { kind: "session" | "council" | "arena" | "plan"; id: string };

const ROUTE: Record<Created["kind"], string> = { session: "/app/s/", council: "/app/council/", arena: "/app/arena/", plan: "/app/plans/" };

/**
 * Starting something: a session, or a plan, audit, comparison or council. The
 * page at /app, and a new tab in the session workspace (which takes a session
 * started there in place of itself).
 */
export function NewSession({ onCreated }: { onCreated?: (made: Created) => void } = {}) {
  const router = useRouter();
  const done = (made: Created) => (onCreated ? onCreated(made) : router.push(ROUTE[made.kind] + made.id));
  const { budget, harnesses } = useApp();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [harness, setHarness] = useState<string>("native-claude");
  // "Auto": the agent with the best record on this repo (the scorecard's pick).
  const [pick, setPick] = useState<{ harness: string; reason: string } | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  // null: the agent's own default.
  const [model, setModel] = useState<string | null>(null);
  // Compare: the same task to several agents at once (an arena). Council: several
  // agents answer one question together, in rounds, and a chair writes the report.
  const [mode, setMode] = useState<Mode>("session");
  const compare = mode === "compare";
  const council = mode === "council";
  // Audit: the agent reviews the whole repo and lists findings; nothing changes until you pick some.
  const audit = mode === "audit";
  // Plan: a planner breaks a big task into sessions that run side by side.
  const planMode = mode === "plan";
  const single = mode === "session" || audit || planMode;
  const [rivals, setRivals] = useState<string[]>(["native-claude", "native-codex"]);
  const [chair, setChair] = useState<string>("native-claude");
  const [rounds, setRounds] = useState(3);
  const [onRepo, setOnRepo] = useState(false);
  // A council member's model and effort; left out, the agent's own default.
  const [memberSettings, setMemberSettings] = useState<Record<string, { model?: string; effort?: string }>>({});
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

  // What Auto would pick on the chosen repo.
  useEffect(() => {
    if (!repo) return;
    let live = true;
    api<{ pick: { harness: string; reason: string } | null }>(`/scorecard?repo=${encodeURIComponent(repo)}`)
      .then((r) => live && setPick(r.pick))
      .catch(() => live && setPick(null));
    return () => {
      live = false;
    };
  }, [repo]);

  useEffect(() => {
    // "New session on <repo>" from a session's menu comes with ?repo= and ?branch=.
    const asked = new URLSearchParams(window.location.search);
    // "New plan" from the Plans page.
    if (asked.get("mode") === "plan") setMode("plan");
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

  // The chair is one of the members.
  useEffect(() => {
    if (council && rivals.length && !rivals.includes(chair)) setChair(rivals[0]!);
  }, [council, rivals, chair]);

  useEffect(() => {
    if (!council || rivals.length < 2) return setEstimate(null);
    const q = new URLSearchParams({ members: rivals.join(","), chair, rounds: String(rounds) });
    api<Estimate>(`/councils/estimate?${q}`).then(setEstimate).catch(() => setEstimate(null));
  }, [council, rivals, chair, rounds]);

  const stopped = budget?.state === "storm";
  const needsRepo = !council || onRepo;
  // A plain session can be a chat without a project; the rest need a repo.
  const noProject = repo === NO_PROJECT && !council;
  const projectMissing = repo === NO_PROJECT && (audit || planMode || compare);
  const ready =
    !submitting && !stopped && (audit || Boolean(prompt.trim())) && (!needsRepo || (noProject && !projectMissing) || (Boolean(repo) && repo !== NO_PROJECT && Boolean(branch.trim()))) && (single || rivals.length >= 2);
  const chosen = harness === "auto" ? pick?.harness ?? harnesses.find((x) => x.ready !== false)?.id ?? "native-claude" : harness;
  const h = harnesses.find((x) => x.id === chosen) ?? harnesses[0]!;
  const models = MODELS[chosen as HarnessId] ?? h.models ?? [];
  const desktopOffered = Boolean(caps?.desktop) && !council && !audit && !planMode;

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
            settings: Object.fromEntries(Object.entries(memberSettings).filter(([h]) => rivals.includes(h) || h === chair)),
          }),
        });
        done({ kind: "council", id });
        return;
      }
      if (compare) {
        const { id } = await api<{ id: string }>("/arenas", {
          method: "POST",
          body: JSON.stringify({ repo, baseBranch: branch, prompt, harnesses: rivals, desktop }),
        });
        done({ kind: "arena", id });
        return;
      }
      if (planMode) {
        const { id } = await api<{ id: string }>("/plans", {
          method: "POST",
          body: JSON.stringify({ repo, baseBranch: branch, goal: prompt, planner: chosen }),
        });
        done({ kind: "plan", id });
        return;
      }
      const { id } = await api<{ id: string }>("/threads", {
        method: "POST",
        body: JSON.stringify(
          audit
            ? { repo, baseBranch: branch, prompt: prompt.trim() ? `Audit the repository: ${prompt.trim()}` : "Audit the repository", harness: chosen, effort, mode: "audit", model: model ?? undefined }
            : { ...(noProject ? {} : { repo, baseBranch: branch }), prompt, harness: chosen, effort, desktop: desktopOffered && desktop, model: model ?? undefined },
        ),
      });
      done({ kind: "session", id });
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
        : projectMissing
          ? { tone: "danger", text: "Pick a repository: this needs one to work on." }
          : needsRepo && repos && repos.length === 0 && !noProject
            ? { tone: "danger", text: "The GitHub App can't see any repositories yet. Add one to its installation on GitHub, or pick No project." }
            : null;

  return (
    <div className="start">
      <h1>{council ? "What should the council answer?" : audit ? "Audit a repository" : planMode ? "What's the big task?" : "What should the agent work on?"}</h1>
      <p>
        {council
          ? "The members research at the same time, then debate each other's answers for as many rounds as you set, and give final positions. The chair writes the report. You can steer or finish it early from its page."
          : planMode
            ? "The agent reads the repo and breaks this into tasks, each its own session and pull request. You look over the tasks, then they run side by side, each starting once the ones it builds on are merged."
            : audit
            ? "The agent reads the whole repo and lists what's wrong, most important first. It changes nothing: pick the findings you want fixed and they go to the agent as a turn."
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
              planMode
                ? "Add multi-currency billing: store a currency per invoice, convert totals, show amounts in the dashboard and the PDF, and migrate existing invoices to USD."
                : audit
                ? "Optional: what to focus on, like security, error handling or the API layer"
                : council
                ? "What's the state of the job market for software engineers right now? Where is hiring growing, where is it shrinking, and what's driving it?"
                : "Add per-key rate limiting to POST /invoices, 60 requests a minute, and cover the 429 path with a test."
            }
            maxLength={8000}
            style={{ minHeight: 112 }}
          />
          <div className="composer-bar">
            <MoreMenu mode={mode} setMode={setMode} desktop={desktopOffered ? desktop : null} setDesktop={setDesktop} />
            {MODES.filter((m) => m.id === mode).map(({ id, label, Icon }) => (
              <button key={id} type="button" className="pill mode-chip" onClick={() => setMode("session")} title={`Back to a plain session`} aria-label={`${label}: back to a plain session`}>
                <Icon size={14} />
                <span className="pill-text">{label}</span>
                <X size={11} weight="bold" />
              </button>
            ))}
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
              disabled={!repos}
              searchable
              options={[
                { value: NO_PROJECT, label: "No project", sub: <span className="dim">A chat with a folder of its own: no repo, branch or pull request</span> },
                ...(repos ?? []).map((r) => ({ value: r.fullName, label: r.fullName, hint: r.private ? "Private" : undefined })),
              ]}
              onChange={(v) => {
                setRepo(v);
                const r = repos?.find((x) => x.fullName === v);
                if (r) setBranch(r.defaultBranch);
              }}
            />
            {repo !== NO_PROJECT ? (
            <label className="pill" title="Base branch: the pull request targets it">
              <GitBranch size={15} />
              <span className="visually-hidden">Base branch</span>
              <input className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} required spellCheck={false} style={{ width: `${Math.min(24, Math.max(5, branch.length + 1))}ch` }} />
            </label>
            ) : null}
            </>
            ) : null}
            {!single ? (
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
              icon={<AgentLogo harness={chosen} size={15} />}
              value={harness}
              options={[
                {
                  value: "auto",
                  label: pick ? `Auto: ${harnesses.find((x) => x.id === pick.harness)?.name ?? pick.harness}` : "Auto",
                  sub: <span className="dim">{pick ? `Best record on this repo: ${pick.reason}` : "Not enough history on this repo yet; picks once agents have a record here"}</span>,
                },
                ...harnesses.map((x) => ({
                value: x.id,
                label: x.name,
                sub: (
                  <>
                    <AgentLogo harness={x.id} icon={x.icon} size={13} />
                    {x.missing?.length ? `Needs ${x.missing.join(" and ")}` : providerOf(x.id)}
                    <span className="dim">{costLabel(x.cost)}</span>
                  </>
                ),
              }))]}
              onChange={(v) => {
                setHarness(v);
                setEffort(null); // levels differ per agent
                setModel(null); // and so do models
              }}
            />
            )}
            {single && !planMode ? (
              <Picker
                label="Model"
                icon={<AgentLogo harness={chosen} icon={h.icon} size={15} />}
                searchable
                value={model ?? "default"}
                options={[
                  { value: "default", label: "Default model", sub: <span className="dim">{h.defaultModel ? `${h.defaultModel}, chosen by the agent` : "Chosen by the agent"}</span> },
                  ...models.map((m: { value: string; label: string; hint?: string }) => {
                    // OpenCode's free models end in "-free"; they stop at its usage limit until it resets.
                    const hint = m.hint ?? (/(^|[-/ ])free$/i.test(m.value) ? "Free, up to OpenCode's usage limit" : undefined);
                    return { value: m.value, label: m.label, sub: hint ? <span className="dim">{hint}</span> : undefined };
                  }),
                ]}
                custom={(q) => `Use ${q}`}
                note={isProviderHarness(chosen) && !h.models?.length ? `${h.name} lists its models once it has run a turn; type a model ID meanwhile.` : undefined}
                onChange={(v) => setModel(v === "default" ? null : v)}
              />
            ) : null}
            {single ? <EffortControl harness={chosen} value={effort} onChange={setEffort} /> : null}
            {council ? (
              <span className="pill rounds-stepper" role="group" aria-label="Rounds">
                <Repeat size={14} />
                <button type="button" aria-label="Fewer rounds" disabled={rounds <= 1} onClick={() => setRounds((r) => Math.max(1, r - 1))}>
                  −
                </button>
                <span className="num">{rounds === 1 ? "1 round" : `${rounds} rounds`}</span>
                <button type="button" aria-label="More rounds" disabled={rounds >= 10} onClick={() => setRounds((r) => Math.min(10, r + 1))}>
                  +
                </button>
              </span>
            ) : null}
            {desktopOffered && desktop ? (
              <button type="button" className="pill mode-chip" onClick={() => setDesktop(false)} aria-label="Desktop: turn off">
                <Monitor size={14} />
                <span className="pill-text">Desktop</span>
                <X size={11} weight="bold" />
              </button>
            ) : null}
            <span className="spacer" />
            <button type="submit" className="send" disabled={!ready} aria-label="Start session">
              <ArrowUp size={18} weight="bold" />
            </button>
          </div>
        </div>

        {council && rivals.length ? (
          <div className="council-setup" role="group" aria-label="Council members">
            <p className="council-setup-head">
              Members
              <span className="dim">
                {rounds === 1 ? "Research only" : rounds === 2 ? "Research, then final positions" : `Research, ${rounds - 2} round${rounds === 3 ? "" : "s"} of debate, final positions`}; the chair (crowned) writes the report.
              </span>
            </p>
            {rivals.map((m) => {
              const x = harnesses.find((y) => y.id === m);
              const set = memberSettings[m] ?? {};
              const put = (patch: { model?: string; effort?: string }) => setMemberSettings((all) => ({ ...all, [m]: { ...all[m], ...patch } }));
              const models = MODELS[m as HarnessId] ?? x?.models ?? [];
              return (
                <div key={m} className="council-member">
                  <AgentLogo harness={m} icon={x?.icon} size={16} />
                  <span className="name">{x?.name ?? m}</span>
                  <Picker
                    label={`${x?.name ?? m} model`}
                    icon={<span className="dim">Model</span>}
                    searchable
                    value={set.model ?? "default"}
                    options={[{ value: "default", label: "Default model" }, ...models.map((o: { value: string; label: string }) => ({ value: o.value, label: o.label }))]}
                    custom={(q) => `Use ${q}`}
                    onChange={(v) => put({ model: v === "default" ? undefined : v })}
                  />
                  <EffortControl harness={m} value={set.effort ?? null} onChange={(e) => put({ effort: e ?? undefined })} />
                  <button
                    type="button"
                    className="icon-btn chair-toggle"
                    aria-pressed={chair === m}
                    aria-label={chair === m ? `${x?.name ?? m} chairs the council` : `Make ${x?.name ?? m} the chair`}
                    title={chair === m ? "Chairs: writes the report" : "Make this member the chair"}
                    onClick={() => setChair(m)}
                  >
                    <Crown size={16} weight={chair === m ? "fill" : "regular"} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}

        {asked && !single ? (
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
                  : `${estimate ? `${estimate.turns} turns` : "Several turns"}${estimate?.usd != null ? `, about $${estimate.usd.toFixed(2)} from your recent turns` : ""}${estimate?.onPlan.length ? ` (${estimate.onPlan.join(" and ")} on your plan)` : ""}. Each round's members work at the same time.`
                : planMode
                ? `${h.name} plans (one turn); each task is then a session of its own, costing what its turns cost.`
                : audit
                ? `${h.name} reviews the repo read-only and writes up findings. Costs like one turn.`
                : compare
                ? rivals.length < 2
                  ? "Pick at least two agents to compare."
                  : `Each agent works on its own branch. Nothing opens a pull request until you pick a result. Each one's turn costs as usual.`
                : h.missing?.length
                  ? `${h.name} needs ${h.missing.join(" and ")}. Add it under Settings > Agents.`
                  : h.cost === "none"
                    ? `${h.name}'s turns record no cost. It's installed in the sandbox image and uses the keys under Settings > Agents.`
                    : `${h.name} ${h.cost === "exact" ? "reports exact cost" : "cost is estimated from tokens"}. ${isProviderHarness(h.id) ? "Its keys are under Settings > Agents." : "It needs its key or plan sign-in in Settings."}`)}
          </span>
          <span>
            <kbd>Enter</kbd> to start, <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
          </span>
        </div>
      </form>

      {prompt.trim() || audit || planMode ? null : (
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
