"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { THEME_KEY, RAIL_KEY } from "@/lib/theme";
import { useApp } from "@/components/app-context";
import { SpendBar } from "@/components/status";
import { usd } from "@/lib/harness";

const STATE_TEXT = { fair: "Runs start normally", change: "Warning sent", storm: "New runs blocked" };

// Where /app/settings#<section> links (from before settings had pages) now go.
const OLD_ANCHORS: Record<string, string> = {
  keys: "keys", agents: "agents", mcp: "mcp", sandbox: "sandbox", network: "sandbox", secrets: "secrets", files: "files", context: "context",
  checks: "checks", triggers: "github", sentry: "sentry", notifications: "notifications", discord: "chat", slack: "chat",
};

function Appearance() {
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [rail, setRailShown] = useState(true);
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    setTheme(t === "light" || t === "dark" ? t : "system");
    setRailShown(document.documentElement.dataset.rail !== "closed");
  }, []);
  const pickTheme = (t: "system" | "light" | "dark") => {
    setTheme(t);
    try {
      if (t === "system") {
        delete document.documentElement.dataset.theme;
        localStorage.removeItem(THEME_KEY);
      } else {
        document.documentElement.dataset.theme = t;
        localStorage.setItem(THEME_KEY, t);
      }
    } catch {}
  };
  const pickRail = (shown: boolean) => {
    setRailShown(shown);
    if (shown) delete document.documentElement.dataset.rail;
    else document.documentElement.dataset.rail = "closed";
    try {
      localStorage.setItem(RAIL_KEY, shown ? "open" : "closed");
    } catch {}
  };
  return (
    <section className="set-sec" aria-labelledby="appearance-h" id="appearance">
      <header>
        <h2 id="appearance-h">Appearance</h2>
        <p>For this browser.</p>
      </header>
      <div className="set-body">
        <div className="panel">
          <div className="panel-row setting-row">
            <div>
              <span className="label">Theme</span>
              <p className="hint">System follows your device.</p>
            </div>
            <div className="segmented" role="radiogroup" aria-label="Theme">
              {(["system", "light", "dark"] as const).map((t) => (
                <button key={t} type="button" role="radio" aria-checked={theme === t} onClick={() => pickTheme(t)}>
                  {t[0]!.toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="panel-row setting-row">
            <div>
              <span className="label">Sidebar</span>
              <p className="hint">Show or hide it any time with Ctrl B (⌘B on a Mac).</p>
            </div>
            <div className="segmented" role="radiogroup" aria-label="Sidebar">
              <button type="button" role="radio" aria-checked={rail} onClick={() => pickRail(true)}>
                Shown
              </button>
              <button type="button" role="radio" aria-checked={!rail} onClick={() => pickRail(false)}>
                Hidden
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Account() {
  const { user } = useApp();
  return (
    <section className="set-sec" aria-labelledby="account-h" id="account">
      <header>
        <h2 id="account-h">Account</h2>
        <p>Who can sign in is under Keys and sign-ins.</p>
      </header>
      <div className="set-body">
        <div className="panel">
          <div className="panel-row setting-row">
            <div>
              <span className="label">Signed in as {user?.login ?? ""}</span>
              <p className="hint">With GitHub.</p>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={async () => {
                await api("/auth/logout", { method: "POST" }).catch(() => {});
                window.location.assign("/signin");
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function SettingsPage() {
  const { budget, refreshBudget } = useApp();
  const router = useRouter();
  // An old link to a section of the one long settings page goes to that section's page.
  useEffect(() => {
    const to = OLD_ANCHORS[window.location.hash.slice(1)];
    if (to) router.replace(`/app/settings/${to}${window.location.search}`);
  }, [router]);
  const [limit, setLimit] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (budget && !seeded) {
      setLimit(budget.limitUsd !== null ? String(budget.limitUsd) : "10");
      setEmail(budget.alertEmail ?? "");
      setSeeded(true);
    }
  }, [budget, seeded]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await api("/budget", {
        method: "PUT",
        body: JSON.stringify({ monthlyLimitUsd: Number(limit), alertEmail: email.trim() || null }),
      });
      await refreshBudget();
      setMessage({ ok: true, text: "Saved. Both alerts are re-armed for this month." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Couldn't save." });
    } finally {
      setSaving(false);
    }
  }

  const state = budget?.limitUsd ? budget.state : "fair";

  return (
    <div className="page">
      <div className="page-head">
        <h1>General</h1>
        <p>Spend, how Cloudly looks in this browser, and your account. Everything else is in the menu.</p>
      </div>

      <section className="set-sec" aria-labelledby="spend-h">
        <header>
          <h2 id="spend-h">Spend limit</h2>
          <p>Model spend only. Your VM is billed by your cloud provider. Months reset on the 1st (UTC).</p>
        </header>
        <div className="set-body">
          <div className="panel">
            <div className="panel-row">
              {budget ? (
                <>
                  <div className="usage-read">
                    <span className="big num">{usd(budget.spentUsd)}</span>
                    <span className="of">{budget.limitUsd ? `of ${usd(budget.limitUsd)} this month` : "this month, no limit set"}</span>
                    {budget.limitUsd ? (
                      <span className="usage-state" data-state={state}>
                        {Math.round(budget.ratio * 100)}%, {STATE_TEXT[state].toLowerCase()}
                      </span>
                    ) : null}
                  </div>
                  {budget.limitUsd ? (
                    <div style={{ marginTop: 16 }}>
                      <SpendBar ratio={budget.ratio} state={state} large />
                      <div className="usage-scale">
                        <span>$0</span>
                        <span>Warning at 80%, stop at 100%</span>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="skeleton" style={{ width: "40%", height: 30 }} />
              )}
            </div>
            <form className="panel-row" onSubmit={save} style={{ display: "grid", gap: 18 }}>
              <div className="field">
                <label className="label" htmlFor="limit">
                  Monthly limit
                </label>
                <div className="input-prefix">
                  <span>$</span>
                  <input id="limit" type="number" min={0} step="0.5" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} required className="num" />
                </div>
                <p className="hint">
                  At 80% you get a banner and one email. At 100% new runs are refused. A turn that&apos;s already running
                  finishes first; Claude Code stops itself at 25% over, and Codex and Gemini can go over by that one turn.
                </p>
              </div>
              <div className="field">
                <label className="label" htmlFor="email">
                  Alert email
                </label>
                <input id="email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" style={{ maxWidth: 360 }} />
                <p className="hint">Sent through Resend when its key is set below. Leave empty for in-app alerts only.</p>
              </div>
              <div className="form-foot">
                <span className="msg" role="status" data-tone={message ? (message.ok ? "ok" : "danger") : undefined}>
                  {message?.text ?? ""}
                </span>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? "Saving" : "Save limit"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </section>

      <Appearance />
      <Account />
    </div>
  );
}
