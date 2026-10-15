"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import { ArrowRight, Check, Copy, GithubLogo, WarningCircle } from "@phosphor-icons/react";
import { Mark } from "@/components/icons";
import { CloudScene, type SceneState } from "@/components/cloud-scene";

interface Status {
  needsSetup: boolean;
  steps: { access: boolean; githubApp: boolean; installed: boolean };
  appSlug?: string;
  tokenConfigured: boolean;
  staleSettings?: boolean;
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
  const [recovery, setRecovery] = useState("");
  const [oldKey, setOldKey] = useState("");
  const [restored, setRestored] = useState(0);
  const [error, setError] = useState<string | null>(params.get("error") ? (ERRORS[params.get("error")!] ?? "Something went wrong.") : null);

  const refresh = useCallback(
    () =>
      fetch("/api/setup/status")
        .then(async (r) => {
          if (!r.ok) throw new Error(`This instance's API answered ${r.status}. Check the logs with: journalctl -u cloudly-api -n 50`);
          return r.json();
        })
        .then(setStatus)
        .catch((e: Error) => setError(e.message || "Couldn't reach this instance's API.")),
    [],
  );

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

  const showRecoveryKey = () =>
    run("key", async () => {
      setRecovery((await post("/setup/recovery-key", token, {})).key);
    });

  const restore = () =>
    run("restore", async () => {
      const { recovered, status } = await post("/setup/recover", token, { key: oldKey });
      setOldKey("");
      setRestored(recovered);
      setStatus(status);
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

  if (!status) {
    return error ? (
      <div className="notice" data-tone="danger" role="alert" style={{ marginTop: 32 }}>
        <WarningCircle size={16} weight="bold" />
        <span>
          {error}{" "}
          <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => { setError(null); refresh(); }}>
            Try again
          </button>
        </span>
      </div>
    ) : (
      <div style={{ display: "grid", gap: 12, marginTop: 32 }} aria-busy="true">
        <div className="skeleton" style={{ width: "60%" }} />
        <div className="skeleton" style={{ width: "40%" }} />
      </div>
    );
  }

  const s = status.steps;
  const done = !status.needsSetup;
  const unlocked = token.length > 0;
  const current = !s.access ? 1 : !s.githubApp ? 2 : !s.installed ? 3 : 4;
  const stepState = (n: number, isDone: boolean) => ({
    "data-done": isDone || undefined,
    "data-current": (!isDone && current === n) || undefined,
    "data-locked": (!isDone && current < n) || undefined,
  });
  const dot = (n: number, isDone: boolean) => <span className="step-dot">{isDone ? <Check size={14} weight="bold" /> : n}</span>;

  return (
    <>
      <SetupScene steps={s} />

      {error ? (
        <div className="notice" data-tone="danger" role="alert" style={{ marginTop: 24 }}>
          <WarningCircle size={16} weight="bold" />
          {error}
        </div>
      ) : null}

      {restored > 0 ? (
        <div className="notice" data-tone="ok" role="status" style={{ marginTop: 24, display: "block" }}>
          {restored === 1 ? "1 setting" : `${restored} settings`} from your earlier install now work here.
          {s.githubApp ? " If this install has a new address, open your Cloudly app on GitHub (Settings > Developer settings > GitHub Apps) and set:" : null}
          {s.githubApp ? (
            <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: "8px 0 0", fontSize: 12 }}>
              {`Homepage URL:  ${location.origin}\nCallback URL:  ${location.origin}/api/auth/github/callback\nSetup URL:     ${location.origin}/api/setup/github/installed`}
            </pre>
          ) : null}
        </div>
      ) : null}

