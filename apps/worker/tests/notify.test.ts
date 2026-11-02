import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma, seal } from "@repo/db";
import { notifyTurnEnd, setupDiscordThreads, sendNotifications, notify, type NotifyPort } from "../src/notify";

const stamp = Date.now();
const repo = `acme/notify-${stamp}`;
let userId = "";
const env = { ...process.env };

beforeAll(async () => {
  process.env.DISCORD_BOT_TOKEN = "bot-token-for-tests";
  process.env.DISCORD_APPLICATION_ID = "123456789012345678";
  process.env.WEB_ORIGIN = "https://cloudly.test";
  userId = (await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `notify-${stamp}`, discordUserId: `d${stamp}` } })).id;
});
afterAll(async () => {
  for (const k of ["DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID", "WEB_ORIGIN"]) env[k] === undefined ? delete process.env[k] : (process.env[k] = env[k]);
  await prisma.user.delete({ where: { id: userId } });
});

function fakePort(fail: (what: string) => boolean = () => false) {
  const calls: { what: string; body: any }[] = [];
  const port: NotifyPort = {
    async discord(method, path, body) {
      const what = `${method} ${path}`;
      calls.push({ what, body });
      if (fail(what)) throw new Error("Discord said no");
      if (path.startsWith("/users/@me/channels")) return { id: "dm-1" };
      if (path.endsWith("@original")) return { id: "msg-1" };
      if (path.endsWith("/threads")) return { id: "dthread-1" };
      return {};
    },
    async webhook(url, body) {
      calls.push({ what: `webhook ${url.includes("slack") ? "slack" : "discord"}`, body });
      if (fail(`webhook ${url.includes("slack") ? "slack" : "discord"}`)) throw new Error("webhook down");
    },
  };
  return { port, calls };
}

let n = 0;
async function thread(extra: object = {}) {
  return prisma.thread.create({ data: { userId, repo, baseBranch: "main", harness: "native-claude", title: `Session ${++n}`, branch: `agent/n-${stamp}-${n}`, prUrl: `https://github.com/${repo}/pull/${n}`, ...extra } });
}
const turn = (threadId: string, data: object = {}) =>
  prisma.run.create({ data: { userId, threadId, repo, baseBranch: "main", harness: "native-claude", prompt: "x", status: "succeeded", ...data } });

test("a session is reported once its chain of turns settles: done, needs you, or failed", async () => {
  const t = await thread();
  const first = await turn(t.id, { filesChanged: 2, additions: 10, deletions: 1 });
  await prisma.runEvent.create({ data: { runId: first.id, seq: 0, ts: new Date(), kind: "text", data: "Added the endpoint and a test." } });
  // A review is queued after it: nothing yet.
  const review = await turn(t.id, { status: "queued", kind: "review" });
  await notifyTurnEnd(first.id);
  expect(await prisma.notification.count({ where: { threadId: t.id } })).toBe(0);

  await prisma.run.update({ where: { id: review.id }, data: { status: "succeeded", output: "The review found nothing to fix." } });
  await notifyTurnEnd(review.id);
  await notifyTurnEnd(review.id); // once only
  const done = await prisma.notification.findMany({ where: { threadId: t.id } });
  expect(done).toHaveLength(1);
  expect(done[0]).toMatchObject({ kind: "done", title: t.title, body: "The review found nothing to fix.", url: `https://cloudly.test/app/s/${t.id}` });

  const asks = await turn(t.id);
  await prisma.thread.update({ where: { id: t.id }, data: { needsInput: "Which database?" } });
  await notifyTurnEnd(asks.id);
  const failed = await turn(t.id, { status: "failed", error: "Monthly spend limit reached" });
  await prisma.thread.update({ where: { id: t.id }, data: { needsInput: null } });
  await notifyTurnEnd(failed.id);
  const cancelled = await turn(t.id, { status: "cancelled" });
  await notifyTurnEnd(cancelled.id);
  const all = await prisma.notification.findMany({ where: { threadId: t.id }, orderBy: { createdAt: "asc" } });
  expect(all.map((x) => [x.kind, x.body])).toEqual([
    ["done", "The review found nothing to fix."],
    ["needs_you", "Which database?"],
    ["failed", "Monthly spend limit reached"],
  ]);
  // The first turn's own text and stats when it's the one that settles.
  const solo = await thread();
  const r = await turn(solo.id, { filesChanged: 1, additions: 3, deletions: 0 });
  await prisma.runEvent.create({ data: { runId: r.id, seq: 0, ts: new Date(), kind: "text", data: "Fixed the typo." } });
  await notifyTurnEnd(r.id);
  expect((await prisma.notification.findFirstOrThrow({ where: { threadId: solo.id } })).body).toBe("Fixed the typo.\n\n1 file changed, +3 −0.");
  await prisma.notification.updateMany({ where: { userId }, data: { sentAt: new Date() } });
});

