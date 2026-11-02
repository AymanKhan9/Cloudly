import { createHmac, timingSafeEqual } from "node:crypto";
import { KIND_LABEL, type SessionMessage } from "./discord";

// Slack, over HTTP only, like the Discord bot: Slack POSTs signed slash
// commands and button presses to Cloudly, and Cloudly calls Slack's Web API
// with the bot token.

/** Slack signs "v0:<timestamp>:<body>" with the app's signing secret. Requests older than five minutes are refused. */
export function verifySlackSignature(secret: string, signature: string | undefined, timestamp: string | undefined, body: string, now = Date.now()): boolean {
  if (!signature?.startsWith("v0=") || !timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A Slack Web API call as the bot. Slack answers 200 with ok: false on errors. */
export async function slackApi<T = Record<string, unknown>>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error ?? "failed"}`);
  return data as T;
}

/** Text for Slack mrkdwn: &, < and > escaped, so nothing in it becomes a mention or a link. */
export const slackText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const AGENTS: Record<string, string> = { claude: "native-claude", codex: "native-codex", gemini: "gemini-acp", "native-claude": "native-claude", "native-codex": "native-codex", "gemini-acp": "gemini-acp" };

export type SlackCommand =
  | { kind: "task"; prompt: string; repo?: string; agent?: string; branch?: string }
  | { kind: "repo"; repo: string }
  | { kind: "status" }
  | { kind: "link"; code: string }
  | { kind: "help" };

/**
 * "/cloudly" text: "status", "repo owner/repo", "link CODE", "help", or a task
 * with optional repo:, agent: and branch: words anywhere in it.
 */
export function parseSlackCommand(text: string): SlackCommand {
  const t = text.trim();
  const [first, ...rest] = t.split(/\s+/);
  const word = (first ?? "").toLowerCase();
  if (!t || word === "help") return { kind: "help" };
  if (word === "status" && rest.length === 0) return { kind: "status" };
  if (word === "repo" && rest.length === 1) return { kind: "repo", repo: rest[0]! };
  if (word === "link" && rest.length === 1) return { kind: "link", code: rest[0]! };
  const body = word === "task" ? t.slice(first!.length).trim() : t;
  const out: { kind: "task"; prompt: string; repo?: string; agent?: string; branch?: string } = { kind: "task", prompt: "" };
  const prompt = body.replace(/(?:^|\s)(repo|agent|branch):(\S+)/gi, (_, key: string, value: string) => {
    const k = key.toLowerCase();
    if (k === "agent") out.agent = AGENTS[value.toLowerCase()] ?? value;
    else (out as Record<string, string>)[k] = value;
    return " ";
  });
  out.prompt = prompt.replace(/\s+/g, " ").trim();
  return out;
}

/** Blocks for a session update, with Reply, Cancel and Open buttons. */
export function slackBlocks(m: SessionMessage, threadId: string | null, buttons: { reply?: boolean; cancel?: boolean } = {}) {
  const head = `*${slackText(KIND_LABEL[m.kind])}: ${slackText(m.title)}*`;
  const blocks: object[] = [{ type: "section", text: { type: "mrkdwn", text: clip(`${head}\n${slackText(m.body || " ")}`, 2900) } }];
  const context = [m.repo ? slackText(m.repo) : "", m.prUrl ? `<${m.prUrl}|Pull request>` : ""].filter(Boolean).join("  ·  ");
  if (context) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: context }] });
  const elements: object[] = [];
  if (threadId && buttons.reply !== false) elements.push({ type: "button", action_id: "reply", value: threadId, text: { type: "plain_text", text: "Reply" }, style: "primary" });
  if (threadId && buttons.cancel) elements.push({ type: "button", action_id: "cancel", value: threadId, text: { type: "plain_text", text: "Cancel turn" }, style: "danger" });
  if (m.url && /^https?:\/\//.test(m.url)) elements.push({ type: "button", action_id: "open", url: m.url, text: { type: "plain_text", text: "Open in Cloudly" } });
  if (elements.length) blocks.push({ type: "actions", elements });
  return { text: `${KIND_LABEL[m.kind]}: ${m.title}`, blocks, unfurl_links: false, unfurl_media: false };
}

/** The modal Reply opens. */
export function replyModal(threadId: string, title: string) {
  return {
    type: "modal",
    callback_id: "reply",
    private_metadata: threadId,
    title: { type: "plain_text", text: "Reply to the agent" },
    submit: { type: "plain_text", text: "Send" },
    blocks: [
      { type: "context", elements: [{ type: "plain_text", text: clip(title, 150) }] },
      { type: "input", block_id: "message", label: { type: "plain_text", text: "Message" }, element: { type: "plain_text_input", action_id: "text", multiline: true, max_length: 3000 } },
    ],
  };
}

/** A Slack app manifest with Cloudly's URLs filled in, for "Create an app from a manifest". */
export function slackManifest(apiOrigin: string, name = "Cloudly") {
  return {
    display_information: { name, description: "Run coding agents on your repositories" },
    features: {
      bot_user: { display_name: name, always_online: true },
      slash_commands: [{ command: "/cloudly", url: `${apiOrigin}/slack/commands`, description: "Start a session, or: status, repo, link", usage_hint: "fix the flaky test repo:owner/repo", should_escape: false }],
    },
    oauth_config: { scopes: { bot: ["commands", "chat:write", "chat:write.public", "im:write"] } },
    settings: { interactivity: { is_enabled: true, request_url: `${apiOrigin}/slack/interactions` }, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}

export const SLACK_HELP = [
  "*Cloudly*",
  "`/cloudly <what to do> [repo:owner/repo] [agent:claude|codex|gemini] [branch:name]` starts a session",
  "`/cloudly repo owner/repo` sets this channel's default repository",
  "`/cloudly status` lists your recent sessions",
  "`/cloudly link CODE` links your Slack account (the code is under Settings > Slack in Cloudly)",
].join("\n");
