"use client";

import { useEffect, useState } from "react";
import { Copy, Check } from "@phosphor-icons/react";
import { api, ApiError } from "@/lib/api";

interface DiscordStatus {
  applicationId: string | null;
  publicKey: string | null;
  botTokenSet: boolean;
  interactionsUrl: string;
  inviteUrl: string | null;
  linked: boolean;
}

interface NotifyStatus {
  discordDm: boolean;
  slackDm: boolean;
  discordWebhook: string | null;
  slackWebhook: string | null;
  onNeedsYou: boolean;
  onDone: boolean;
  onFailed: boolean;
  onMerged: boolean;
}

export function CopyText({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <code className="mono" aria-label={label}>
        {value}
      </code>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={async () => {
          await navigator.clipboard.writeText(value).catch(() => {});
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** The Discord bot: its application, its commands, and linking your account. */
export function DiscordSettings() {
  const [s, setS] = useState<DiscordStatus | null>(null);
  const [appId, setAppId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [token, setToken] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<DiscordStatus>("/settings/discord")
      .then((v) => {
        setS(v);
        setAppId(v.applicationId ?? "");
        setPublicKey(v.publicKey ?? "");
      })
      .catch((e: Error) => setMessage({ ok: false, text: e.message }));
  useEffect(() => {
    load();
  }, []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text: ok });
      await load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Something went wrong." });
    } finally {
      setBusy(false);
    }
  };

  const configured = Boolean(s?.applicationId && s.publicKey && s.botTokenSet);

  return (
    <section className="set-sec" aria-labelledby="discord-h" id="discord">
      <header>
        <h2 id="discord-h">Discord</h2>
        <p>
          Start sessions with <code className="mono">/cloudly task</code>, follow each one in its own Discord thread, and reply or cancel from there. Only Discord accounts linked to
          Cloudly can use it.
        </p>
      </header>
      <div className="set-body">
        {s ? (
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () => api("/settings/discord", { method: "PUT", body: JSON.stringify({ applicationId: appId.trim(), publicKey: publicKey.trim(), botToken: token.trim() || undefined }) }).then(() => setToken("")),
                "Saved. Now register the commands.",
              );
            }}
          >
            <div className="panel-row field">
              <span className="label">1. Make a Discord application</span>
              <p className="hint">
                At{" "}
                <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">
                  discord.com/developers
                </a>
                , create an application. Copy its application ID and public key (General Information) and its bot token (Bot, Reset Token) here.
              </p>
            </div>
            <div className="panel-row checks-grid">
              <div className="field">
                <label className="label" htmlFor="dc-app">
                  Application ID
                </label>
                <input id="dc-app" className="input mono" value={appId} onChange={(e) => setAppId(e.target.value)} inputMode="numeric" autoComplete="off" />
              </div>
              <div className="field">
                <label className="label" htmlFor="dc-key">
                  Public key
                </label>
                <input id="dc-key" className="input mono" value={publicKey} onChange={(e) => setPublicKey(e.target.value)} autoComplete="off" spellCheck={false} />
              </div>
            </div>
            <div className="panel-row field">
              <label className="label" htmlFor="dc-token">
                Bot token
              </label>
              <input
                id="dc-token"
                className="input mono"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={s.botTokenSet ? "Saved. Paste a new one to replace it." : ""}
                autoComplete="off"
              />
            </div>
            <div className="panel-row field">
              <span className="label">2. Point Discord at Cloudly</span>
              <p className="hint">Paste this as the application&apos;s Interactions Endpoint URL (General Information). Discord checks it when you save there, so save here first.</p>
              <CopyText value={s.interactionsUrl} label="Interactions endpoint URL" />
            </div>
            <div className="panel-row field">
              <span className="label">3. Add the bot and its command</span>
              <div className="row-actions">
                <button type="button" className="btn btn-secondary btn-sm" disabled={!configured || busy} onClick={() => run(() => api("/settings/discord/commands", { method: "POST" }), "Registered /cloudly. It can take a few minutes to show up.")}>
                  Register /cloudly
                </button>
                {s.inviteUrl ? (
                  <a className="btn btn-secondary btn-sm" href={s.inviteUrl} target="_blank" rel="noreferrer">
                    Add the bot to a server
                  </a>
                ) : null}
              </div>
            </div>
            <div className="panel-row field">
              <span className="label">4. Link your account</span>
              {s.linked ? (
                <div className="row-actions">
                  <span className="hint">Your Discord account is linked.</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(() => api("/settings/discord/link", { method: "DELETE" }), "Unlinked.")}>
                    Unlink
                  </button>
                </div>
              ) : code ? (
                <>
                  <p className="hint">Run this in Discord within ten minutes:</p>
                  <CopyText value={`/cloudly link code:${code}`} label="Link command" />
                </>
              ) : (
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={!configured}
                    onClick={() => api<{ code: string }>("/settings/discord/link-code", { method: "POST" }).then((r) => setCode(r.code)).catch(() => setMessage({ ok: false, text: "Couldn't make a code." }))}
                  >
                    Make a link code
                  </button>
                </div>
              )}
            </div>
            <div className="panel-row form-foot">
              <span className="msg" role="status" data-tone={message ? (message.ok ? "ok" : "danger") : undefined}>
                {message?.text ?? (configured ? "Set up." : "Nothing is sent to Discord until this is set up.")}
              </span>
              <button type="submit" className="btn btn-primary" disabled={busy || !appId.trim() || !publicKey.trim() || (!s.botTokenSet && !token.trim())}>
                Save
              </button>
            </div>
          </form>
        ) : (
          <div className="skeleton" style={{ width: "40%" }} />
        )}
      </div>
    </section>
  );
}

