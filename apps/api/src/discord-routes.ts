import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma, config, setSetting, deleteSetting, budgetStatus, harnessUsesPlan, seal, unseal } from "@repo/db";
import {
  verifyDiscordSignature, discordApi, inviteUrl, COMMANDS, sessionMessage, DISCORD_WEBHOOK, SLACK_WEBHOOK,
  PING, APPLICATION_COMMAND, MESSAGE_COMPONENT, AUTOCOMPLETE, MODAL_SUBMIT, PONG, CHANNEL_MESSAGE, AUTOCOMPLETE_RESULT, MODAL, EPHEMERAL,
} from "@repo/shared/discord";
import type { AuthEnv } from "./middleware/auth_middleware";
import { listInstallationRepos, type InstallationRepo } from "./github";
import { threadTitle } from "./harnesses";

// Discord: slash commands, buttons and modals arrive here as signed HTTP
// interactions. Everything they do is a database write (a session, a turn, a
// cancel), so it answers inside Discord's three seconds; the worker posts the
// updates afterwards (notify.ts there). Only Discord accounts linked to a
// Cloudly user can do anything.

const ACTIVE = ["queued", "running", "finalizing"];
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HARNESSES = ["native-claude", "native-codex", "gemini-acp"];

export function webOrigin() {
  return (process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
}
export function interactionsUrl() {
  const api = (process.env.API_ORIGIN ?? `${webOrigin()}/api`).replace(/\/$/, "");
  return `${api}/discord/interactions`;
}
export const sessionUrl = (id: string) => `${webOrigin()}/app/s/${id}`;

// The repos the GitHub App can see, for autocomplete and default branches.
// Cached, and given up on quickly: Discord waits three seconds at most.
let repoCache: { at: number; repos: InstallationRepo[] } | null = null;
let lister: () => Promise<InstallationRepo[]> = listInstallationRepos;
/** For tests. */
export function setRepoLister(fn: () => Promise<InstallationRepo[]>) {
  lister = fn;
  repoCache = null;
}
export async function knownRepos(): Promise<InstallationRepo[]> {
  if (repoCache && Date.now() - repoCache.at < 5 * 60_000) return repoCache.repos;
  try {
    const repos = await Promise.race([lister(), new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), 1500))]);
    repoCache = { at: Date.now(), repos };
    return repos;
  } catch {
    return repoCache?.repos ?? [];
  }
}

type Interaction = {
  type: number;
  id: string;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: { name?: string; options?: Option[]; custom_id?: string; components?: { components: { custom_id: string; value: string }[] }[] };
};
type DiscordUser = { id: string; username: string; global_name?: string | null };
type Option = { name: string; type: number; value?: string; focused?: boolean; options?: Option[] };

const say = (content: string, ephemeral = true) => ({ type: CHANNEL_MESSAGE, data: { content, flags: ephemeral ? EPHEMERAL : 0, allowed_mentions: { parse: [] } } });
const NOT_LINKED = "Link your Discord account first: in Cloudly, open Settings > Discord, make a code, then run `/cloudly link` with it.";

/** Starts a turn in a session, or says why it can't. */
export async function queueTurn(thread: { id: string; repo: string; baseBranch: string; harness: string; userId: string }, prompt: string, by: string, via: "discord" | "slack" = "discord") {
  if (await prisma.run.count({ where: { threadId: thread.id, status: { in: ACTIVE as never } } })) return "The agent is still working. Reply again once this turn ends, or cancel it.";
  const budget = await budgetStatus(thread.userId);
  if (budget.state === "storm" && !(await harnessUsesPlan(thread.harness))) return "Your monthly spend limit is reached. Raise it in Cloudly's settings to continue.";
  await prisma.run.create({
    data: {
      repo: thread.repo, baseBranch: thread.baseBranch, harness: thread.harness, userId: thread.userId, threadId: thread.id,
      status: "queued", prompt, trigger: { type: via, by } as never,
    },
  });
  await prisma.thread.update({ where: { id: thread.id }, data: { updatedAt: new Date(), settledAt: null, snoozedUntil: null, archivedAt: null, needsInput: null } });
  return null;
}

