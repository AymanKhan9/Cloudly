import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySlackSignature, parseSlackCommand, slackBlocks, slackManifest } from "../src/slack";

test("Slack's signatures are checked, and old requests refused", () => {
  const secret = "s3cret";
  const now = Date.UTC(2026, 10, 2) ;
  const ts = String(Math.floor(now / 1000));
  const body = "command=%2Fcloudly&text=status";
  const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  expect(verifySlackSignature(secret, sig, ts, body, now)).toBe(true);
  expect(verifySlackSignature(secret, sig, ts, body + "x", now)).toBe(false);
  expect(verifySlackSignature("other", sig, ts, body, now)).toBe(false);
  expect(verifySlackSignature(secret, sig, ts, body, now + 10 * 60_000)).toBe(false);
  expect(verifySlackSignature(secret, undefined, ts, body, now)).toBe(false);
});

test("/cloudly text reads as a command or a task with options anywhere", () => {
  expect(parseSlackCommand("")).toEqual({ kind: "help" });
  expect(parseSlackCommand("status")).toEqual({ kind: "status" });
  expect(parseSlackCommand("repo acme/app")).toEqual({ kind: "repo", repo: "acme/app" });
  expect(parseSlackCommand("link AB12CD")).toEqual({ kind: "link", code: "AB12CD" });
  expect(parseSlackCommand("fix the flaky login test repo:acme/app agent:Codex")).toEqual({ kind: "task", prompt: "fix the flaky login test", repo: "acme/app", agent: "native-codex" });
  expect(parseSlackCommand("task branch:dev add a status page")).toEqual({ kind: "task", prompt: "add a status page", branch: "dev" });
  // "status of the build" is a task, not the status command.
  expect(parseSlackCommand("status of the build is red, fix it").kind).toBe("task");
});

test("messages escape what the agent wrote, and the manifest points at Cloudly", () => {
  const m = slackBlocks({ kind: "needs_you", title: "Fix <login>", body: "<!channel> which one?", url: "https://c/app/s/1", prUrl: "https://github.com/a/b/pull/2", repo: "a/b" }, "t1");
  const section = (m.blocks[0] as any).text.text as string;
  expect(section).toBe("*Needs you: Fix &lt;login&gt;*\n&lt;!channel&gt; which one?");
  const actions = (m.blocks[2] as any).elements.map((e: any) => e.action_id);
  expect(actions).toEqual(["reply", "open"]);
  const manifest = slackManifest("https://c.example/api");
  expect(manifest.features.slash_commands[0]!.url).toBe("https://c.example/api/slack/commands");
  expect(manifest.settings.interactivity.request_url).toBe("https://c.example/api/slack/interactions");
});