      {done ? (
        <div className="panel" style={{ marginTop: 32 }}>
          <div className="panel-row" style={{ display: "grid", gap: 12, justifyItems: "start" }}>
            <h2 style={{ fontSize: 20 }}>This instance is set up.</h2>
            <p className="muted">Sign in with GitHub, then add a model key under Settings so an agent can run.</p>
            <Link href="/signin" className="btn btn-primary">
              Sign in
              <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="setup-pre">
            <div className="field">
              <label className="label" htmlFor="token">
                Setup token
              </label>
              <input id="token" className="input mono" type="password" value={token} onChange={(e) => saveToken(e.target.value)} autoComplete="off" />
              <p className="hint">
                {status.tokenConfigured
                  ? "Printed at the end of the installer. It's also CLOUDLY_SETUP_TOKEN in the server's .env."
                  : "This server has no CLOUDLY_SETUP_TOKEN yet. Add one to the server's .env, restart the API, and reload."}
              </p>
            </div>

            {status.staleSettings ? (
              <div className="field">
                <label className="label" htmlFor="old-key">
                  Restore your settings
                </label>
                <p className="hint">
                  This database holds keys and settings from an earlier Cloudly install. Paste that install&apos;s recovery key to keep them, or skip this and set up from scratch.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <input id="old-key" className="input mono" type="password" value={oldKey} onChange={(e) => setOldKey(e.target.value)} autoComplete="off" disabled={!unlocked} />
                  <button type="button" className="btn btn-primary" onClick={restore} disabled={!unlocked || !oldKey.trim() || busy !== null}>
                    {busy === "restore" ? "Restoring" : "Restore"}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="field">
              <span className="label">Recovery key</span>
              <p className="hint">
                Save it in a password manager. If you reinstall Cloudly on this database, you&apos;ll paste it here to keep your keys and settings. It&apos;s only shown during setup.
              </p>
              {recovery ? (
                <div className="key-box">
                  <code className="mono">{recovery}</code>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(recovery)}>
                    <Copy size={14} />
                    Copy
                  </button>
                </div>
              ) : (
                <button type="button" className="btn btn-secondary" style={{ justifySelf: "start" }} onClick={showRecoveryKey} disabled={!unlocked || busy !== null}>
                  {busy === "key" ? "Loading" : "Show recovery key"}
                </button>
              )}
            </div>
          </div>

          <ol className="steps">
            <li {...stepState(1, s.access)}>
              {dot(1, s.access)}
              <div>
                <h2>Who can sign in</h2>
                <div className="body">
                  <p>Only these GitHub accounts can use this instance. Separate several with commas.</p>
                  {!s.access ? (
                    <div style={{ display: "flex", gap: 8 }}>
                      <input className="input" value={logins} onChange={(e) => setLogins(e.target.value)} placeholder="your-github-username" disabled={!unlocked} aria-label="GitHub usernames" />
                      <button type="button" className="btn btn-primary" onClick={saveAccess} disabled={!unlocked || !logins.trim() || busy !== null}>
                        {busy === "access" ? "Saving" : "Save"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </li>
            <li {...stepState(2, s.githubApp)}>
              {dot(2, s.githubApp)}
              <div>
                <h2>Create the GitHub App</h2>
                <div className="body">
                  <p>GitHub shows a pre-filled form (contents and pull requests, read and write) and you confirm it. The app belongs to your account and only this instance uses it.</p>
                  {!s.githubApp && current === 2 ? (
                    <>
                      <input className="input" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Organization (leave empty for your own account)" disabled={!unlocked} aria-label="Organization" />
                      <button type="button" className="btn btn-primary" style={{ justifySelf: "start" }} onClick={createApp} disabled={!unlocked || busy !== null}>
                        <GithubLogo size={16} weight="fill" />
                        {busy === "app" ? "Opening GitHub" : "Create on GitHub"}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </li>
            <li {...stepState(3, s.installed)}>
              {dot(3, s.installed)}
              <div>
                <h2>Choose repositories</h2>
                <div className="body">
                  <p>Pick the repositories agents may work on, private ones included. You can change this later on GitHub.</p>
                  {s.githubApp && !s.installed && status.appSlug ? (
                    <a className="btn btn-primary" style={{ justifySelf: "start" }} href={`https://github.com/apps/${status.appSlug}/installations/new`}>
                      Choose repositories
                      <ArrowRight size={15} />
                    </a>
                  ) : null}
                </div>
              </div>
            </li>
          </ol>
        </>
      )}
    </>
  );
}

function SceneSlot({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(document.getElementById("setup-scene")), []);
  return el ? createPortal(children, el) : null;
}

// The model of the user's cloud fills in as setup connects each piece.
function SetupScene({ steps }: { steps: Status["steps"] }) {
  const state: SceneState = steps.installed
    ? { sandbox: false, flows: ["task", "pr"], lit: ["web", "worker", "github"], badge: "Repositories connected" }
    : steps.githubApp
      ? { sandbox: false, flows: ["pr"], lit: ["github"] }
      : steps.access
        ? { sandbox: false, flows: ["task"], lit: ["browser", "web"], absent: ["github"] }
        : { sandbox: false, flows: [], lit: ["web", "db", "worker", "gateway"], absent: ["github"] };
  const caption = steps.installed
    ? "Ready. Sign in, pick a repo, start a session."
    : steps.githubApp
      ? "Your GitHub App connects the worker to GitHub."
      : steps.access
        ? "Sign-in is limited to the accounts you listed."
        : "Your VM is running Cloudly. Connect it, one step at a time.";
  return (
    <SceneSlot>
      <CloudScene state={state} label={`Model of your cloud account: ${caption}`} compact />
      <div className="scene-caption">
        <p aria-live="polite">{caption}</p>
      </div>
    </SceneSlot>
  );
}

export default function SetupPage() {
  return (
    <main className="setup">
      <div className="setup-main">
        <Link href="/" className="wordmark" aria-label="Cloudly home">
          <Mark />
          Cloudly
        </Link>
        <h1>Set up your instance</h1>
        <p>Three steps. Nothing here leaves this server except the calls to GitHub.</p>
        <Suspense fallback={null}>
          <SetupInner />
        </Suspense>
      </div>
      <aside className="setup-aside" id="setup-scene" aria-label="Setup progress" />
    </main>
  );
}
