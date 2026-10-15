import Link from "next/link";
import { ArrowRight, GithubLogo } from "@phosphor-icons/react/dist/ssr";
import { InstallCard } from "@/components/install-card";
import { RunStory } from "@/components/run-story";
import { SpendDemo } from "@/components/spend-demo";
import { AgentsDemo } from "@/components/agents-demo";
import { Mark } from "@/components/icons";

const REPO_URL = "https://github.com/AymanKhan9/Cloudly";
const MARKETING = process.env.NEXT_PUBLIC_SITE_MODE === "marketing";

const HOSTS = ["Oracle Cloud Always Free (Arm, 12 GB)", "Google Cloud e2-micro (1 GB, one run at a time)", "AWS (new-account credits)", "DigitalOcean"];

export default function Landing() {
  return (
    <div className="landing">
      <header className="topbar">
        <div className="wrap">
          <Link href="/" className="wordmark" aria-label="Cloudly home">
            <Mark />
            Cloudly
          </Link>
          <nav aria-label="Main">
            <a href="#how" className="hide-sm">
              How it works
            </a>
            <a href="#spend" className="hide-sm">
              Spend limit
            </a>
            <a href="#agents" className="hide-sm">
              Agents
            </a>
            <a href={REPO_URL} aria-label="Cloudly on GitHub">
              <GithubLogo size={18} />
            </a>
            {MARKETING ? null : (
              <Link href="/signin" className="btn btn-secondary btn-sm">
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main>
        <RunStory
          hero={
            <section className="hero">
              <h1>Coding agents you own, end to end.</h1>
              <p className="sub">
                Run Claude Agent, Codex or Gemini CLI on your GitHub repos from a VM in your own cloud. Close the
                laptop, get a pull request.
              </p>
              <div className="hero-actions">
                <InstallCard />
                <a href={REPO_URL} className="text-link">
                  <GithubLogo size={16} />
                  Read the source on GitHub
                  <ArrowRight size={14} />
                </a>
              </div>
            </section>
          }
        />

        <section id="spend" className="section">
          <div className="wrap">
            <div className="section-head">
              <h2>Set a limit. It actually stops.</h2>
              <p>
                Claude Agent reports exact cost per run. Codex and Gemini report tokens, priced from a table you control
                and marked as estimates. Runs on your Claude or ChatGPT plan don&apos;t count.
              </p>
            </div>
            <SpendDemo />
          </div>
        </section>

        <section id="agents" className="section">
          <div className="wrap">
            <div className="section-head">
              <h2>Switch agents with a dropdown.</h2>
              <p>
                Each agent reports its work in its own dialect. Cloudly translates all three into one log, so cancel,
                the spend limit and the pull request work the same whichever you pick.
              </p>
            </div>
            <AgentsDemo />
            <p className="agents-note">
              Each agent keeps its own session across your follow-ups, and its commands work as typed:{" "}
              <code className="mono">/compact</code>, <code className="mono">/context</code>,{" "}
              <code className="mono">/model</code> and the skills in your repo. Gemini CLI runs over the Agent Client
              Protocol, so other ACP agents can plug in the same way.
            </p>
          </div>
        </section>

        <section className="section">
          <div className="wrap close">
            <div>
              <h2>Put Cloudly on your own cloud.</h2>
              <InstallCard />
              <p className="hint" style={{ marginTop: 14, maxWidth: 520 }}>
                Run it on a fresh Linux VM. It installs Docker, gets an HTTPS certificate even without a domain, and
                finishes setup in the browser.
              </p>
            </div>
            <div className="hosts">
              <h3>Good fits today</h3>
              <ul>
                {HOSTS.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
              <p>Check each provider&apos;s current terms before you rely on a free tier.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap">
          <span>Cloudly is free software under the MIT license.</span>
          <nav>
            <a href={REPO_URL}>GitHub</a>
            {MARKETING ? null : <Link href="/signin">Sign in to your instance</Link>}
          </nav>
        </div>
      </footer>
    </div>
  );
}
