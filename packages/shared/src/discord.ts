import { createPublicKey, verify } from "node:crypto";

// Discord, over HTTP only: Discord POSTs signed interactions (slash commands,
// buttons, modals) to Cloudly, and Cloudly calls Discord's REST API with the
// bot token. No gateway connection, and no privileged intents: the bot never
// reads messages, so replies go through a button and a modal.

export const DISCORD_API = "https://discord.com/api/v10";

// Interaction and response types (discord.com/developers/docs/interactions).
export const PING = 1, APPLICATION_COMMAND = 2, MESSAGE_COMPONENT = 3, AUTOCOMPLETE = 4, MODAL_SUBMIT = 5;
export const PONG = 1, CHANNEL_MESSAGE = 4, AUTOCOMPLETE_RESULT = 8, MODAL = 9;
export const EPHEMERAL = 64;

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** Discord signs timestamp + body with the application's Ed25519 key. */
export function verifyDiscordSignature(publicKeyHex: string, signatureHex: string | undefined, timestamp: string | undefined, body: string): boolean {
  if (!signatureHex || !timestamp || !/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(timestamp + body), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/** A call to Discord's REST API as the bot. Waits out one rate limit. */
export async function discordApi<T = unknown>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${DISCORD_API}${path}`, {
      method,
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "Cloudly (https://github.com/AymanKhan9/Cloudly, 1)" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt === 0) {
      const wait = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 1);
      await new Promise((r) => setTimeout(r, Math.min(10, wait) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Discord ${method} ${path.replace(/\/[\w-]{40,}/g, "/…")}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}

// What the bot may do in a server: send messages and embeds, make and post in
// threads, read history (to reply in a thread). Nothing else.
export const BOT_PERMISSIONS = (2048n + 16384n + 65536n + 34359738368n + 274877906944n).toString();

export function inviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`;
}

const AGENT_CHOICES = [
  { name: "Claude Agent", value: "native-claude" },
  { name: "Codex", value: "native-codex" },
  { name: "Gemini CLI", value: "gemini-acp" },
];

/** The /cloudly command and its subcommands, registered with Settings > Discord. */
export const COMMANDS = [
  {
    name: "cloudly",
    description: "Run a coding agent on one of your repositories",
    contexts: [0, 1, 2],
    integration_types: [0],
    options: [
      {
        type: 1, name: "task", description: "Start a session: the agent works on it and opens a pull request",
        options: [
          { type: 3, name: "prompt", description: "What should the agent do?", required: true, max_length: 4000 },
          { type: 3, name: "repo", description: "owner/repo (the channel's default if left out)", autocomplete: true },
          { type: 3, name: "agent", description: "Which agent", choices: AGENT_CHOICES },
          { type: 3, name: "branch", description: "Branch to build on (the repo's default if left out)" },
        ],
      },
      {
        type: 1, name: "repo", description: "Set this channel's default repository",
        options: [{ type: 3, name: "repo", description: "owner/repo", required: true, autocomplete: true }],
      },
      { type: 1, name: "status", description: "Your recent sessions" },
      {
        type: 1, name: "link", description: "Link your Discord account to Cloudly",
        options: [{ type: 3, name: "code", description: "The code from Settings > Discord in Cloudly", required: true, max_length: 20 }],
      },
    ],
  },
];

export const COLORS = { started: 0xe9561c, done: 0x1d8049, needs_you: 0xc48714, failed: 0xc8302a, merged: 0x8250df, test: 0x4f5866 } as const;
export type NotifyKind = keyof typeof COLORS;

export const KIND_LABEL: Record<NotifyKind, string> = {
  started: "Started",
  done: "Done",
  needs_you: "Needs you",
  failed: "Failed",
  merged: "Merged",
  test: "Test",
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface SessionMessage {
  kind: NotifyKind;
  title: string;
  body: string;
  url?: string | null;
  prUrl?: string | null;
  repo?: string | null;
}

/** An embed for a session update. */
export function sessionEmbed(m: SessionMessage) {
  return {
    title: clip(`${KIND_LABEL[m.kind]}: ${m.title}`, 256),
    url: m.url ?? undefined,
    description: clip(m.body || " ", 3500),
    color: COLORS[m.kind],
    fields: m.prUrl ? [{ name: "Pull request", value: m.prUrl, inline: false }] : [],
    footer: m.repo ? { text: m.repo } : undefined,
  };
}

/** Buttons under a session update: reply (a modal), cancel the turn, and open it in Cloudly. */
export function sessionButtons(threadId: string, url: string | null | undefined, opts: { reply?: boolean; cancel?: boolean } = {}) {
  const buttons: object[] = [];
  if (opts.reply !== false) buttons.push({ type: 2, style: 1, label: "Reply", custom_id: `reply:${threadId}` });
  if (opts.cancel) buttons.push({ type: 2, style: 4, label: "Cancel turn", custom_id: `cancel:${threadId}` });
  if (url && /^https?:\/\//.test(url)) buttons.push({ type: 2, style: 5, label: "Open in Cloudly", url });
  return buttons.length ? [{ type: 1, components: buttons }] : [];
}

/** A whole bot message for a session update. Mentions in agent text never ping anyone. */
export function sessionMessage(m: SessionMessage, threadId: string | null, buttons: { reply?: boolean; cancel?: boolean } = {}) {
  return {
    embeds: [sessionEmbed(m)],
    components: threadId ? sessionButtons(threadId, m.url, buttons) : [],
    allowed_mentions: { parse: [] },
  };
}

/** Webhook URLs a notification may be sent to. Anything else is refused, so a URL can't point the worker at another host. */
export const DISCORD_WEBHOOK = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,200}$/;
export const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+$/;

const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The same update for a Slack incoming webhook. */
export function slackMessage(m: SessionMessage) {
  const head = `*${slackEscape(KIND_LABEL[m.kind])}: ${slackEscape(m.title)}*`;
  const links = [m.url ? `<${m.url}|Open in Cloudly>` : "", m.prUrl ? `<${m.prUrl}|Pull request>` : ""].filter(Boolean).join("  ·  ");
  const text = [head, slackEscape(clip(m.body, 2500)), links].filter(Boolean).join("\n");
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}