/** Where and when you hear from Cloudly. */
export function NotificationSettings() {
  const [n, setN] = useState<NotifyStatus | null>(null);
  const [discordHook, setDiscordHook] = useState("");
  const [slackHook, setSlackHook] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<NotifyStatus>("/settings/notifications").then(setN).catch((e: Error) => setMessage({ ok: false, text: e.message }));
  useEffect(() => {
    load();
  }, []);

  async function save(body: Record<string, unknown>, ok = "Saved.") {
    setBusy(true);
    setMessage(null);
    try {
      await api("/settings/notifications", { method: "PUT", body: JSON.stringify(body) });
      setMessage({ ok: true, text: ok });
      setDiscordHook("");
      setSlackHook("");
      await load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Couldn't save." });
    } finally {
      setBusy(false);
    }
  }

  const toggle = (key: keyof NotifyStatus, label: string, hint: string) => (
    <label className="check-row">
      <input type="checkbox" checked={Boolean(n?.[key])} onChange={(e) => save({ [key]: e.target.checked })} disabled={busy} />
      <span>
        <b>{label}</b> <span className="dim">{hint}</span>
      </span>
    </label>
  );

  return (
    <section className="set-sec" aria-labelledby="notifications-h" id="notifications">
      <header>
        <h2 id="notifications-h">Notifications</h2>
        <p>Hear about a session when it settles: once its last automatic turn (fixes, reviews) is done, not for every step.</p>
      </header>
      <div className="set-body">
        {n ? (
          <div className="panel">
            <div className="panel-row trigger-list">
              {toggle("onNeedsYou", "Needs you.", "A question from the agent, conflicts, or fixes that ran out.")}
              {toggle("onDone", "Done.", "The session finished, with what the agent said and what changed.")}
              {toggle("onFailed", "Failed.", "A turn failed.")}
              {toggle("onMerged", "Merged.", "Merge when ready merged the pull request.")}
            </div>
            <div className="panel-row trigger-list">
              {toggle("discordDm", "Discord DMs.", "From the bot, once your account is linked under Discord. Sessions started from Discord post in their own thread instead.")}
              {toggle("slackDm", "Slack DMs.", "From the Slack app, once your account is linked under Slack. Sessions started from Slack post in their own thread instead.")}
            </div>
            <form
              className="panel-row field"
              onSubmit={(e) => {
                e.preventDefault();
                save({ discordWebhookUrl: discordHook.trim() }, "Discord webhook saved.");
              }}
            >
              <label className="label" htmlFor="nt-discord">
                Discord channel webhook
              </label>
              <div className="row-actions">
                <input
                  id="nt-discord"
                  className="input mono"
                  value={discordHook}
                  onChange={(e) => setDiscordHook(e.target.value)}
                  placeholder={n.discordWebhook ?? "https://discord.com/api/webhooks/…"}
                  autoComplete="off"
                />
                <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !discordHook.trim()}>
                  Save
                </button>
                {n.discordWebhook ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => save({ discordWebhookUrl: "" }, "Removed.")}>
                    Remove
                  </button>
                ) : null}
              </div>
              <p className="hint">For a team channel: Channel settings, Integrations, Webhooks, New Webhook, Copy URL. No bot needed.</p>
            </form>
            <form
              className="panel-row field"
              onSubmit={(e) => {
                e.preventDefault();
                save({ slackWebhookUrl: slackHook.trim() }, "Slack webhook saved.");
              }}
            >
              <label className="label" htmlFor="nt-slack">
                Slack incoming webhook
              </label>
              <div className="row-actions">
                <input
                  id="nt-slack"
                  className="input mono"
                  value={slackHook}
                  onChange={(e) => setSlackHook(e.target.value)}
                  placeholder={n.slackWebhook ?? "https://hooks.slack.com/services/…"}
                  autoComplete="off"
                />
                <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !slackHook.trim()}>
                  Save
                </button>
                {n.slackWebhook ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => save({ slackWebhookUrl: "" }, "Removed.")}>
                    Remove
                  </button>
                ) : null}
              </div>
              <p className="hint">Make one with a Slack app&apos;s Incoming Webhooks. The URLs are stored encrypted.</p>
            </form>
            <div className="panel-row form-foot">
              <span className="msg" role="status" data-tone={message ? (message.ok ? "ok" : "danger") : undefined}>
                {message?.text ?? ""}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() =>
                  api("/settings/notifications/test", { method: "POST" })
                    .then(() => setMessage({ ok: true, text: "Sent a test to everywhere that's set up. It arrives within seconds." }))
                    .catch(() => setMessage({ ok: false, text: "Couldn't send a test." }))
                }
              >
                Send a test
              </button>
            </div>
          </div>
        ) : (
          <div className="skeleton" style={{ width: "40%" }} />
        )}
      </div>
    </section>
  );
}