test("a session started from Discord gets its own Discord thread, and its updates go there", async () => {
  const t = await thread({ discordChannelId: "chan-1", discordToken: "interaction-token" });
  const stale = await thread({ discordChannelId: "chan-2", discordToken: "old-token", createdAt: new Date(Date.now() - 20 * 60_000) });
  const { port, calls } = fakePort();
  await notify({ userId, threadId: t.id, kind: "done", title: t.title, body: "All done.", key: `k-${t.id}` });
  // Not sent before its thread exists.
  await sendNotifications(port);
  expect(calls).toEqual([]);

  await setupDiscordThreads(port);
  expect(calls.map((c) => c.what)).toEqual([
    "GET /webhooks/123456789012345678/interaction-token/messages/@original",
    "POST /channels/chan-1/messages/msg-1/threads",
  ]);
  expect((await prisma.thread.findUniqueOrThrow({ where: { id: t.id } })).discordThreadId).toBe("dthread-1");
  // A token past its life: updates go to the channel itself.
  expect(await prisma.thread.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ discordThreadId: "chan-2", discordToken: null });

  calls.length = 0;
  await sendNotifications(port);
  // Only the session's thread, not also a DM.
  expect(calls.map((c) => c.what)).toEqual(["POST /channels/dthread-1/messages"]);
  const msg = calls[0]!.body;
  expect(msg.embeds[0]).toMatchObject({ title: `Done: ${t.title}`, description: "All done." });
  expect(msg.components[0].components.map((b: any) => b.custom_id ?? b.url)).toEqual([`reply:${t.id}`, `https://cloudly.test/app/s/${t.id}`]);
  expect(msg.allowed_mentions).toEqual({ parse: [] });
  expect((await prisma.notification.findFirstOrThrow({ where: { key: `k-${t.id}` } })).sentTo).toEqual(["discord-thread"]);
});

test("personal notifications go to a DM and to webhooks, as chosen, and a failed one is retried alone", async () => {
  await prisma.notifySettings.create({
    data: {
      userId, onDone: false,
      discordWebhookUrl: await seal("https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz"),
      slackWebhookUrl: await seal("https://hooks.slack.com/services/T000/B000/XXXXXXXX"),
    },
  });
  const t = await thread();
  await notify({ userId, threadId: t.id, kind: "done", title: t.title, body: "Done.", key: `done-${t.id}` });
  await notify({ userId, threadId: t.id, kind: "needs_you", title: t.title, body: "Which one?", key: `needs-${t.id}` });

  const slackDown = fakePort((what) => what === "webhook slack");
  await sendNotifications(slackDown.port);
  // "Done" is turned off; "needs you" goes everywhere, and Slack fails.
  expect(slackDown.calls.map((c) => c.what)).toEqual(["POST /users/@me/channels", "POST /channels/dm-1/messages", "webhook discord", "webhook slack"]);
  expect(slackDown.calls[0]!.body).toEqual({ recipient_id: `d${stamp}` });
  expect(slackDown.calls[3]!.body.text).toContain("*Needs you: ");
  const needs = await prisma.notification.findFirstOrThrow({ where: { key: `needs-${t.id}` } });
  expect(needs).toMatchObject({ sentAt: null, sentTo: ["discord-dm", "discord-webhook"], attempts: 1 });
  expect(needs.error).toContain("slack: webhook down");
  expect((await prisma.notification.findFirstOrThrow({ where: { key: `done-${t.id}` } })).sentAt).toBeInstanceOf(Date);

  // Next time round only Slack is tried.
  const ok = fakePort();
  await sendNotifications(ok.port);
  expect(ok.calls.map((c) => c.what)).toEqual(["webhook slack"]);
  expect((await prisma.notification.findFirstOrThrow({ where: { key: `needs-${t.id}` } })).sentAt).toBeInstanceOf(Date);

  // Something that keeps failing is given up after five tries.
  await notify({ userId, threadId: t.id, kind: "failed", title: t.title, body: "x", key: `fail-${t.id}` });
  const down = fakePort(() => true);
  for (let i = 0; i < 5; i++) await sendNotifications(down.port);
  expect(await prisma.notification.findFirstOrThrow({ where: { key: `fail-${t.id}` } })).toMatchObject({ attempts: 5, sentTo: [] });
  expect((await prisma.notification.findFirstOrThrow({ where: { key: `fail-${t.id}` } })).sentAt).toBeInstanceOf(Date);
});
