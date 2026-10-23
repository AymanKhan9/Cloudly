import { test, expect } from "bun:test";
import { prisma, contextSnapshot, contextMarkdown, addContextEntry, setContextNotes, contextEnabled, createAccessToken, accessTokenOwner } from "../src";

const repo = "acme/context-db";

test("the snapshot puts notes first, newest work next, and leaves out the session's own turns", async () => {
  await prisma.contextEntry.deleteMany({ where: { repo } });
  await prisma.repoContext.deleteMany({ where: { repo } });
  try {
    expect(await contextEnabled(repo)).toBe(false);
    await setContextNotes(repo, "- Money is integer cents.");
    expect(await contextEnabled(repo)).toBe(true);
    await addContextEntry({ repo, kind: "turn", author: "native-codex", source: "cloudly", title: "Added rate limiting", body: "Changed 2 files.", threadId: "t-other" });
    await addContextEntry({ repo, kind: "decision", author: "Cursor on laptop", source: "mcp", title: "Keep Postgres advisory locks off" });
    await addContextEntry({ repo, kind: "turn", author: "native-claude", source: "cloudly", title: "My own earlier turn", threadId: "t-mine" });

    const snap = await contextSnapshot(repo, { excludeThreadId: "t-mine" });
    expect(snap.entries.map((e) => e.title)).toEqual(["Keep Postgres advisory locks off", "Added rate limiting"]);
    const md = contextMarkdown(snap);
    expect(md.indexOf("integer cents")).toBeLessThan(md.indexOf("Recent work"));
    expect(md).toContain("**Decision** (from Cursor on laptop)");
    expect(md).toContain("**Turn** (Codex)");
    expect(md).not.toContain("My own earlier turn");

    // Too long: the oldest work goes first, the notes stay.
    for (let i = 0; i < 30; i++) await addContextEntry({ repo, kind: "note", author: "native-claude", source: "cloudly", title: `note ${i}`, body: "x".repeat(900) });
    const short = contextMarkdown(await contextSnapshot(repo, { limit: 50 }), 3000);
    expect(short.length).toBeLessThanOrEqual(3100);
    expect(short).toContain("integer cents");
    expect(short).toContain("older entries, not shown");
  } finally {
    await prisma.contextEntry.deleteMany({ where: { repo } });
    await prisma.repoContext.deleteMany({ where: { repo } });
  }
});

test("editor tokens: shown once, stored hashed, looked up by the raw value", async () => {
  const user = await prisma.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), login: `tok-${Date.now()}` } });
  try {
    const { token } = await createAccessToken(user.id, "Cursor on laptop");
    expect(token).toStartWith("cly_");
    const row = await prisma.accessToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.hash).not.toContain(token);
    expect(await accessTokenOwner(token)).toEqual({ userId: user.id, name: "Cursor on laptop" });
    expect(await accessTokenOwner("cly_wrong")).toBeNull();
    expect(await accessTokenOwner(undefined)).toBeNull();
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
