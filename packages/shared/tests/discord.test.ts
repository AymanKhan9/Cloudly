import { test, expect } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyDiscordSignature, sessionMessage, slackMessage, DISCORD_WEBHOOK, SLACK_WEBHOOK, inviteUrl, BOT_PERMISSIONS } from "../src/discord";

test("Discord's signatures are checked against the application's public key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const hex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const body = '{"type":1}';
  const ts = "1700000000";
  const sig = sign(null, Buffer.from(ts + body), privateKey).toString("hex");
  expect(verifyDiscordSignature(hex, sig, ts, body)).toBe(true);
  expect(verifyDiscordSignature(hex, sig, ts, body + " ")).toBe(false);
  expect(verifyDiscordSignature(hex, sig, "1700000001", body)).toBe(false);
  expect(verifyDiscordSignature(hex, undefined, ts, body)).toBe(false);
  expect(verifyDiscordSignature("nothex", sig, ts, body)).toBe(false);
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  expect(verifyDiscordSignature(other, sig, ts, body)).toBe(false);
});

test("session updates never ping anyone, and carry the right buttons", () => {
  const m = sessionMessage({ kind: "needs_you", title: "Fix login", body: "@everyone which provider?", url: "https://c.example/app/s/1", prUrl: null, repo: "acme/app" }, "t1");
  expect(m.allowed_mentions).toEqual({ parse: [] });
  expect(m.embeds[0]).toMatchObject({ title: "Needs you: Fix login", color: 0xc48714, footer: { text: "acme/app" } });
  const ids = (m.components[0] as { components: { custom_id?: string; url?: string }[] }).components.map((b) => b.custom_id ?? b.url);
  expect(ids).toEqual(["reply:t1", "https://c.example/app/s/1"]);
  expect(sessionMessage({ kind: "done", title: "t", body: "b" }, null).components).toEqual([]);
  expect(slackMessage({ kind: "merged", title: "a <b> & c", body: "x", url: "https://c/s/1" }).text).toBe("*Merged: a &lt;b&gt; &amp; c*\nx\n<https://c/s/1|Open in Cloudly>");
});

test("only real Discord and Slack webhook URLs are accepted", () => {
  expect(DISCORD_WEBHOOK.test("https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_-12")).toBe(true);
  expect(DISCORD_WEBHOOK.test("https://discord.com.evil.io/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz")).toBe(false);
  expect(DISCORD_WEBHOOK.test("http://169.254.169.254/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz")).toBe(false);
  expect(SLACK_WEBHOOK.test("https://hooks.slack.com/services/T000/B000/XXXXXXXX")).toBe(true);
  expect(SLACK_WEBHOOK.test("https://hooks.slack.com.evil/services/T000/B000/XXXX")).toBe(false);
  expect(inviteUrl("42")).toContain(`client_id=42&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`);
});
