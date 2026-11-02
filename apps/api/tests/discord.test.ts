import { test, expect, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { prisma, unseal } from "@repo/db";
import api from "../src/index";
import { setRepoLister } from "../src/discord-routes";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

process.env.WEB_ORIGIN = "https://cloudly.test";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const stamp = Date.now();
const repo = `acme/discord-${stamp}`;
const ME = { id: `d-${stamp}`, username: "ayman", global_name: "Ayman" };
const STRANGER = { id: `x-${stamp}`, username: "stranger" };
const saved = { ...process.env };
let cookie = "";
let userId = "";

beforeAll(async () => {
  process.env.DISCORD_PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  setRepoLister(async () => [{ fullName: repo, defaultBranch: "trunk", private: true }]);
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `discord-${stamp}` } });
  userId = user.id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});
afterAll(async () => {
  process.env.DISCORD_PUBLIC_KEY = saved.DISCORD_PUBLIC_KEY;
  await prisma.user.delete({ where: { id: userId } });
  await prisma.discordChannel.deleteMany({ where: { repo } });
});

const interact = (body: object, opts: { badSig?: boolean } = {}) => {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(ts + raw + (opts.badSig ? "x" : "")), privateKey).toString("hex");
  return api.fetch(new Request("http://api.test/discord/interactions", { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": sig, "x-signature-timestamp": ts }, body: raw }));
};
const command = (user: object, sub: string, options: Record<string, string> = {}, channel = "chan-1") =>
  interact({ type: 2, id: "i1", token: `tok-${Math.random()}`, channel_id: channel, guild_id: "g1", member: { user }, data: { name: "cloudly", options: [{ type: 1, name: sub, options: Object.entries(options).map(([name, value]) => ({ name, type: 3, value })) }] } });
const json = async (r: Response) => (await r.json()) as any;

const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET") headers.set("origin", "https://cloudly.test");
  return api.fetch(new Request(`http://api.test${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }));
};

test("only Discord's signed requests are answered", async () => {
  expect((await interact({ type: 1 }, { badSig: true })).status).toBe(401);
  expect(await json(await interact({ type: 1 }))).toEqual({ type: 1 });
});

test("an unlinked account can only link; a code from Settings links it once", async () => {
  const before = await json(await command(ME, "task", { prompt: "Fix it", repo }));
  expect(before.data.content).toContain("Link your Discord account first");
  expect(before.data.flags).toBe(64);

  const { code } = await json(await call("/settings/discord/link-code", { method: "POST" }));
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  expect((await json(await command(ME, "link", { code: "WRONG1" }))).data.content).toContain("isn't valid");
  expect((await json(await command(ME, "link", { code: code.toLowerCase() }))).data.content).toContain(`Linked to **discord-${stamp}**`);
  // Used up.
  expect((await json(await command(STRANGER, "link", { code }))).data.content).toContain("isn't valid");
  expect((await json(await call("/settings/discord"))).linked).toBe(true);
});

test("/cloudly task starts a session with a Discord thread to come; repo defaults per channel", async () => {
  expect((await json(await command(ME, "task", { prompt: "Fix it" }, "chan-9"))).data.content).toContain("Which repository?");
  expect((await json(await command(ME, "task", { prompt: "Fix it", repo: "acme/not-installed" }))).data.content).toContain("can't see acme/not-installed");

  expect((await json(await command(ME, "repo", { repo }, "chan-2"))).data.content).toContain(`now works on **${repo}**`);
  const r = await json(await command(ME, "task", { prompt: "Add rate limiting to POST /invoices", agent: "native-codex" }, "chan-2"));
  expect(r.type).toBe(4);
  expect(r.data.embeds[0].title).toBe("Started: Add rate limiting to POST /invoices");
  expect(r.data.allowed_mentions).toEqual({ parse: [] });
  const thread = await prisma.thread.findFirstOrThrow({ where: { userId, repo }, include: { runs: true } });
  expect(thread).toMatchObject({ harness: "native-codex", baseBranch: "trunk", discordChannelId: "chan-2" });
  expect(thread.discordToken).toStartWith("tok-");
  expect(thread.runs[0]!.trigger).toMatchObject({ type: "discord", by: "ayman" });
  const cancel = r.data.components[0].components.find((b: any) => b.custom_id);
  expect(cancel.custom_id).toBe(`cancel:${thread.id}`);

  // Status lists it; a stranger's buttons do nothing.
  expect((await json(await command(ME, "status"))).data.content).toContain(thread.title);
  const press = (user: object, id: string) => interact({ type: 3, id: "i2", token: "t", channel_id: "c", member: { user }, data: { custom_id: id } });
  expect((await json(await press(STRANGER, `cancel:${thread.id}`))).data.content).toContain("Link your Discord account first");

  // Reply while it's busy: refused. Cancel, then reply through the modal.
  const modal = await json(await press(ME, `reply:${thread.id}`));
  expect(modal.type).toBe(9);
  const submit = (text: string) => interact({ type: 5, id: "i3", token: "t", channel_id: "c", member: { user: ME }, data: { custom_id: `reply:${thread.id}`, components: [{ type: 1, components: [{ type: 4, custom_id: "text", value: text }] }] } });
  expect((await json(await submit("also log it"))).data.content).toContain("still working");
  expect((await json(await press(ME, `cancel:${thread.id}`))).data.content).toContain("Cancelling");
  expect((await prisma.run.findFirstOrThrow({ where: { threadId: thread.id } })).status).toBe("cancelled");
  const sent = await json(await submit("Also log every 429"));
  expect(sent.data.content).toBe("**Ayman:** Also log every 429");
  const runs = await prisma.run.findMany({ where: { threadId: thread.id }, orderBy: { createdAt: "asc" } });
  expect(runs.at(-1)).toMatchObject({ prompt: "Also log every 429", status: "queued" });

  // Autocomplete names the repos, for linked accounts only.
  const auto = (user: object) => interact({ type: 4, id: "i4", token: "t", member: { user }, data: { name: "cloudly", options: [{ type: 1, name: "task", options: [{ name: "repo", type: 3, value: "disc", focused: true }] }] } });
  expect((await json(await auto(ME))).data.choices).toEqual([{ name: repo, value: repo }]);
  expect((await json(await auto(STRANGER))).data.choices).toEqual([]);
});

test("notification settings keep webhook URLs encrypted, and refuse anything that isn't one", async () => {
  expect((await call("/settings/notifications", { method: "PUT", json: { slackWebhookUrl: "http://169.254.169.254/latest" } })).status).toBe(400);
  const hook = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz";
  expect((await call("/settings/notifications", { method: "PUT", json: { discordWebhookUrl: hook, onDone: false } })).status).toBe(200);
  const row = await prisma.notifySettings.findUniqueOrThrow({ where: { userId } });
  expect(row.discordWebhookUrl).not.toContain("webhooks");
  expect(await unseal(row.discordWebhookUrl)).toBe(hook);
  const view = await json(await call("/settings/notifications"));
  expect(view).toMatchObject({ discordDm: true, onDone: false, onNeedsYou: true, slackWebhook: null });
  expect(view.discordWebhook).toBe("https://discord.com/…wxyz");
  // Left out keeps it; "" clears it.
  await call("/settings/notifications", { method: "PUT", json: { onDone: true } });
  expect((await json(await call("/settings/notifications"))).discordWebhook).not.toBeNull();
  await call("/settings/notifications", { method: "PUT", json: { discordWebhookUrl: "" } });
  expect((await json(await call("/settings/notifications"))).discordWebhook).toBeNull();
  expect((await call("/settings/notifications/test", { method: "POST" })).status).toBe(200);
  expect(await prisma.notification.count({ where: { userId, kind: "test" } })).toBe(1);

  expect((await call("/settings/discord", { method: "PUT", json: { applicationId: "abc", publicKey: "00" } })).status).toBe(400);
  const settings = await json(await call("/settings/discord"));
  expect(settings.interactionsUrl).toBe("https://cloudly.test/api/discord/interactions");
});
