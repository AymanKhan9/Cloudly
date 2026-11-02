import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma, config, setSetting, deleteSetting, budgetStatus, harnessUsesPlan } from "@repo/db";
import { verifySlackSignature, slackApi, parseSlackCommand, replyModal, slackManifest, slackText, SLACK_HELP } from "@repo/shared/slack";
import type { AuthEnv } from "./middleware/auth_middleware";
import { knownRepos, queueTurn, sessionUrl, webOrigin } from "./discord-routes";
import { threadTitle } from "./harnesses";

// Slack: /cloudly and its buttons arrive here as signed HTTP requests, and
// answer inside Slack's three seconds. The worker posts each session's
// "Started" message and its updates in that message's thread (notify.ts).
// Only Slack accounts linked to a Cloudly user can do anything.

const ACTIVE = ["queued", "running", "finalizing"];
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HARNESSES = ["native-claude", "native-codex", "gemini-acp"];
const NOT_LINKED = "Link your Slack account first: in Cloudly, open Settings > Slack, make a code, then run `/cloudly link CODE`.";

export function slackUrls() {
  const api = (process.env.API_ORIGIN ?? `${webOrigin()}/api`).replace(/\/$/, "");
  return { api, commands: `${api}/slack/commands`, interactions: `${api}/slack/interactions` };
}

const ephemeral = (text: string) => ({ response_type: "ephemeral", text });

/** Reads and checks a Slack request; null when it isn't Slack's. */
async function verified(c: { req: { text: () => Promise<string>; header: (k: string) => string | undefined } }): Promise<URLSearchParams | null> {
  const secret = await config("SLACK_SIGNING_SECRET");
  if (!secret) return null;
  const body = await c.req.text();
  if (body.length > 1024 * 1024) return null;
  if (!verifySlackSignature(secret, c.req.header("x-slack-signature"), c.req.header("x-slack-request-timestamp"), body)) return null;
  return new URLSearchParams(body);
}

async function onCommand(form: URLSearchParams) {
  const slackUser = form.get("user_id") ?? "";
  const userName = form.get("user_name") ?? "someone";
  const channel = form.get("channel_id") ?? "";
  const cmd = parseSlackCommand(form.get("text") ?? "");

  if (cmd.kind === "help") return ephemeral(SLACK_HELP);
  if (cmd.kind === "link") {
    const row = await prisma.discordLinkCode.findUnique({ where: { code: cmd.code.toUpperCase() } });
    if (!row || row.provider !== "slack" || row.expiresAt < new Date()) return ephemeral("That code isn't valid any more. Make a new one under Settings > Slack.");
    await prisma.$transaction([
      prisma.user.updateMany({ where: { slackUserId: slackUser }, data: { slackUserId: null } }),
      prisma.user.update({ where: { id: row.userId }, data: { slackUserId: slackUser } }),
      prisma.discordLinkCode.deleteMany({ where: { userId: row.userId, provider: "slack" } }),
    ]);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: row.userId } });
    return ephemeral(`Linked to *${slackText(user.login)}* on Cloudly. Try \`/cloudly fix the flaky test repo:owner/repo\`.`);
  }

  const user = await prisma.user.findUnique({ where: { slackUserId: slackUser } });
  if (!user) return ephemeral(NOT_LINKED);

  if (cmd.kind === "status") {
    const threads = await prisma.thread.findMany({
      where: { userId: user.id, archivedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 8,
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } } },
    });
    if (threads.length === 0) return ephemeral("No sessions yet. Start one with `/cloudly <what to do>`.");
    return ephemeral(
      threads
        .map((t) => `• <${sessionUrl(t.id)}|${slackText(t.title)}> · ${slackText(t.repo)} · ${t.mergedAt ? "merged" : t.needsInput ? "needs you" : t.runs[0]?.status ?? "queued"}`)
        .join("\n"),
    );
  }

  if (cmd.kind === "repo") {
    if (!SLUG.test(cmd.repo)) return ephemeral("Give the repository as owner/repo.");
    const repos = await knownRepos();
    if (repos.length && !repos.some((r) => r.fullName === cmd.repo)) return ephemeral(`Cloudly's GitHub App can't see ${slackText(cmd.repo)}. Add it to the app's installation on GitHub first.`);
    await prisma.slackChannel.upsert({ where: { channelId: channel }, update: { repo: cmd.repo }, create: { channelId: channel, repo: cmd.repo } });
    return { response_type: "in_channel", text: `\`/cloudly\` in this channel now works on *${slackText(cmd.repo)}* unless you name another.` };
  }

  // A task.
  if (!cmd.prompt) return ephemeral("Say what the agent should do.");
  const channelDefault = channel ? await prisma.slackChannel.findUnique({ where: { channelId: channel } }) : null;
  const repo = cmd.repo ?? channelDefault?.repo;
  if (!repo) return ephemeral("Which repository? Add `repo:owner/repo`, or set this channel's default with `/cloudly repo owner/repo`.");
  if (!SLUG.test(repo)) return ephemeral("Give the repository as owner/repo.");
  const repos = await knownRepos();
  const known = repos.find((r) => r.fullName === repo);
  if (repos.length && !known) return ephemeral(`Cloudly's GitHub App can't see ${slackText(repo)}. Add it to the app's installation on GitHub first.`);
  const settings = await prisma.repoSettings.findUnique({ where: { repo } });
  const harness = cmd.agent && HARNESSES.includes(cmd.agent) ? cmd.agent : settings?.triggerHarness ?? "native-claude";
  const budget = await budgetStatus(user.id);
  if (budget.state === "storm" && !(await harnessUsesPlan(harness))) return ephemeral("Your monthly spend limit is reached. Raise it in Cloudly's settings to start sessions.");
  const baseBranch = cmd.branch ?? channelDefault?.baseBranch ?? known?.defaultBranch ?? "main";
  const id = crypto.randomUUID();
  await prisma.thread.create({
    data: {
      id, userId: user.id, repo, baseBranch, harness, title: threadTitle(cmd.prompt),
      branch: `agent/thread-${id.slice(0, 8)}`,
      autoMerge: settings?.autoMerge ?? false,
      // The worker posts the "Started" message here, and threads the updates under it.
      slackChannelId: channel || null,
      runs: { create: { repo, baseBranch, harness, userId: user.id, status: "queued", prompt: cmd.prompt, trigger: { type: "slack", by: userName } as never } },
    },
  });
  return ephemeral(`Starting on *${slackText(repo)}*. Updates go in a thread in this channel. <${sessionUrl(id)}|Open in Cloudly>`);
}