interface SlackStatus {
  signingSecretSet: boolean;
  botTokenSet: boolean;
  commandsUrl: string;
  interactionsUrl: string;
  manifest: object;
  linked: boolean;
}

/** The Slack app: made from a manifest, then its secret and token pasted here. */
export function SlackSettings() {
  const [s, setS] = useState<SlackStatus | null>(null);
  const [signing, setSigning] = useState("");
  const [token, setToken] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<SlackStatus>("/settings/slack").then(setS).catch((e: Error) => setMessage({ ok: false, text: e.message }));
  useEffect(() => {
    load();
  }, []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text: ok });
      await load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Something went wrong." });
    } finally {
      setBusy(false);
    }
  };
  const configured = Boolean(s?.signingSecretSet && s.botTokenSet);

  return (
    <section className="set-sec" aria-labelledby="slack-h" id="slack">
      <header>
        <h2 id="slack-h">Slack</h2>
        <p>
          The same as the Discord bot, in Slack: <code className="mono">/cloudly fix the flaky test repo:owner/repo</code> starts a session, and its updates go in a thread with Reply and
          Cancel buttons.
        </p>
      </header>
      <div className="set-body">
        {s ? (
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () =>
                  api("/settings/slack", { method: "PUT", body: JSON.stringify({ signingSecret: signing.trim() || undefined, botToken: token.trim() || undefined }) }).then(() => {
                    setSigning("");
                    setToken("");
                  }),
                "Saved.",
              );
            }}
          >
            <div className="panel-row field">
              <span className="label">1. Make the Slack app from this manifest</span>
              <p className="hint">
                At{" "}
                <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer">
                  api.slack.com/apps
                </a>
                , choose From a manifest, pick your workspace, and paste this. It has Cloudly&apos;s addresses filled in. Then Install to Workspace.
              </p>
              <CopyText value={JSON.stringify(s.manifest)} label="Slack app manifest" />
            </div>
            <div className="panel-row checks-grid">
              <div className="field">
                <label className="label" htmlFor="sl-signing">
                  Signing secret
                </label>
                <input
                  id="sl-signing"
                  className="input mono"
                  type="password"
                  value={signing}
                  onChange={(e) => setSigning(e.target.value)}
                  placeholder={s.signingSecretSet ? "Saved" : "From Basic Information"}
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="sl-token">
                  Bot token
                </label>
                <input
                  id="sl-token"
                  className="input mono"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={s.botTokenSet ? "Saved" : "xoxb-…"}
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="panel-row field">
              <span className="label">2. Link your account</span>
              {s.linked ? (
                <div className="row-actions">
                  <span className="hint">Your Slack account is linked.</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(() => api("/settings/slack/link", { method: "DELETE" }), "Unlinked.")}>
                    Unlink
                  </button>
                </div>
              ) : code ? (
                <>
                  <p className="hint">Run this in Slack within ten minutes:</p>
                  <CopyText value={`/cloudly link ${code}`} label="Link command" />
                </>
              ) : (
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={!configured}
                    onClick={() => api<{ code: string }>("/settings/slack/link-code", { method: "POST" }).then((r) => setCode(r.code)).catch(() => setMessage({ ok: false, text: "Couldn't make a code." }))}
                  >
                    Make a link code
                  </button>
                </div>
              )}
            </div>
            <div className="panel-row form-foot">
              <span className="msg" role="status" data-tone={message ? (message.ok ? "ok" : "danger") : undefined}>
                {message?.text ?? (configured ? "Set up." : "Nothing is sent to Slack until this is set up.")}
              </span>
              <button type="submit" className="btn btn-primary" disabled={busy || (!signing.trim() && !token.trim())}>
                Save
              </button>
            </div>
          </form>
        ) : (
          <div className="skeleton" style={{ width: "40%" }} />
        )}
      </div>
    </section>
  );
}
