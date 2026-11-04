import { test, expect, beforeAll, afterAll } from "bun:test";
import { prisma, secretsForRepo } from "@repo/db";
import api from "../src/index";
import { hashToken, SESSION_COOKIE_NAME } from "../src/session";

let cookie = "";
let userId = "";
beforeAll(async () => {
  userId = (await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `secret-api-${Date.now()}` } })).id;
  const token = crypto.randomUUID();
  await prisma.session.create({ data: { id: await hashToken(token), userId, expiresAt: new Date(Date.now() + 3600_000) } });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});
afterAll(async () => {
  await prisma.envSecret.deleteMany({ where: { repo: { in: ["acme/secret-ask", ""] }, name: "STRIPE_KEY" } });
  await prisma.user.delete({ where: { id: userId } });
});

const save = (threadId: string, body: object) =>
  api.fetch(new Request(`http://api.test/threads/${threadId}/secrets`, { method: "POST", body: JSON.stringify(body), headers: { cookie, "content-type": "application/json", origin: process.env.WEB_ORIGIN ?? "" } }));

test("a secret the agent asked for is saved for the session's repo, and its next turn starts without the value in it", async () => {
  const thread = await prisma.thread.create({
    data: { userId, repo: "acme/secret-ask", baseBranch: "main", harness: "native-codex", title: "t", branch: "b", needsInput: "The agent needs a secret: STRIPE_KEY" },
  });
  expect((await save(thread.id, { name: "stripe key", value: "sk_test_1", hosts: "api.stripe.com" })).status).toBe(400);
  expect((await save(thread.id, { name: "STRIPE_KEY", value: "sk_test_1", hosts: "" })).status).toBe(400);

  const res = await save(thread.id, { name: "STRIPE_KEY", value: "sk_test_secret_value", hosts: "api.stripe.com" });
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ saved: true, name: "STRIPE_KEY", hosts: ["api.stripe.com"] });

  const [secret] = (await secretsForRepo("acme/secret-ask")).filter((s) => s.name === "STRIPE_KEY");
  expect(secret).toMatchObject({ value: "sk_test_secret_value", hosts: ["api.stripe.com"], exposed: false });
  const runs = await prisma.run.findMany({ where: { threadId: thread.id } });
  expect(runs).toHaveLength(1);
  expect(runs[0].prompt).toContain("$STRIPE_KEY");
  expect(runs[0].prompt).not.toContain("sk_test_secret_value");
  expect((await prisma.thread.findUniqueOrThrow({ where: { id: thread.id } })).needsInput).toBeNull();
});

test("another user's session can't take a secret", async () => {
  const other = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `secret-other-${Date.now()}` } });
  try {
    const thread = await prisma.thread.create({ data: { userId: other.id, repo: "", baseBranch: "main", harness: "native-codex", title: "t", branch: "main" } });
    expect((await save(thread.id, { name: "STRIPE_KEY", value: "x", hosts: "api.stripe.com" })).status).toBe(404);
  } finally {
    await prisma.user.delete({ where: { id: other.id } });
  }
});
