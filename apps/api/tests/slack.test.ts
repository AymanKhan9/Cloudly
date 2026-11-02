import { test, expect, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import { prisma } from "@repo/db";
import api from "../src/index";
import { setRepoLister } from "../src/discord-routes";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
const SECRET = "0123456789abcdef0123456789abcdef";
const stamp = Date.now();
const repo = `acme/slack-${stamp}`;
const ME = `U${stamp}`;
const saved = process.env.SLACK_SIGNING_SECRET;
let cookie = "";
let userId = "";

beforeAll(async () => {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  setRepoLister(async () => [{ fullName: repo, defaultBranch: "develop", private: true }]);
  userId = (await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `slack-${stamp}` } })).id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});
afterAll(async () => {
  process.env.SLACK_SIGNING_SECRET = saved;
  await prisma.user.delete({ where: { id: userId } });
  await prisma.slackChannel.deleteMany({ where: { repo } });
});

const signed = (path: string, body: string, opts: { secret?: string; age?: number } = {}) => {
  const ts = String(Math.floor(Date.now() / 1000) - (opts.age ?? 0));
  const sig = `v0=${createHmac("sha256", opts.secret ?? SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return api.fetch(new Request(`http://api.test${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-signature": sig, "x-slack-request-timestamp": ts }, body }));
};
const slash = (text: string, user = ME, channel = "C1") =>
  signed("/slack/commands", new URLSearchParams({ command: "/cloudly", text, user_id: user, user_name: "ayman", channel_id: channel, trigger_id: "tr" }).toString());
const interact = (payload: object) => signed("/slack/interactions", new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
const call = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.method && init.method !== "GET") headers.set("origin", "https://cloudly.test");
  return api.fetch(new Request(`http://api.test${path}`, { ...init, headers }));
};

test("only Slack's signed, recent requests are answered", async () => {
  const body = "text=status";
  expect((await signed("/slack/commands", body, { secret: "wrong" })).status).toBe(401);
  expect((await signed("/slack/commands", body, { age: 600 })).status).toBe(401);
  expect((await (await slash("help")).json()).text).toContain("/cloudly repo owner/repo");
});

test("linking takes a Slack code, not a Discord one; then /cloudly starts a session", async () => {
  expect((await (await slash(`do it repo:${repo}`)).json()).text).toContain("Link your Slack account first");
  const discordCode = (await (await call("/settings/discord/link-code", { method: "POST" })).json()).code;
  expect((await (await slash(`link ${discordCode}`)).json()).text).toContain("isn't valid");
  const { code, command } = await (await call("/settings/slack/link-code", { method: "POST" })).json();
  expect(command).toBe(`/cloudly link ${code}`);
  expect((await (await slash(`link ${code}`)).json()).text).toContain(`Linked to *slack-${stamp}*`);
  expect((await (await call("/settings/slack")).json()).linked).toBe(true);

  expect((await (await slash("fix the flaky test", ME, "C9")).json()).text).toContain("Which repository?");
  expect((await (await slash(`repo ${repo}`, ME, "C2")).json()).response_type).toBe("in_channel");
  const started = await (await slash("fix the flaky login test agent:codex", ME, "C2")).json();
  expect(started.text).toContain(`Starting on *${repo}*`);
  const thread = await prisma.thread.findFirstOrThrow({ where: { userId, repo }, include: { runs: true } });
  expect(thread).toMatchObject({ harness: "native-codex", baseBranch: "develop", slackChannelId: "C2", slackThreadTs: null, title: "fix the flaky login test" });
  expect(thread.runs[0]!.trigger).toMatchObject({ type: "slack", by: "ayman" });
  expect((await (await slash("status")).json()).text).toContain("fix the flaky login test");

  // Reply through the modal: refused while busy, accepted after a cancel.
  const submit = (text: string, user = ME) => interact({ type: "view_submission", user: { id: user, username: "ayman" }, view: { callback_id: "reply", private_metadata: thread.id, state: { values: { message: { text: { value: text } } } } } });
  expect((await (await submit("also cover logout")).json()).errors.message).toContain("still working");
  expect((await interact({ type: "block_actions", user: { id: ME }, actions: [{ action_id: "cancel", value: thread.id }], response_url: "https://example.com/not-slack" })).status).toBe(200);
  expect((await prisma.run.findFirstOrThrow({ where: { threadId: thread.id } })).status).toBe("cancelled");
  const ok = await submit("Also cover logout");
  expect(ok.status).toBe(200);
  const runs = await prisma.run.findMany({ where: { threadId: thread.id }, orderBy: { createdAt: "asc" } });
  expect(runs.at(-1)).toMatchObject({ prompt: "Also cover logout", status: "queued" });
  expect(runs.at(-1)!.trigger).toMatchObject({ type: "slack" });
  // Someone else's account can't.
  expect((await (await submit("hi", "U-other")).json()).errors.message).toContain("Link your Slack account first");

  const settings = await (await call("/settings/slack")).json();
  expect(settings.commandsUrl).toBe("https://cloudly.test/api/slack/commands");
  expect(settings.manifest.features.slash_commands[0].command).toBe("/cloudly");
});
