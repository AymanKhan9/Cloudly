import Link from "next/link";
import { HeroReplay } from "@/components/hero-replay";
import { InstallCard } from "@/components/install-card";
import { SpendDemo } from "@/components/spend-demo";
import { StationFigure } from "@/components/station-figure";
import { AltitudeStrip } from "@/components/altitude-strip";
import { Oktas } from "@/components/notation";
import { ArrowIcon, GitHubIcon, Mark } from "@/components/icons";

const REPO_URL = "https://github.com/AymanKhan9/Cloudly";
const MARKETING = process.env.NEXT_PUBLIC_SITE_MODE === "marketing";

// The real event names each adapter in packages/runner maps from.
const DIALECTS = [
  { claude: "assistant · text block", codex: "item.completed · agent_message", gemini: "session/update · agent_message_chunk", out: "Agent" },
  { claude: "assistant · tool_use", codex: "item.started · command_execution", gemini: "session/update · tool_call", out: "Tool" },
  { claude: "user · tool_result", codex: "item.completed · command_execution", gemini: "session/update · tool_call_update", out: "Result" },
  { claude: "result · total_cost_usd", codex: "turn.completed · usage tokens", gemini: "prompt response · token quota", out: "Done + cost" },
];

const DEMO_LOG = [
  { oktas: 3, task: "Add per-key rate limiting to POST /invoices", repo: "acme/billing-api", genus: "Cumulus", harness: "Claude Agent", status: "Running", cost: "$0.21", est: false, pr: null },
  { oktas: 8, task: "Upgrade the test runner and fix the two flaky specs", repo: "acme/web", genus: "Cirrus", harness: "Gemini CLI", status: "PR opened", cost: "~$0.07", est: true, pr: "#88" },
  { oktas: 8, task: "Write a migration that backfills invoice currency", repo: "acme/billing-api", genus: "Altocumulus", harness: "Codex", status: "PR opened", cost: "~$0.44", est: true, pr: "#213" },
  { oktas: 8, task: "Refactor invoice export to streaming CSV", repo: "acme/billing-api", genus: "Cumulus", harness: "Claude Agent", status: "Cancelled", cost: "$1.12", est: false, pr: null, struck: true },
];

