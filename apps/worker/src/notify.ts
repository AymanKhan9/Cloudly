import { prisma, config, unseal } from "@repo/db";
import { discordApi, sessionMessage, slackMessage, DISCORD_WEBHOOK, SLACK_WEBHOOK, type NotifyKind } from "@repo/shared/discord";
import { slackApi, slackBlocks } from "@repo/shared/slack";
import { replyText } from "./transcript";
import { pause } from "./pause";

// Notifications: when a session settles (its last automatic turn is done), needs
// the user, fails or merges, a Notification row is written; the loop below
// sends it. A session started from Discord gets its updates in its own Discord
// thread. Each user can also have them as Discord DMs, in a Discord channel
// through a webhook, or in Slack through an incoming webhook.

const ACTIVE = ["queued", "running", "finalizing"];
const MAX_ATTEMPTS = 5;
/** Discord's interaction tokens last 15 minutes. */
const TOKEN_LIFE_MS = 14 * 60_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function sessionUrl(threadId: string): string | null {
  const web = process.env.WEB_ORIGIN?.replace(/\/$/, "");
  return web ? `${web}/app/s/${threadId}` : null;
}

/** Writes a notification once per key. */
export async function notify(n: { userId: string; threadId?: string | null; kind: NotifyKind; title: string; body: string; key: string }): Promise<void> {
  try {
    await prisma.notification.create({ data: { ...n, threadId: n.threadId ?? null, url: n.threadId ? sessionUrl(n.threadId) : null } });
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
  }
}

/**
 * After a turn ends: a notification, unless another turn is already queued in
 * the session (a fix, a review), so a chain of automatic turns is one message.
 */
export async function notifyTurnEnd(runId: string): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { thread: true, events: { where: { kind: "text" }, orderBy: { seq: "asc" }, select: { data: true } } },
  });
  const thread = run?.thread;
  if (!run || !thread || !thread.userId) return;
  if (!["succeeded", "failed"].includes(run.status)) return;
  if (await prisma.run.count({ where: { threadId: thread.id, status: { in: ACTIVE as never } } })) return;

  let kind: NotifyKind;
  let body: string;
  if (thread.needsInput) {
    kind = "needs_you";
    body = thread.needsInput;
  } else if (run.status === "failed") {
    kind = "failed";
    body = run.error ?? "The turn failed.";
  } else {
    kind = "done";
    const said = (run.kind === "review" || run.kind === "audit") && run.output ? run.output : replyText(run.events, run.harness);
    const stats = run.filesChanged ? `\n\n${run.filesChanged} file${run.filesChanged === 1 ? "" : "s"} changed, +${run.additions ?? 0} −${run.deletions ?? 0}.` : "";
    body = clip(said || "Done.", 1500) + stats;
  }
  await notify({ userId: thread.userId, threadId: thread.id, kind, title: thread.title, body, key: `turn:${run.id}` });
}

/** How notifications leave the worker. Tests stand in for both. */
export interface NotifyPort {
  discord(method: string, path: string, body?: unknown): Promise<any>;
  webhook(url: string, body: unknown): Promise<void>;
  slack(method: string, body: Record<string, unknown>): Promise<any>;
}