async function onCommand(i: Interaction, discordUser: DiscordUser) {
  const sub = i.data?.options?.[0];
  const opt = (name: string) => sub?.options?.find((o) => o.name === name)?.value?.trim() || undefined;

  if (sub?.name === "link") {
    const code = (opt("code") ?? "").toUpperCase();
    const row = await prisma.discordLinkCode.findUnique({ where: { code } });
    if (!row || row.provider !== "discord" || row.expiresAt < new Date()) return say("That code isn't valid any more. Make a new one under Settings > Discord.");
    await prisma.$transaction([
      prisma.user.updateMany({ where: { discordUserId: discordUser.id }, data: { discordUserId: null } }),
      prisma.user.update({ where: { id: row.userId }, data: { discordUserId: discordUser.id } }),
      prisma.discordLinkCode.deleteMany({ where: { userId: row.userId, provider: "discord" } }),
    ]);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: row.userId } });
    return say(`Linked to **${user.login}** on Cloudly. Try \`/cloudly task\`.`);
  }

  const user = await prisma.user.findUnique({ where: { discordUserId: discordUser.id } });
  if (!user) return say(NOT_LINKED);

  if (sub?.name === "status") {
    const threads = await prisma.thread.findMany({
      where: { userId: user.id, archivedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 8,
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } } },
    });
    if (threads.length === 0) return say("No sessions yet. Start one with `/cloudly task`.");
    const line = (t: (typeof threads)[number]) => {
      const s = t.mergedAt ? "merged" : t.needsInput ? "needs you" : t.runs[0]?.status ?? "queued";
      return `• [${t.title.replace(/[[\]]/g, "")}](${sessionUrl(t.id)}) · ${t.repo} · ${s}`;
    };
    return say(threads.map(line).join("\n"));
  }

  if (sub?.name === "repo") {
    const repo = opt("repo") ?? "";
    if (!SLUG.test(repo)) return say("Give the repository as owner/repo.");
    const repos = await knownRepos();
    if (repos.length && !repos.some((r) => r.fullName === repo)) return say(`Cloudly's GitHub App can't see ${repo}. Add it to the app's installation on GitHub first.`);
    if (!i.channel_id) return say("Run this in a channel.");
    await prisma.discordChannel.upsert({ where: { channelId: i.channel_id }, update: { repo }, create: { channelId: i.channel_id, repo } });
    return say(`\`/cloudly task\` in this channel now works on **${repo}** unless you name another.`, false);
  }

  if (sub?.name === "task") {
    const prompt = opt("prompt") ?? "";
    if (!prompt) return say("Say what the agent should do.");
    const channelDefault = i.channel_id ? await prisma.discordChannel.findUnique({ where: { channelId: i.channel_id } }) : null;
    const repo = opt("repo") ?? channelDefault?.repo;
    if (!repo) return say("Which repository? Add `repo:owner/repo`, or set this channel's default with `/cloudly repo`.");
    if (!SLUG.test(repo)) return say("Give the repository as owner/repo.");
    const repos = await knownRepos();
    const known = repos.find((r) => r.fullName === repo);
    if (repos.length && !known) return say(`Cloudly's GitHub App can't see ${repo}. Add it to the app's installation on GitHub first.`);
    const settings = await prisma.repoSettings.findUnique({ where: { repo } });
    const agent = opt("agent");
    const harness = agent && HARNESSES.includes(agent) ? agent : settings?.triggerHarness ?? "native-claude";
    const budget = await budgetStatus(user.id);
    if (budget.state === "storm" && !(await harnessUsesPlan(harness))) return say("Your monthly spend limit is reached. Raise it in Cloudly's settings to start sessions.");
    const baseBranch = opt("branch") ?? channelDefault?.baseBranch ?? known?.defaultBranch ?? "main";
    const id = crypto.randomUUID();
    const title = threadTitle(prompt);
    await prisma.thread.create({
      data: {
        id, userId: user.id, repo, baseBranch, harness, title,
        branch: `agent/thread-${id.slice(0, 8)}`,
        autoMerge: settings?.autoMerge ?? false,
        discordChannelId: i.channel_id ?? null,
        // Kept until the worker has made the session's Discord thread on this reply.
        discordToken: i.token,
        runs: { create: { repo, baseBranch, harness, userId: user.id, status: "queued", prompt, trigger: { type: "discord", by: discordUser.username } as never } },
      },
    });
    const msg = sessionMessage({ kind: "started", title, body: prompt, url: sessionUrl(id), repo }, id, { reply: false, cancel: true });
    return { type: CHANNEL_MESSAGE, data: msg };
  }
  return say("Unknown command.");
}

async function onButton(i: Interaction, discordUser: DiscordUser) {
  const [action, threadId] = (i.data?.custom_id ?? "").split(":");
  const user = await prisma.user.findUnique({ where: { discordUserId: discordUser.id } });
  if (!user) return say(NOT_LINKED);
  const thread = threadId ? await prisma.thread.findFirst({ where: { id: threadId, userId: user.id } }) : null;
  if (!thread) return say("That session isn't yours, or it's gone.");

  if (action === "reply") {
    return {
      type: MODAL,
      data: {
        custom_id: `reply:${thread.id}`,
        title: "Reply to the agent",
        components: [{ type: 1, components: [{ type: 4, custom_id: "text", label: "Message", style: 2, min_length: 1, max_length: 4000, required: true }] }],
      },
    };
  }
  if (action === "cancel") {
    const run = await prisma.run.findFirst({ where: { threadId: thread.id, status: { in: ACTIVE as never } }, orderBy: { createdAt: "desc" } });
    if (!run) return say("Nothing is running.");
    await prisma.run.update({ where: { id: run.id }, data: run.status === "queued" ? { cancelRequested: true, status: "cancelled" } : { cancelRequested: true } });
    return say("Cancelling the current turn. The work it finished is kept.", false);
  }
  return say("Unknown button.");
}

