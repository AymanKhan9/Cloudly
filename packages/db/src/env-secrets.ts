import { createHmac } from "node:crypto";
import { prisma } from "./client";
import { decrypt, encrypt, masterKey } from "./secrets";
import { parseHostList } from "./sandbox";

// Environment variables for runs (API tokens a repo's tests or scripts need).
// The sandbox gets a placeholder in place of the value; the egress proxy
// terminates TLS for the secret's allowed hosts and swaps the placeholder for the
// real value in the request's headers and URL, so the value only ever leaves the
// VM toward the hosts the user named. `exposed` secrets skip all that and go in
// as they are, for values that aren't sensitive.

export const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

// Variables Cloudly sets itself, or that would let a value redirect the agent's
// traffic or credentials.
const RESERVED = /^(PATH|HOME|USER|SHELL|PWD|HOSTNAME|TERM|LANG|LC_.*|DISPLAY|(HTTPS?|NO|ALL)_PROXY|NODE_.*|BUN_.*|SSL_CERT_.*|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|GIT_.*|ANTHROPIC_.*|CLAUDE_.*|OPENAI_.*|CODEX_.*|GEMINI_.*|GOOGLE_.*|CONTROL_CONFIG_PATH|CLOUDLY_.*)$/i;

export function envNameProblem(name: string): string | null {
  if (!ENV_NAME.test(name)) return "Use capital letters, digits and underscores, starting with a letter or underscore.";
  if (RESERVED.test(name)) return `${name} is set by Cloudly or the sandbox and can't be overridden.`;
  return null;
}

/**
 * An unguessable stand-in for a secret, stable across runs: another repo's run
 * never learns it, so it can't ask the proxy for a value it wasn't given.
 */
export async function secretPlaceholder(id: string): Promise<string> {
  return `cloudly-secret-${createHmac("sha256", await masterKey()).update(`env:${id}`).digest("hex").slice(0, 24)}`;
}

export interface RunSecret {
  name: string;
  value: string;
  placeholder: string;
  hosts: string[];
  exposed: boolean;
}

function decryptOr(blob: string, key: Buffer): string | null {
  try {
    return decrypt(blob, key);
  } catch {
    return null;
  }
}

/** The secrets a run on `repo` gets: the repo's own win over instance-wide ones of the same name. */
export async function secretsForRepo(repo: string): Promise<RunSecret[]> {
  const rows = await prisma.envSecret.findMany({ where: { repo: { in: ["*", repo] } } });
  const key = await masterKey();
  const byName = new Map<string, RunSecret>();
  for (const row of rows.sort((a, b) => (a.repo === "*" ? -1 : 1) - (b.repo === "*" ? -1 : 1))) {
    const value = decryptOr(row.value, key);
    if (value === null) continue;
    byName.set(row.name, {
      name: row.name,
      value,
      placeholder: await secretPlaceholder(row.id),
      hosts: parseHostList(row.hosts).filter((h) => h !== "*"),
      exposed: row.exposed,
    });
  }
  return [...byName.values()];
}

/** Every placeholder the proxy may swap, across all repos, with where each may go. */
export async function proxySecrets(): Promise<{ placeholder: string; value: string; hosts: string[] }[]> {
  const key = await masterKey();
  const out: { placeholder: string; value: string; hosts: string[] }[] = [];
  for (const row of await prisma.envSecret.findMany({ where: { exposed: false } })) {
    const value = decryptOr(row.value, key);
    const hosts = parseHostList(row.hosts).filter((h) => h !== "*");
    if (value === null || hosts.length === 0) continue;
    out.push({ placeholder: await secretPlaceholder(row.id), value, hosts });
  }
  return out;
}

export interface EnvSecretView {
  id: string;
  name: string;
  repo: string;
  hosts: string;
  exposed: boolean;
  /** Last four characters, like the keys in Settings. */
  preview: string | null;
  updatedAt: Date;
}

export async function listEnvSecrets(): Promise<EnvSecretView[]> {
  const key = await masterKey();
  const rows = await prisma.envSecret.findMany({ orderBy: [{ repo: "asc" }, { name: "asc" }] });
  return rows.map((r) => {
    const value = decryptOr(r.value, key);
    return { id: r.id, name: r.name, repo: r.repo, hosts: r.hosts, exposed: r.exposed, preview: value ? `…${value.slice(-4)}` : null, updatedAt: r.updatedAt };
  });
}

export async function saveEnvSecret(input: { name: string; repo: string; value?: string; hosts: string; exposed: boolean }): Promise<void> {
  const hosts = parseHostList(input.hosts).filter((h) => h !== "*").join("\n");
  const existing = await prisma.envSecret.findUnique({ where: { repo_name: { repo: input.repo, name: input.name } } });
  if (!existing && !input.value) throw new Error("Enter a value.");
  const value = input.value ? encrypt(input.value, await masterKey()) : existing!.value;
  await prisma.envSecret.upsert({
    where: { repo_name: { repo: input.repo, name: input.name } },
    update: { value, hosts, exposed: input.exposed },
    create: { name: input.name, repo: input.repo, value, hosts, exposed: input.exposed },
  });
}