async function realPort(): Promise<NotifyPort | null> {
  const token = await config("DISCORD_BOT_TOKEN");
  const slackToken = await config("SLACK_BOT_TOKEN");
  return {
    slack: (method, body) => {
      if (!slackToken) throw new Error("No Slack bot token");
      return slackApi(slackToken, method, body);
    },
    discord: (method, path, body) => {
      if (!token) throw new Error("No Discord bot token");
      return discordApi(token, method, path, body);
    },
    async webhook(url, body) {
      // Only Discord and Slack webhook URLs were accepted when saved; check again before sending.
      if (!DISCORD_WEBHOOK.test(url) && !SLACK_WEBHOOK.test(url)) throw new Error("Not a Discord or Slack webhook URL");
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}

/** Makes the Discord thread for each session started from Discord, on the bot's first reply. */
export async function setupDiscordThreads(port: NotifyPort, now = Date.now()): Promise<number> {
  const waiting = await prisma.thread.findMany({ where: { discordToken: { not: null } }, orderBy: { createdAt: "asc" }, take: 20 });
  if (waiting.length === 0) return 0;
  const appId = await config("DISCORD_APPLICATION_ID");
  for (const t of waiting) {
    let threadId: string | null = t.discordChannelId;
    if (appId && now - t.createdAt.getTime() < TOKEN_LIFE_MS && t.discordChannelId) {
      try {
        const original = await port.discord("GET", `/webhooks/${appId}/${t.discordToken}/messages/@original`);
        const made = await port.discord("POST", `/channels/${t.discordChannelId}/messages/${original.id}/threads`, { name: clip(t.title, 90), auto_archive_duration: 1440 });
        threadId = made.id;
      } catch (err) {
        // A DM, or no permission to make threads: updates go to the channel instead.
        console.warn(`[notify] no Discord thread for session ${t.id}: ${(err as Error).message}`);
      }
    }
    await prisma.thread.update({ where: { id: t.id }, data: { discordThreadId: threadId, discordToken: null } });
  }
  return waiting.length;
}

/** Posts the "Started" message for each session started from Slack; its updates are threaded under it. */
export async function setupSlackThreads(port: NotifyPort): Promise<number> {
  const waiting = await prisma.thread.findMany({ where: { slackChannelId: { not: null }, slackThreadTs: null }, orderBy: { createdAt: "asc" }, include: { runs: { orderBy: { createdAt: "asc" }, take: 1, select: { prompt: true } } }, take: 20 });
  for (const t of waiting) {
    let ts = "-";
    try {
      const posted = await port.slack("chat.postMessage", {
        channel: t.slackChannelId,
        ...slackBlocks({ kind: "started", title: t.title, body: clip(t.runs[0]?.prompt ?? "", 1500), url: sessionUrl(t.id), repo: t.repo }, t.id, { reply: false, cancel: true }),
      });
      ts = posted.ts;
    } catch (err) {
      // A channel the bot can't post in: updates go to the user's DMs instead.
      console.warn(`[notify] no Slack thread for session ${t.id}: ${(err as Error).message}`);
    }
    await prisma.thread.update({ where: { id: t.id }, data: { slackThreadTs: ts } });
  }
  return waiting.length;
}

const dmChannels = new Map<string, string>();

/** Sends every notification waiting. Returns how many it finished with. */
export async function sendNotifications(port: NotifyPort): Promise<number> {
  const pending = await prisma.notification.findMany({ where: { sentAt: null }, orderBy: { createdAt: "asc" }, take: 50 });
  if (pending.length === 0) return 0;
  const botReady = Boolean(await config("DISCORD_BOT_TOKEN"));
  const slackReady = Boolean(await config("SLACK_BOT_TOKEN"));
  let finished = 0;
  for (const n of pending) {
    const [user, settings, thread] = await Promise.all([
      prisma.user.findUnique({ where: { id: n.userId }, select: { discordUserId: true, slackUserId: true } }),
      prisma.notifySettings.findUnique({ where: { userId: n.userId } }),
      n.threadId ? prisma.thread.findUnique({ where: { id: n.threadId }, select: { id: true, repo: true, prUrl: true, discordThreadId: true, discordToken: true, slackChannelId: true, slackThreadTs: true } }) : null,
    ]);
    // Its Discord thread isn't made yet: next time round.
    if (thread?.discordToken || (thread?.slackChannelId && !thread.slackThreadTs)) continue;
    const slackThread = thread?.slackChannelId && thread.slackThreadTs && thread.slackThreadTs !== "-" ? { channel: thread.slackChannelId, ts: thread.slackThreadTs } : null;
    const wanted = n.kind === "test" || ({ needs_you: settings?.onNeedsYou, done: settings?.onDone, failed: settings?.onFailed, merged: settings?.onMerged } as Record<string, boolean | undefined>)[n.kind] !== false;
    const message = { kind: n.kind as NotifyKind, title: n.title, body: n.body, url: n.url, prUrl: thread?.prUrl ?? null, repo: thread?.repo ?? null };
    const discordBody = sessionMessage(message, thread?.id ?? null, { reply: n.kind !== "merged" });

    const targets: [string, () => Promise<void>][] = [];
    // The session's own Discord thread is its conversation: every update goes there.
    if (thread?.discordThreadId && botReady) targets.push(["discord-thread", () => port.discord("POST", `/channels/${thread.discordThreadId}/messages`, discordBody)]);
    const slackBody = slackBlocks(message, thread?.id ?? null, { reply: n.kind !== "merged" });
    if (slackThread && slackReady) targets.push(["slack-thread", () => port.slack("chat.postMessage", { channel: slackThread.channel, thread_ts: slackThread.ts, ...slackBody })]);
    if (wanted) {
      if ((settings?.discordDm ?? true) && user?.discordUserId && botReady && !thread?.discordThreadId) {
        targets.push(["discord-dm", async () => {
          let channel = dmChannels.get(user.discordUserId!);
          if (!channel) {
            channel = (await port.discord("POST", "/users/@me/channels", { recipient_id: user.discordUserId })).id as string;
            dmChannels.set(user.discordUserId!, channel);
          }
          await port.discord("POST", `/channels/${channel}/messages`, discordBody);
        }]);
      }
      if ((settings?.slackDm ?? true) && user?.slackUserId && slackReady && !slackThread) {
        targets.push(["slack-dm", async () => {
          const opened = await port.slack("conversations.open", { users: user.slackUserId });
          await port.slack("chat.postMessage", { channel: opened.channel.id, ...slackBody });
        }]);
      }
      const discordHook = await unseal(settings?.discordWebhookUrl);
      if (discordHook) targets.push(["discord-webhook", () => port.webhook(discordHook, { embeds: discordBody.embeds, allowed_mentions: { parse: [] }, username: "Cloudly" })]);
      const slackHook = await unseal(settings?.slackWebhookUrl);
      if (slackHook) targets.push(["slack", () => port.webhook(slackHook, slackMessage(message))]);
    }

    const sentTo = [...n.sentTo];
    const errors: string[] = [];
    for (const [name, send] of targets) {
      if (sentTo.includes(name)) continue;
      try {
        await send();
        sentTo.push(name);
      } catch (err) {
        errors.push(`${name}: ${(err as Error).message}`);
      }
    }
    const done = errors.length === 0 || n.attempts + 1 >= MAX_ATTEMPTS;
    await prisma.notification.update({
      where: { id: n.id },
      data: { sentTo, attempts: n.attempts + 1, error: errors.length ? errors.join("; ").slice(0, 500) : null, ...(done ? { sentAt: new Date() } : {}) },
    });
    if (done) finished++;
  }
  return finished;
}

export async function runNotifyLoop(signal: AbortSignal, intervalMs = 3000): Promise<void> {
  while (!signal.aborted) {
    try {
      const port = await realPort();
      if (port) {
        await setupDiscordThreads(port);
        if (await config("SLACK_BOT_TOKEN")) await setupSlackThreads(port);
        await sendNotifications(port);
      }
    } catch (err) {
      console.error("[notify] loop:", err);
    }
    await pause(intervalMs, signal);
  }
}