/** An ephemeral reply to a button press, through the response_url Slack gave. */
async function respond(url: string | undefined, text: string) {
  if (!url?.startsWith("https://hooks.slack.com/")) return;
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }), redirect: "error" }).catch(() => {});
}

type Payload = {
  type: string;
  trigger_id?: string;
  response_url?: string;
  user?: { id: string; username?: string; name?: string };
  actions?: { action_id: string; value?: string }[];
  view?: { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, Record<string, { value?: string }>> } };
};

async function onInteraction(p: Payload): Promise<Record<string, unknown> | null> {
  const user = p.user?.id ? await prisma.user.findUnique({ where: { slackUserId: p.user.id } }) : null;

  if (p.type === "block_actions") {
    const action = p.actions?.[0];
    if (!action || action.action_id === "open") return null;
    if (!user) return void (await respond(p.response_url, NOT_LINKED)), null;
    const thread = action.value ? await prisma.thread.findFirst({ where: { id: action.value, userId: user.id } }) : null;
    if (!thread) return void (await respond(p.response_url, "That session isn't yours, or it's gone.")), null;
    if (action.action_id === "reply") {
      const token = await config("SLACK_BOT_TOKEN");
      if (token && p.trigger_id) await slackApi(token, "views.open", { trigger_id: p.trigger_id, view: replyModal(thread.id, thread.title) }).catch((err) => console.error("[slack] views.open:", err));
      return null;
    }
    if (action.action_id === "cancel") {
      const run = await prisma.run.findFirst({ where: { threadId: thread.id, status: { in: ACTIVE as never } }, orderBy: { createdAt: "desc" } });
      if (!run) return void (await respond(p.response_url, "Nothing is running.")), null;
      await prisma.run.update({ where: { id: run.id }, data: run.status === "queued" ? { cancelRequested: true, status: "cancelled" } : { cancelRequested: true } });
      await respond(p.response_url, "Cancelling the current turn. The work it finished is kept.");
      return null;
    }
    return null;
  }

  if (p.type === "view_submission" && p.view?.callback_id === "reply") {
    if (!user) return { response_action: "errors", errors: { message: NOT_LINKED } };
    const thread = await prisma.thread.findFirst({ where: { id: p.view.private_metadata ?? "", userId: user.id } });
    if (!thread) return { response_action: "errors", errors: { message: "That session isn't yours, or it's gone." } };
    const text = p.view.state?.values?.message?.text?.value?.trim() ?? "";
    if (!text) return { response_action: "errors", errors: { message: "Write something to send." } };
    const problem = await queueTurn(thread, text, p.user?.username ?? p.user?.name ?? "someone", "slack");
    if (problem) return { response_action: "errors", errors: { message: problem } };
    // The reply shows in the session's Slack thread too.
    const token = await config("SLACK_BOT_TOKEN");
    if (token && thread.slackChannelId && thread.slackThreadTs && thread.slackThreadTs !== "-") {
      void slackApi(token, "chat.postMessage", {
        channel: thread.slackChannelId, thread_ts: thread.slackThreadTs,
        text: `*<@${p.user!.id}>:* ${slackText(text.length > 2500 ? `${text.slice(0, 2500)}…` : text)}`,
        unfurl_links: false,
      }).catch((err) => console.error("[slack] reply echo:", err));
    }
    return null;
  }
  return null;
}