export default function Landing() {
  return (
    <div className="landing">
      <section className="band band-0">
        <header className="topbar">
          <Link href="/" className="wordmark" aria-label="Cloudly home">
            <Mark />
            Cloudly
          </Link>
          <nav aria-label="Main">
            <a href="#station" className="hide-sm">
              Where it runs
            </a>
            <a href="#spend" className="hide-sm">
              Spend limit
            </a>
            <a href={REPO_URL}>GitHub</a>
            {MARKETING ? null : (
              <Link href="/signin" className="btn btn-line" style={{ minHeight: 36, color: "var(--chalk)" }}>
                Sign in
              </Link>
            )}
          </nav>
        </header>

        <div className="wrap hero">
          <div>
            <h1 className="display">Coding agents on a server you already own.</h1>
            <p className="lede">
              Cloudly runs <strong>Claude Agent, Codex or Gemini CLI</strong> against your GitHub repos on a VM in your
              own cloud account. Hand it a task, close the laptop, and come back to a pull request. It stops spending
              when you reach your monthly limit. Free and MIT-licensed.
            </p>
            <div className="hero-actions">
              <InstallCard />
              <p className="hero-note">Run it on a fresh Linux VM. It installs Docker and walks you through the setup.</p>
              <a href={REPO_URL} className="link-arrow">
                <GitHubIcon width={15} height={15} />
                Read the source on GitHub
                <ArrowIcon />
              </a>
            </div>
          </div>
          <HeroReplay />
        </div>
      </section>

      <section id="station" className="band band-1 section">
        <div className="wrap">
          <AltitudeStrip plate="II" genus={2} name="Cirrus fibratus" altitude="9 000 m" />
          <h2 className="display">Nothing runs anywhere you don't control.</h2>
          <p className="section-lede">
            One VM in your account runs everything: the web app, the API, the worker and Postgres. Each run gets its
            own throwaway container. Your keys live in a <span className="mono">.env</span> file on that VM, and your
            code is never sent to an agent service in between.
          </p>
          <div className="station">
            <StationFigure />
            <div>
              <ul className="station-facts">
                <li>
                  <strong>Your keys, your bill</strong>
                  <span>The sandbox calls Anthropic, OpenAI or Google directly with your API key. Cloudly adds no markup and has no account of its own.</span>
                </li>
                <li>
                  <strong>GitHub credentials never enter the sandbox</strong>
                  <span>The worker pushes the branch and opens the pull request from outside the container, with a short-lived GitHub App token.</span>
                </li>
                <li>
                  <strong>Untrusted output is treated as untrusted</strong>
                  <span>The agent's patch is exported in a network-less container, validated, then committed deterministically in a clone the agent never touched.</span>
                </li>
              </ul>
              <div className="providers">
                Good fits today, if you check each provider's current terms:
                <ul>
                  <li>Oracle Cloud Always Free (Arm, 12 GB)</li>
                  <li>Google Cloud e2-micro (1 GB, one run at a time)</li>
                  <li>AWS (new-account credits)</li>
                  <li>DigitalOcean (paid droplet)</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="spend" className="band band-2 section">
        <div className="wrap">
          <AltitudeStrip plate="III" genus={1} name="Altocumulus stratiformis" altitude="4 000 m" />
          <h2 className="display">Set a limit. It actually stops.</h2>
          <p className="section-lede">
            Pick a monthly model-spend limit. Claude Agent reports exact cost per run; Codex and Gemini report tokens,
            which Cloudly prices from a table you control and marks as an estimate.
          </p>
          <SpendDemo />
        </div>
      </section>

      <section className="band band-3 section">
        <div className="wrap">
          <AltitudeStrip plate="IV" genus={0} name="Stratocumulus" altitude="1 500 m" />
          <h2 className="display">Switch agents with a dropdown.</h2>
          <p className="section-lede" style={{ marginBottom: 0 }}>
            Each agent reports its work in its own dialect. Cloudly translates all three into one event stream, so the
            run log, the cancel button, the spend limit and the pull request work the same whichever agent you pick.
            Gemini CLI runs over the Agent Client Protocol, so other ACP agents can plug in the same way.
          </p>
          <ul className="dialects-stacked">
            {DIALECTS.map((d) => (
              <li key={d.out}>
                <strong>{d.out}</strong>
                <dl>
                  <dt className="latin">Cumulus · Claude Agent</dt>
                  <dd className="mono">{d.claude}</dd>
                  <dt className="latin">Altocumulus · Codex</dt>
                  <dd className="mono">{d.codex}</dd>
                  <dt className="latin">Cirrus · Gemini CLI</dt>
                  <dd className="mono">{d.gemini}</dd>
                </dl>
              </li>
            ))}
          </ul>
          <div className="dialects-wide">
            <table className="dialects">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="latin">Cumulus</span>
                    <span>Claude Agent · Agent SDK</span>
                  </th>
                  <th scope="col">
                    <span className="latin">Altocumulus</span>
                    <span>Codex · Codex SDK</span>
                  </th>
                  <th scope="col">
                    <span className="latin">Cirrus</span>
                    <span>Gemini CLI · ACP</span>
                  </th>
                  <th scope="col">
                    <span className="latin">Cloudly</span>
                    <span>one log</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {DIALECTS.map((d) => (
                  <tr key={d.out}>
                    <td className="mono">{d.claude}</td>
                    <td className="mono">{d.codex}</td>
                    <td className="mono">{d.gemini}</td>
                    <td className="out">
                      <ArrowIcon className="arrow" width={16} height={16} />
                      {d.out}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="band band-ground">
        <div className="wrap section" style={{ paddingBottom: 0 }}>
          <h2 className="display">Every run, logged like an observation.</h2>
          <p className="section-lede">
            Each run records its repo, agent, status, cost and pull request. Progress is drawn the way a weather
            station records cloud cover: in eighths of the sky.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="log">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">Progress</span>
                  </th>
                  <th scope="col">Task</th>
                  <th scope="col" className="hide-sm">
                    Agent
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col" className="r">
                    Cost
                  </th>
                  <th scope="col" className="r hide-sm">
                    PR
                  </th>
                </tr>
              </thead>
              <tbody>
                {DEMO_LOG.map((r) => (
                  <tr key={r.task}>
                    <td style={{ width: 36 }}>
                      <Oktas eighths={r.oktas} title={`${r.oktas} of 8`} />
                    </td>
                    <td className="task">
                      {r.task}
                      <small className="mono">{r.repo}</small>
                    </td>
                    <td className="hide-sm">
                      <span className="latin">{r.genus}</span>
                      <span className="h-name">{r.harness}</span>
                    </td>
                    <td>
                      <span className="status-label" data-status={r.struck ? "cancelled" : undefined}>
                        {r.status}
                      </span>
                    </td>
                    <td className="r num">{r.cost}</td>
                    <td className="r num hide-sm">{r.pr ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="synthetic-note">Illustrative data. A tilde marks an estimated cost.</p>
        </div>

        <div className="wrap close">
          <div>
            <h2 className="display">Put a station on your own cloud.</h2>
            <InstallCard />
          </div>
          <a href={REPO_URL} className="link-arrow" style={{ borderColor: "var(--hair-ink)" }}>
            <GitHubIcon width={15} height={15} />
            AymanKhan9/Cloudly
            <ArrowIcon />
          </a>
        </div>

        <footer className="footer">
          <div className="wrap">
            <span>Cloudly is free software under the MIT license. Bring your own cloud, keys and GitHub.</span>
            {MARKETING ? null : (
              <span>
                <Link href="/signin">Sign in to your instance</Link>
              </span>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
