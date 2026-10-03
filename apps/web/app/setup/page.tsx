"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Mark, ArrowIcon, GitHubIcon } from "@/components/icons";
import { Oktas } from "@/components/notation";

interface Status {
  needsSetup: boolean;
  steps: { access: boolean; githubApp: boolean; installed: boolean };
  appSlug?: string;
  tokenConfigured: boolean;
}

const ERRORS: Record<string, string> = {
  state: "That GitHub step expired or came from a different browser. Start step 2 again.",
  github: "GitHub didn't finish creating the app. Start step 2 again.",
  installation: "That installation didn't belong to this app. Choose repositories again from step 3.",
  done: "Setup is already finished.",
};

async function post(path: string, token: string, body: object) {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "x-setup-token": token },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `Request failed (${res.status})`);
  return data;
}

function SetupInner() {
  const params = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [logins, setLogins] = useState("");
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(params.get("error") ? (ERRORS[params.get("error")!] ?? "Something went wrong.") : null);

  const refresh = useCallback(() => fetch("/api/setup/status").then((r) => r.json()).then(setStatus), []);

  useEffect(() => {
    setToken(sessionStorage.getItem("cloudly-setup-token") ?? "");
    refresh();
  }, [refresh]);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  const saveToken = (value: string) => {
    setToken(value);
    sessionStorage.setItem("cloudly-setup-token", value);
  };

  const saveAccess = () =>
    run("access", async () => {
      await post("/setup/access", token, { logins });
      await refresh();
    });

  const createApp = () =>
    run("app", async () => {
      const { action, manifest } = await post("/setup/github/start", token, { org: org.trim() || undefined });
      const form = document.createElement("form");
      form.method = "POST";
      form.action = action;
      const field = document.createElement("input");
      field.type = "hidden";
      field.name = "manifest";
      field.value = JSON.stringify(manifest);
      form.append(field);
      document.body.append(form);
      form.submit();
    });

  if (!status) return <p className="setup-wait" aria-busy="true">Checking this instance…</p>;

  const s = status.steps;
  const done = !status.needsSetup;
  const unlocked = token.length > 0;

  return (
    <div className="setup-card sheet">
      <div className="sheet-head">
        <span className="caps" style={{ color: "var(--slate)" }}>
          First-run setup
        </span>
        <Oktas eighths={done ? 8 : (Number(s.access) + Number(s.githubApp) + Number(s.installed)) * 2} title="Setup progress" />
      </div>

      {error ? (
        <div className="error-box" role="alert" style={{ margin: 16 }}>
          {error}
        </div>
      ) : null}

      {done ? (
        <div className="field field-wide" style={{ borderBottom: 0 }}>
          <h2 className="display" style={{ fontSize: 26, margin: "0 0 8px" }}>
            This station is set up.
          </h2>
          <p style={{ color: "var(--slate)", margin: "0 0 20px" }}>
            Sign in with GitHub, then add a model key under Settings so an agent can run.
          </p>
          <Link href="/signin" className="btn btn-signal">
            Sign in
            <ArrowIcon />
          </Link>
        </div>
      ) : (
        <>
          <div className="field field-wide">
            <label className="field-label" htmlFor="token">
              Setup token
            </label>
            <input id="token" type="password" value={token} onChange={(e) => saveToken(e.target.value)} autoComplete="off" className="mono" />
            <p className="field-hint">
              {status.tokenConfigured
                ? "Printed at the end of the installer. It's also CLOUDLY_SETUP_TOKEN in the server's .env."
                : "This server has no CLOUDLY_SETUP_TOKEN yet. Add one to the server's .env, restart the API, and reload."}
            </p>
          </div>

          <div className="setup-step" data-done={s.access || undefined}>
            <div className="field field-wide">
              <span className="field-label">1. Who can sign in</span>
              <input value={logins} onChange={(e) => setLogins(e.target.value)} placeholder="your-github-username" disabled={!unlocked || s.access} aria-label="GitHub usernames" />
              <p className="field-hint">Only these GitHub accounts can use this instance. Separate several with commas.</p>
              <button type="button" className="btn btn-signal" onClick={saveAccess} disabled={!unlocked || s.access || !logins.trim() || busy !== null} style={{ marginTop: 12 }}>
                {s.access ? "Saved" : busy === "access" ? "Saving…" : "Save"}
              </button>
            </div>
          </div>

          <div className="setup-step" data-done={s.githubApp || undefined}>
            <div className="field field-wide">
              <span className="field-label">2. Create the GitHub App</span>
              <p className="field-hint" style={{ margin: "0 0 10px" }}>
                One click: GitHub shows a pre-filled form (contents and pull requests, read and write) and you confirm it. The app belongs to your account and only this instance uses it.
              </p>
              <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Organization name (leave empty for your own account)" disabled={!unlocked || !s.access || s.githubApp} aria-label="Organization" />
              <button type="button" className="btn btn-signal" onClick={createApp} disabled={!unlocked || !s.access || s.githubApp || busy !== null} style={{ marginTop: 12 }}>
                <GitHubIcon />
                {s.githubApp ? "Created" : busy === "app" ? "Opening GitHub…" : "Create on GitHub"}
              </button>
            </div>
          </div>

          <div className="setup-step" data-done={s.installed || undefined}>
            <div className="field field-wide" style={{ borderBottom: 0 }}>
              <span className="field-label">3. Choose repositories</span>
              <p className="field-hint" style={{ margin: "0 0 10px" }}>
                GitHub sends you here after step 2. Pick the repositories agents may work on, private ones included. You can change this later on GitHub.
              </p>
              {s.githubApp && !s.installed && status.appSlug ? (
                <a className="btn btn-signal" href={`https://github.com/apps/${status.appSlug}/installations/new`}>
                  Choose repositories
                  <ArrowIcon />
                </a>
              ) : (
                <button type="button" className="btn btn-signal" disabled>
                  {s.installed ? "Installed" : "Waiting for step 2"}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function SetupPage() {
  return (
    <main className="setup">
      <Link href="/" className="wordmark" aria-label="Cloudly home">
        <Mark />
        Cloudly
      </Link>
      <h1 className="display">Set up your station.</h1>
      <p className="setup-lede">Three steps. Nothing here leaves this server except the calls to GitHub.</p>
      <Suspense fallback={null}>
        <SetupInner />
      </Suspense>
    </main>
  );
}
