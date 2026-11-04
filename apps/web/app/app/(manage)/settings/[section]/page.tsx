"use client";

import { notFound, useParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api, type Repo } from "@/lib/api";
import { SecretsPanel } from "@/components/secrets-panel";
import { SandboxPanel } from "@/components/sandbox-panel";
import { McpPanel } from "@/components/mcp-panel";
import { EnvPanel } from "@/components/env-panel";
import { FilesPanel } from "@/components/files-panel";
import { ContextSettings } from "@/components/context-settings";
import { AgentsPanel } from "@/components/agents-panel";
import { ChecksSettings } from "@/components/checks-settings";
import { GitHubTriggers } from "@/components/github-triggers";
import { DiscordSettings, NotificationSettings, SlackSettings } from "@/components/discord-settings";
import { SentrySettings } from "@/components/sentry-settings";
import { LoadFailed } from "@/components/status";

// A repo's kept files (/files in its runs), picked from the installation's repos.
function RepoFilesSection() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api<{ repos: Repo[] }>("/repos")
      .then((r) => {
        setRepos(r.repos);
        setRepo(r.repos[0]?.fullName ?? "");
      })
      .catch((e: Error) => {
        setRepos([]);
        setError(e.message);
      });
  };
  useEffect(() => {
    load();
  }, []);
  return (
    <section className="set-sec" aria-labelledby="files-h" id="files">
      <header>
        <h2 id="files-h">Repo files</h2>
        <p>Files a repo&apos;s sessions find at /files: data, fixtures, a local config. They aren&apos;t committed, and what the agent saves there is kept for the next session.</p>
      </header>
      <div className="set-body">
        <div className="panel">
          <div className="panel-row field">
            <label className="label" htmlFor="files-repo">
              Repository
            </label>
            <select id="files-repo" className="select" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={!repos?.length} style={{ maxWidth: 360 }}>
              {(repos ?? []).map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </div>
          <div className="panel-row">
            {error ? (
              <LoadFailed what="your repositories" detail={error} onRetry={load} />
            ) : repo ? (
              <FilesPanel repo={repo} />
            ) : (
              <p className="hint">{repos ? "No repositories yet." : "Loading"}</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** One page of settings: its sections, under the menu (see ../../layout.tsx). */
const SECTIONS: Record<string, () => React.ReactNode> = {
  keys: () => <SecretsPanel />,
  agents: () => <AgentsPanel />,
  mcp: () => (
    <Suspense fallback={null}>
      <McpPanel />
    </Suspense>
  ),
  sandbox: () => <SandboxPanel />,
  secrets: () => <EnvPanel />,
  files: () => <RepoFilesSection />,
  context: () => <ContextSettings />,
  checks: () => <ChecksSettings />,
  github: () => <GitHubTriggers />,
  sentry: () => <SentrySettings />,
  notifications: () => <NotificationSettings />,
  chat: () => (
    <>
      <DiscordSettings />
      <SlackSettings />
    </>
  ),
};

export default function SettingsSectionPage() {
  const { section } = useParams<{ section: string }>();
  const render = SECTIONS[section];
  if (!render) notFound();
  return <div className="page settings-page">{render()}</div>;
}