async function onModal(i: Interaction, discordUser: DiscordUser) {
  const [action, threadId] = (i.data?.custom_id ?? "").split(":");
  const user = await prisma.user.findUnique({ where: { discordUserId: discordUser.id } });
  if (!user) return say(NOT_LINKED);
  const thread = threadId ? await prisma.thread.findFirst({ where: { id: threadId, userId: user.id } }) : null;
  if (action !== "reply" || !thread) return say("That session isn't yours, or it's gone.");
  const text = i.data?.components?.flatMap((r) => r.components).find((c) => c.custom_id === "text")?.value?.trim() ?? "";
  if (!text) return say("Write something to send.");
  const problem = await queueTurn(thread, text, discordUser.username);
  if (problem) return say(problem);
  const name = discordUser.global_name || discordUser.username;
  return say(`**${name}:** ${text.length > 1800 ? `${text.slice(0, 1800)}…` : text}`, false);
}

async function onAutocomplete(i: Interaction) {
  const focused = i.data?.options?.[0]?.options?.find((o) => o.focused);
  const q = String(focused?.value ?? "").toLowerCase();
  const repos = (await knownRepos()).filter((r) => r.fullName.toLowerCase().includes(q)).slice(0, 25);
  return { type: AUTOCOMPLETE_RESULT, data: { choices: repos.map((r) => ({ name: r.fullName, value: r.fullName })) } };
}

export const discord = new Hono();

discord.post("/interactions", async (c) => {
  const publicKey = await config("DISCORD_PUBLIC_KEY");
  if (!publicKey) return c.json({ message: "Discord isn't set up on this Cloudly." }, 503);
  const body = await c.req.text();
  if (body.length > 1024 * 1024) return c.json({ message: "Too large" }, 413);
  if (!verifyDiscordSignature(publicKey, c.req.header("x-signature-ed25519"), c.req.header("x-signature-timestamp"), body)) {
    return c.json({ message: "Bad signature" }, 401);
  }
  const i = JSON.parse(body) as Interaction;
  if (i.type === PING) return c.json({ type: PONG });
  const discordUser = i.member?.user ?? i.user;
  if (!discordUser) return c.json(say("Who are you?"));
  if (i.type === AUTOCOMPLETE) {
    // Only linked accounts see the repo names.
    const linked = await prisma.user.findUnique({ where: { discordUserId: discordUser.id }, select: { id: true } });
    return c.json(linked ? await onAutocomplete(i) : { type: AUTOCOMPLETE_RESULT, data: { choices: [] } });
  }
  if (i.type === APPLICATION_COMMAND) return c.json(await onCommand(i, discordUser));
  if (i.type === MESSAGE_COMPONENT) return c.json(await onButton(i, discordUser));
  if (i.type === MODAL_SUBMIT) return c.json(await onModal(i, discordUser));
  return c.json(say("Unsupported interaction."));
});

// ---------- Settings > Discord, and Settings > Notifications ----------

export const discordSettings = new Hono<AuthEnv>();

discordSettings.get("/discord", async (c) => {
  const [applicationId, publicKey, token, me] = await Promise.all([
    config("DISCORD_APPLICATION_ID"),
    config("DISCORD_PUBLIC_KEY"),
    config("DISCORD_BOT_TOKEN"),
    prisma.user.findUnique({ where: { id: c.get("user").id }, select: { discordUserId: true } }),
  ]);
  return c.json({
    applicationId: applicationId ?? null,
    publicKey: publicKey ?? null,
    botTokenSet: Boolean(token),
    interactionsUrl: interactionsUrl(),
    inviteUrl: applicationId ? inviteUrl(applicationId) : null,
    linked: Boolean(me?.discordUserId),
  });
});

discordSettings.put(
  "/discord",
  zValidator("json", z.object({
    applicationId: z.string().regex(/^\d{5,25}$/, "The application ID is a number."),
    publicKey: z.string().regex(/^[0-9a-fA-F]{64}$/, "The public key is 64 hex characters."),
    botToken: z.string().trim().min(20).max(200).optional(),
  })),
  async (c) => {
    const { applicationId, publicKey, botToken } = c.req.valid("json");
    await setSetting("DISCORD_APPLICATION_ID", applicationId);
    await setSetting("DISCORD_PUBLIC_KEY", publicKey.toLowerCase());
    if (botToken) await setSetting("DISCORD_BOT_TOKEN", botToken);
    return c.json({ ok: true });
  },
);

