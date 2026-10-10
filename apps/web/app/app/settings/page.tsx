"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useApp } from "@/components/app-context";
import { Barometer, STATE_WORD } from "@/components/notation";
import { HARNESSES, usd } from "@/lib/harness";
import { SecretsPanel } from "@/components/secrets-panel";

export default function SettingsPage() {
  const { budget, refreshBudget } = useApp();
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

  const state = budget?.state ?? "fair";

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="display">Settings</h1>
          <p>Spend limit and alerts for this instance.</p>
        </div>
      </div>

      <div className="settings-grid">
        <section className="settings-reading" aria-label="This month's spend">
          {budget ? (
            <>
              <Barometer
                ratio={budget.limitUsd ? budget.ratio : 0}
                spentLabel={usd(budget.spentUsd)}
                limitLabel={budget.limitUsd ? usd(budget.limitUsd) : "no limit"}
              />
              <p style={{ textAlign: "center", marginTop: 8 }}>
                {budget.limitUsd ? `${STATE_WORD[state]} · ${Math.round(budget.ratio * 100)}% used this month (UTC)` : "No limit set. Runs are never stopped for cost."}
              </p>
            </>
          ) : (
            <div className="skeleton" style={{ height: 220, opacity: 0.3 }} />
          )}
        </section>

        <form className="sheet" onSubmit={save}>
          <div className="sheet-head">
            <span className="caps" style={{ color: "var(--slate)" }}>
              Spend limit
            </span>
          </div>
          <div className="field field-wide">
            <label className="field-label" htmlFor="limit">
              Monthly model-spend limit
            </label>
            <div className="money-input">
              <span>$</span>
              <input id="limit" type="number" min={0} step="0.5" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} required className="num" />
            </div>
            <p className="field-hint">
              At 80% you get a banner and one email. At 100% new runs are refused. A turn that's already running
              finishes first, so a task isn't left half done; Claude Agent stops itself at 25% over the limit, and Codex and
              Gemini can go over by that one turn. Covers model spend only; your VM is billed by your cloud provider.
            </p>
          </div>
          <div className="field field-wide">
            <label className="field-label" htmlFor="email">
              Alert email
            </label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
            <p className="field-hint">Sent through Resend when RESEND_API_KEY is set on the server. Leave empty for in-app alerts only.</p>
          </div>
          <div className="sheet-foot">
            <span className="saved" role="status" style={{ color: message && !message.ok ? "var(--storm)" : undefined }}>
              {message?.text ?? ""}
            </span>
            <button type="submit" className="btn btn-signal" disabled={saving}>
              {saving ? "Saving…" : "Save limit"}
            </button>
          </div>
        </form>
      </div>

      <SecretsPanel />

      <section className="sheet" style={{ marginTop: 28 }} aria-labelledby="harness-heading">
        <div className="sheet-head">
          <span id="harness-heading" className="caps" style={{ color: "var(--slate)" }}>
            Agents
          </span>
        </div>
        <table className="harness-table">
          <tbody>
            {HARNESSES.map((h) => (
              <tr key={h.id}>
                <td>
                  <span className="latin" style={{ fontSize: 17 }}>
                    {h.genus}
                  </span>{" "}
                  {h.name}
                </td>
                <td className="mono" style={{ color: "var(--slate)" }}>
                  {h.id}
                </td>
                <td>{h.cost === "exact" ? "Exact cost from the agent" : "Estimated from tokens (PRICE_* in .env)"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="field-hint" style={{ padding: "0 16px 16px" }}>
          An agent runs only if its key is set above (or in the server's .env).
        </p>
      </section>
    </>
  );
}