export const slack = new Hono();

slack.post("/commands", async (c) => {
  const form = await verified(c);
  if (!form) return c.json({ message: "Bad signature, or Slack isn't set up on this Cloudly." }, 401);
  return c.json(await onCommand(form));
});

slack.post("/interactions", async (c) => {
  const form = await verified(c);
  if (!form) return c.json({ message: "Bad signature, or Slack isn't set up on this Cloudly." }, 401);
  let payload: Payload;
  try {
    payload = JSON.parse(form.get("payload") ?? "");
  } catch {
    return c.json({ message: "No payload" }, 400);
  }
  const out = await onInteraction(payload);
  return out ? c.json(out) : c.body(null, 200);
});

// ---------- Settings > Slack ----------

export const slackSettings = new Hono<AuthEnv>();

slackSettings.get("/slack", async (c) => {
  const [signing, token, me] = await Promise.all([
    config("SLACK_SIGNING_SECRET"),
    config("SLACK_BOT_TOKEN"),
    prisma.user.findUnique({ where: { id: c.get("user").id }, select: { slackUserId: true } }),
  ]);
  const urls = slackUrls();
  return c.json({
    signingSecretSet: Boolean(signing),
    botTokenSet: Boolean(token),
    commandsUrl: urls.commands,
    interactionsUrl: urls.interactions,
    manifest: slackManifest(urls.api),
    linked: Boolean(me?.slackUserId),
  });
});

slackSettings.put(
  "/slack",
  zValidator("json", z.object({
    signingSecret: z.string().trim().regex(/^[0-9a-f]{20,64}$/i, "The signing secret is a long hex string (Basic Information, App Credentials).").optional(),
    botToken: z.string().trim().regex(/^xoxb-[\w-]{20,200}$/, "The bot token starts with xoxb- (OAuth & Permissions).").optional(),
  })),
  async (c) => {
    const { signingSecret, botToken } = c.req.valid("json");
    if (signingSecret) await setSetting("SLACK_SIGNING_SECRET", signingSecret);
    if (botToken) await setSetting("SLACK_BOT_TOKEN", botToken);
    return c.json({ ok: true });
  },
);

slackSettings.delete("/slack", async (c) => {
  for (const n of ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"]) await deleteSetting(n);
  return c.body(null, 204);
});

slackSettings.post("/slack/link-code", async (c) => {
  const userId = c.get("user").id;
  const code = randomBytes(5).toString("base64url").replace(/[-_]/g, "").slice(0, 6).toUpperCase().padEnd(6, "X");
  await prisma.discordLinkCode.deleteMany({ where: { userId, provider: "slack" } });
  await prisma.discordLinkCode.create({ data: { code, userId, provider: "slack", expiresAt: new Date(Date.now() + 10 * 60_000) } });
  return c.json({ code, command: `/cloudly link ${code}` });
});

slackSettings.delete("/slack/link", async (c) => {
  await prisma.user.update({ where: { id: c.get("user").id }, data: { slackUserId: null } });
  return c.body(null, 204);
});
