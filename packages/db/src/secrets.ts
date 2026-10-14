import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { prisma } from "./client";

export interface SettingSpec {
  name: string;
  label: string;
  /** Secret values are never shown again after saving. */
  secret: boolean;
  group: "github" | "models" | "alerts" | "access" | "sandbox";
  /** Keys and tokens: never contain whitespace, but a terminal-wrapped copy often does. */
  token?: boolean;
}

export const SETTINGS: SettingSpec[] = [
  { name: "ALLOWED_GITHUB_LOGINS", label: "GitHub logins allowed to sign in", secret: false, group: "access" },
  { name: "GITHUB_APP_ID", label: "GitHub App ID", secret: false, group: "github" },
  { name: "GITHUB_APP_SLUG", label: "GitHub App slug", secret: false, group: "github" },
  { name: "GITHUB_APP_INSTALLATION_ID", label: "GitHub App installation ID", secret: false, group: "github" },
  { name: "GITHUB_CLIENT_ID", label: "GitHub App client ID", secret: false, group: "github" },
  { name: "GITHUB_CLIENT_SECRET", label: "GitHub App client secret", secret: true, group: "github" , token: true },
  { name: "GITHUB_APP_PRIVATE_KEY", label: "GitHub App private key", secret: true, group: "github" },
  { name: "ANTHROPIC_API_KEY", label: "Anthropic API key (Claude Agent)", secret: true, group: "models" , token: true },
  { name: "OPENAI_API_KEY", label: "OpenAI API key (Codex)", secret: true, group: "models" , token: true },
  { name: "GEMINI_API_KEY", label: "Gemini API key (Gemini CLI)", secret: true, group: "models" , token: true },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", label: "Claude plan token (from `claude setup-token`; used instead of the API key)", secret: true, group: "models" , token: true },
  { name: "CODEX_AUTH_JSON", label: "ChatGPT plan sign-in for Codex (contents of ~/.codex/auth.json; used instead of the API key)", secret: true, group: "models" },
  { name: "RESEND_API_KEY", label: "Resend API key (budget emails)", secret: true, group: "alerts" , token: true },
  { name: "SANDBOX_SETUP_SCRIPT", label: "Sandbox setup script", secret: false, group: "sandbox" },
  { name: "SANDBOX_EGRESS_HOSTS", label: "Extra hosts the sandbox may reach", secret: false, group: "sandbox" },
];

export function settingSpec(name: string): SettingSpec | undefined {
  return SETTINGS.find((s) => s.name === name);
}

let cachedKey: Buffer | undefined;

/**
 * 32-byte master key. CLOUDLY_SECRET_KEY (base64) wins; otherwise one is
 * created once under the data dir so the API and worker, which run as the same
 * user on the same machine, agree on it without any extra setup.
 */
export async function masterKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.CLOUDLY_SECRET_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "base64");
    if (key.length !== 32) throw new Error("CLOUDLY_SECRET_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
    return (cachedKey = key);
  }

  const dir = process.env.CLOUDLY_DATA_DIR ?? path.join(homedir(), ".cloudly");
  const file = path.join(dir, "secret.key");
  const existing = Bun.file(file);
  if (await existing.exists()) {
    return (cachedKey = Buffer.from((await existing.text()).trim(), "base64"));
  }
  await mkdir(dir, { recursive: true });
  const fresh = randomBytes(32);
  await Bun.write(file, fresh.toString("base64"));
  await chmod(file, 0o600);
  return (cachedKey = fresh);
}

/** Visible only to tests, which swap keys. */
export function resetMasterKeyCache() {
  cachedKey = undefined;
}

export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

export function decrypt(blob: string, key: Buffer): string {
  const [iv, tag, body] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !body) throw new Error("malformed secret");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export async function setSetting(name: string, value: string): Promise<void> {
  if (!settingSpec(name)) throw new Error(`unknown setting: ${name}`);
  const encrypted = encrypt(cleanSetting(name, value), await masterKey());
  await prisma.setting.upsert({ where: { name }, update: { value: encrypted }, create: { name, value: encrypted } });
}

export async function deleteSetting(name: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { name } });
}

const unreadable = new Set<string>();

