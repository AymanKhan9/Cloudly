import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, setSetting, getSetting, config, deleteSetting, listSettings } from "../src";

test("encrypts and decrypts, with a fresh IV each time", () => {
  const key = randomBytes(32);
  const a = encrypt("sk-secret", key);
  const b = encrypt("sk-secret", key);
  expect(a).not.toBe(b);
  expect(a).not.toContain("sk-secret");
  expect(decrypt(a, key)).toBe("sk-secret");
});

test("a wrong key or a tampered value fails instead of returning garbage", () => {
  const key = randomBytes(32);
  const blob = encrypt("sk-secret", key);
  expect(() => decrypt(blob, randomBytes(32))).toThrow();
  const [iv, tag, body] = blob.split(".");
  const flipped = Buffer.from(body!, "base64");
  flipped[0] = flipped[0]! ^ 1;
  expect(() => decrypt([iv, tag, flipped.toString("base64")].join("."), key)).toThrow();
});

test("a value saved in the database wins over .env, and secrets are masked in listings", async () => {
  const name = "GEMINI_API_KEY";
  const before = process.env[name];
  try {
    process.env[name] = "from-env-1111";
    expect(await config(name)).toBe("from-env-1111");

    await setSetting(name, "from-db-9999");
    expect(await getSetting(name)).toBe("from-db-9999");
    expect(await config(name)).toBe("from-db-9999");

    const listed = (await listSettings()).find((s) => s.name === name)!;
    expect(listed).toMatchObject({ set: true, source: "db", preview: "…9999" });
    expect(JSON.stringify(listed)).not.toContain("from-db");

    await deleteSetting(name);
    expect(await config(name)).toBe("from-env-1111");
  } finally {
    await deleteSetting(name);
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
});

test("unknown setting names are rejected", async () => {
  await expect(setSetting("NOT_A_SETTING", "x")).rejects.toThrow(/unknown setting/);
});

test("an empty saved value counts as unset and falls back to .env", async () => {
  const name = "OPENAI_API_KEY";
  const before = process.env[name];
  try {
    process.env[name] = "from-env-2222";
    await setSetting(name, "");
    expect(await config(name)).toBe("from-env-2222");
  } finally {
    await deleteSetting(name);
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
});