discordSettings.delete("/discord", async (c) => {
  for (const n of ["DISCORD_APPLICATION_ID", "DISCORD_PUBLIC_KEY", "DISCORD_BOT_TOKEN"]) await deleteSetting(n);
  return c.body(null, 204);
});

// Registers /cloudly with Discord (global commands can take a few minutes to show).
discordSettings.post("/discord/commands", async (c) => {
  const [applicationId, token] = await Promise.all([config("DISCORD_APPLICATION_ID"), config("DISCORD_BOT_TOKEN")]);
  if (!applicationId || !token) return c.json({ message: "Save the application ID and the bot token first." }, 400);
  try {
    await discordApi(token, "PUT", `/applications/${applicationId}/commands`, COMMANDS);
  } catch (err) {
    return c.json({ message: err instanceof Error ? err.message : "Discord refused the commands." }, 502);
  }
  return c.json({ ok: true });
});

// A one-time code for /cloudly link, good for ten minutes.
discordSettings.post("/discord/link-code", async (c) => {
  const userId = c.get("user").id;
  const code = randomBytes(5).toString("base64url").replace(/[-_]/g, "").slice(0, 6).toUpperCase().padEnd(6, "X");
  await prisma.discordLinkCode.deleteMany({ where: { userId, provider: "discord" } });
  await prisma.discordLinkCode.create({ data: { code, userId, provider: "discord", expiresAt: new Date(Date.now() + 10 * 60_000) } });
  return c.json({ code, command: `/cloudly link code:${code}` });
});

discordSettings.delete("/discord/link", async (c) => {
  await prisma.user.update({ where: { id: c.get("user").id }, data: { discordUserId: null } });
  return c.body(null, 204);
});

const mask = (url: string | null) => (url ? `${url.slice(0, url.indexOf("/", 8) + 1)}…${url.slice(-4)}` : null);

discordSettings.get("/notifications", async (c) => {
  const s = await prisma.notifySettings.findUnique({ where: { userId: c.get("user").id } });
  return c.json({
    discordDm: s?.discordDm ?? true,
    slackDm: s?.slackDm ?? true,
    discordWebhook: mask(await unseal(s?.discordWebhookUrl)),
    slackWebhook: mask(await unseal(s?.slackWebhookUrl)),
    onNeedsYou: s?.onNeedsYou ?? true,
    onDone: s?.onDone ?? true,
    onFailed: s?.onFailed ?? true,
    onMerged: s?.onMerged ?? true,
  });
});

discordSettings.put(
  "/notifications",
  zValidator("json", z.object({
    discordDm: z.boolean().optional(),
    slackDm: z.boolean().optional(),
    // A URL sets it, "" clears it, left out keeps it.
    discordWebhookUrl: z.union([z.literal(""), z.string().trim().regex(DISCORD_WEBHOOK, "That isn't a Discord webhook URL.")]).optional(),
    slackWebhookUrl: z.union([z.literal(""), z.string().trim().regex(SLACK_WEBHOOK, "That isn't a Slack incoming webhook URL.")]).optional(),
    onNeedsYou: z.boolean().optional(),
    onDone: z.boolean().optional(),
    onFailed: z.boolean().optional(),
    onMerged: z.boolean().optional(),
  })),
  async (c) => {
    const userId = c.get("user").id;
    const { discordWebhookUrl, slackWebhookUrl, ...flags } = c.req.valid("json");
    const data = {
      ...flags,
      ...(discordWebhookUrl !== undefined ? { discordWebhookUrl: discordWebhookUrl ? await seal(discordWebhookUrl) : null } : {}),
      ...(slackWebhookUrl !== undefined ? { slackWebhookUrl: slackWebhookUrl ? await seal(slackWebhookUrl) : null } : {}),
    };
    await prisma.notifySettings.upsert({ where: { userId }, update: data, create: { userId, ...data } });
    return c.json({ ok: true });
  },
);

// Sends a test notification everywhere it's set up (the worker sends it within seconds).
discordSettings.post("/notifications/test", async (c) => {
  const userId = c.get("user").id;
  await prisma.notification.create({
    data: { userId, kind: "test", title: "Notifications work", body: "This is how Cloudly will tell you when a session needs you, finishes, fails or merges.", url: `${webOrigin()}/app/settings#notifications`, key: `test:${userId}:${Date.now()}` },
  });
  return c.json({ ok: true });
});