/**
 * A setting saved under a different master key (another install pointed at the
 * same database, or a lost CLOUDLY_SECRET_KEY) can't be read. Treat it as unset
 * so setup can run again and overwrite it, instead of every request failing.
 */
function readable(name: string, blob: string, key: Buffer): string | undefined {
  try {
    const value = decrypt(blob, key);
    unreadable.delete(name);
    return value;
  } catch {
    if (!unreadable.has(name)) {
      console.warn(`[settings] ${name} was saved with a different CLOUDLY_SECRET_KEY and can't be read; treating it as unset.`);
    }
    unreadable.add(name);
    return undefined;
  }
}

/** Settings found in the database that this install's key can't read. */
export function unreadableSettings(): string[] {
  return [...unreadable];
}

/** Strips the whitespace a wrapped terminal line leaves inside a pasted key or token. */
export function cleanSetting(name: string, value: string): string {
  return settingSpec(name)?.token ? value.replace(/\s+/g, "") : value;
}

export async function getSetting(name: string): Promise<string | undefined> {
  const row = await prisma.setting.findUnique({ where: { name } });
  if (!row) return undefined;
  const value = readable(name, row.value, await masterKey());
  return value === undefined ? undefined : cleanSetting(name, value);
}

/** A value saved in the browser wins; the same name in .env is the fallback. */
export async function config(name: string): Promise<string | undefined> {
  return (await getSetting(name)) || process.env[name] || undefined;
}

export interface SettingStatus extends SettingSpec {
  set: boolean;
  /** "db" when saved in the browser, "env" when only in .env. */
  source: "db" | "env" | null;
  /** Saved by an earlier install under its key; recoverSettings can unlock it. */
  locked: boolean;
  /** Non-secrets show their value; secrets only their last four characters. */
  preview: string | null;
}

export async function listSettings(): Promise<SettingStatus[]> {
  const rows = new Map((await prisma.setting.findMany()).map((r) => [r.name, r.value]));
  const key = await masterKey();
  return SETTINGS.map((spec) => {
    const stored = rows.get(spec.name);
    const read = stored !== undefined ? readable(spec.name, stored, key) : undefined;
    const fromDb = read === undefined ? undefined : cleanSetting(spec.name, read);
    const raw = fromDb ?? (process.env[spec.name] || undefined);
    const source = fromDb !== undefined ? "db" : raw ? "env" : null;
    const preview = raw ? (spec.secret ? `…${raw.slice(-4)}` : raw) : null;
    return { ...spec, set: Boolean(raw), source, preview, locked: stored !== undefined && read === undefined };
  });
}

/** Which harnesses run on the user's subscription instead of an API key. */
export async function harnessUsesPlan(harness: string): Promise<boolean> {
  if (harness === "native-claude") return Boolean(await config("CLAUDE_CODE_OAUTH_TOKEN"));
  if (harness === "native-codex") return Boolean(await config("CODEX_AUTH_JSON"));
  return false;
}

/**
 * This install's master key, which doubles as its recovery key: a later install
 * on the same database pastes it to keep these settings (recoverSettings). It is
 * shown at install and during setup, never in Settings, because with a copy of
 * the database it decrypts everything.
 */
export async function recoveryKey(): Promise<string> {
  return (await masterKey()).toString("base64");
}

/**
 * Re-encrypts settings saved by an earlier install (under its master key) with
 * this install's key, so they're readable again without editing any file.
 * Returns how many were recovered; 0 means the key doesn't match any of them.
 */
export async function recoverSettings(oldRecoveryKey: string): Promise<number> {
  const trimmed = oldRecoveryKey.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) {
    throw new Error("A recovery key is 44 characters ending in '='. Copy it exactly as it was shown.");
  }
  const old = Buffer.from(trimmed, "base64");
  const key = await masterKey();
  let recovered = 0;
  for (const row of await prisma.setting.findMany()) {
    try {
      decrypt(row.value, key);
      continue; // already this install's
    } catch {}
    let plain: string;
    try {
      plain = decrypt(row.value, old);
    } catch {
      continue; // from some other install, or damaged
    }
    await prisma.setting.update({ where: { name: row.name }, data: { value: encrypt(plain, key) } });
    unreadable.delete(row.name);
    recovered++;
  }
  return recovered;
}
