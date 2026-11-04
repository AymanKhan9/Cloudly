import { createHmac } from "node:crypto";
import {
  catalogEntry,
  isProviderHarness,
  providerInstallBlock,
  validProviderId,
  type ProviderCredential,
  type ProviderSpec,
} from "@repo/shared/providers";
import { prisma, Prisma } from "./client";
import { config, decrypt, encrypt, masterKey } from "./secrets";
import { ENV_NAME } from "./env-secrets";
import { parseHostList } from "./sandbox";

// Agents added under Settings > Agents (see @repo/shared/providers). Their keys
// are kept like every other secret here: encrypted at rest, and given to a run
// only as a placeholder the egress proxy swaps for the real value on HTTPS
// requests to that key's hosts.

/** Variables an agent's key may not take: they'd redirect the sandbox's traffic or tools. */
const RESERVED = /^(PATH|HOME|USER|SHELL|PWD|HOSTNAME|TERM|LANG|LC_.*|DISPLAY|(HTTPS?|NO|ALL)_PROXY|NODE_.*|BUN_.*|LD_.*|SSL_CERT_.*|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|GIT_.*|CONTROL_CONFIG_PATH|CLOUDLY_.*)$/i;

export function providerEnvProblem(name: string): string | null {
  if (!ENV_NAME.test(name)) return "Use capital letters, digits and underscores, starting with a letter or underscore.";
  if (RESERVED.test(name)) return `${name} is set by Cloudly or the sandbox and can't hold a key.`;
  return null;
}

export type ProviderSource = "catalog" | "registry" | "custom";

export interface ProviderCredentialView extends ProviderCredential {
  /** Its own value is saved. */
  set: boolean;
  /** Last four characters of its own value. */
  preview: string | null;
  /** No value of its own, but the Settings key it reuses is set. */
  reused: boolean;
}

export interface ProviderView {
  id: string;
  name: string;
  source: ProviderSource;
  sourceId: string | null;
  version: string | null;
  icon: string | null;
  enabled: boolean;
  spec: ProviderSpec;
  credentials: ProviderCredentialView[];
  /** A required key is missing, so turns can't start yet. */
  missing: string[];
  createdAt: Date;
  /** Updates (see provider-updates.ts). */
  autoUpdate: boolean;
  /** Try updates on past tasks before switching (see the worker's trials.ts). */
  testUpdates: boolean;
  availableVersion: string | null;
  updateState: string | null;
  updateNote: string | null;
  updatedVersionAt: Date | null;
  checkedAt: Date | null;
}

function readSecret(blob: string | null, key: Buffer): Record<string, string> {
  if (!blob) return {};
  try {
    return JSON.parse(decrypt(blob, key));
  } catch {
    return {};
  }
}

type ProviderRow = Awaited<ReturnType<typeof prisma.provider.findMany>>[number];

function specOf(row: ProviderRow): ProviderSpec {
  const spec = row.spec as unknown as ProviderSpec;
  // A catalog agent added before its entry gained a key or host gets them now.
  const entry = row.source === "catalog" ? catalogEntry(row.sourceId ?? "") : undefined;
  if (!entry) return spec;
  const keys = entry.credentials.filter((c) => !spec.credentials.some((k) => k.env === c.env));
  const hosts = entry.hosts.filter((h) => !spec.hosts.includes(h));
  return keys.length || hosts.length ? { ...spec, credentials: [...spec.credentials, ...keys], hosts: [...spec.hosts, ...hosts] } : spec;
}

async function view(row: ProviderRow, key: Buffer): Promise<ProviderView> {
  const own = readSecret(row.secret, key);
  const spec = specOf(row);
  const credentials: ProviderCredentialView[] = [];
  for (const c of spec.credentials) {
    const value = own[c.env];
    const reused = !value && Boolean(c.reuse && (await config(c.reuse)));
    credentials.push({ ...c, set: Boolean(value), preview: value ? `…${value.slice(-4)}` : null, reused });
  }
  return {
    id: row.id,
    name: row.name,
    source: row.source as ProviderSource,
    sourceId: row.sourceId,
    version: row.version,
    icon: row.icon,
    enabled: row.enabled,
    spec,
    credentials,
    missing: credentials.filter((c) => !c.optional && !c.set && !c.reused).map((c) => c.env),
    createdAt: row.createdAt,
    autoUpdate: row.autoUpdate,
    testUpdates: row.testUpdates,
    availableVersion: row.availableVersion,
    updateState: row.updateState,
    updateNote: row.updateNote,
    updatedVersionAt: row.updatedVersionAt,
    checkedAt: row.checkedAt,
  };
}

export async function listProviders(): Promise<ProviderView[]> {
  const key = await masterKey();
  const rows = await prisma.provider.findMany({ orderBy: { createdAt: "asc" } });
  return Promise.all(rows.map((r) => view(r, key)));
}

export async function getProvider(id: string): Promise<ProviderView | null> {
  const row = await prisma.provider.findUnique({ where: { id } });
  return row ? view(row, await masterKey()) : null;
}

/** An added agent that's turned on, so sessions may use it. */
export async function enabledProvider(id: string): Promise<ProviderView | null> {
  if (!isProviderHarness(id)) return null;
  const p = await getProvider(id);
  return p?.enabled ? p : null;
}

function cleanSpec(spec: ProviderSpec): ProviderSpec {
  const credentials = spec.credentials.map((c) => {
    const problem = providerEnvProblem(c.env);
    if (problem) throw new Error(problem);
    const hosts = parseHostList(c.hosts.join("\n")).filter((h) => h !== "*");
    if (!hosts.length) throw new Error(`Name the hosts ${c.env} is sent to; Cloudly fills it in only for those.`);
    return { ...c, hosts };
  });
  if (new Set(credentials.map((c) => c.env)).size !== credentials.length) throw new Error("Each key needs its own variable name.");
  return { ...spec, credentials, hosts: parseHostList(spec.hosts.join("\n")).filter((h) => h !== "*") };
}

export async function addProvider(input: {
  id: string;
  name: string;
  source: ProviderSource;
  sourceId?: string;
  version?: string;
  icon?: string;
  spec: ProviderSpec;
}): Promise<ProviderView> {
  if (!validProviderId(input.id)) throw new Error("An agent id is lowercase letters, digits and dashes.");
  // Checked here so a bad spec never reaches the image build.
  providerInstallBlock(input.id, input.spec.launch);
  const spec = cleanSpec(input.spec);
  try {
    const row = await prisma.provider.create({
      data: {
        id: input.id,
        name: input.name.trim().slice(0, 64) || input.id,
        source: input.source,
        sourceId: input.sourceId ?? null,
        version: input.version ?? null,
        icon: input.icon ?? null,
        spec: spec as unknown as Prisma.InputJsonValue,
      },
    });
    return view(row, await masterKey());
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new Error(`${input.name} is already added. Remove it first to add it again.`);
    }
    throw err;
  }
}

export async function updateProvider(id: string, input: { name?: string; enabled?: boolean; hosts?: string[]; autoUpdate?: boolean; testUpdates?: boolean }): Promise<void> {
  const row = await prisma.provider.findUnique({ where: { id } });
  if (!row) throw new Error("No such agent.");
  const spec = input.hosts !== undefined ? cleanSpec({ ...specOf(row), hosts: input.hosts }) : undefined;
  await prisma.provider.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim().slice(0, 64) || id } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.autoUpdate !== undefined ? { autoUpdate: input.autoUpdate } : {}),
      ...(input.testUpdates !== undefined ? { testUpdates: input.testUpdates } : {}),
      ...(spec ? { spec: spec as unknown as Prisma.InputJsonValue } : {}),
    },
  });
}

export async function deleteProvider(id: string): Promise<void> {
  await prisma.provider.deleteMany({ where: { id } });
}

/**
 * Saves keys: a value sets one, null clears it. `define` adds keys the agent's
 * spec didn't list (registry and custom agents), with the hosts each may go to.
 */
export async function setProviderCredentials(
  id: string,
  values: Record<string, string | null>,
  define: { env: string; hosts: string[]; label?: string }[] = [],
): Promise<void> {
  const row = await prisma.provider.findUnique({ where: { id } });
  if (!row) throw new Error("No such agent.");
  const spec = specOf(row);
  const credentials = [...spec.credentials];
  for (const d of define) {
    const existing = credentials.findIndex((c) => c.env === d.env);
    const entry: ProviderCredential = { env: d.env, label: d.label ?? d.env, hosts: d.hosts };
    if (existing >= 0) credentials[existing] = { ...credentials[existing]!, hosts: d.hosts };
    else credentials.push(entry);
  }
  const next = cleanSpec({ ...spec, credentials });
  const key = await masterKey();
  const own = readSecret(row.secret, key);
  for (const [env, value] of Object.entries(values)) {
    if (!next.credentials.some((c) => c.env === env)) throw new Error(`${env} isn't one of this agent's keys.`);
    const v = value?.replace(/\s+/g, "");
    if (v) own[env] = v;
    else delete own[env];
  }
  // A key with no definition left has nothing to be sent to.
  for (const env of Object.keys(own)) if (!next.credentials.some((c) => c.env === env)) delete own[env];
  await prisma.provider.update({
    where: { id },
    data: { spec: next as unknown as Prisma.InputJsonValue, secret: Object.keys(own).length ? encrypt(JSON.stringify(own), key) : null },
  });
}

/** Drops a key the user defined (registry and custom agents). */
export async function removeProviderCredential(id: string, env: string): Promise<void> {
  const row = await prisma.provider.findUnique({ where: { id } });
  if (!row) return;
  const spec = specOf(row);
  const key = await masterKey();
  const own = readSecret(row.secret, key);
  delete own[env];
  await prisma.provider.update({
    where: { id },
    data: {
      spec: { ...spec, credentials: spec.credentials.filter((c) => c.env !== env) } as unknown as Prisma.InputJsonValue,
      secret: Object.keys(own).length ? encrypt(JSON.stringify(own), key) : null,
    },
  });
}

/** An unguessable stand-in for one agent's key, stable across runs. */
export async function providerPlaceholder(id: string, env: string): Promise<string> {
  return `cloudly-secret-${createHmac("sha256", await masterKey()).update(`provider:${id}:${env}`).digest("hex").slice(0, 24)}`;
}

export interface ProviderRunCredential {
  env: string;
  value: string;
  placeholder: string;
  hosts: string[];
}

/** An agent's keys for a run: its own, or the Settings key it reuses. */
async function resolveCredentials(row: ProviderRow, key: Buffer): Promise<{ resolved: ProviderRunCredential[]; missing: ProviderCredential[] }> {
  const own = readSecret(row.secret, key);
  const resolved: ProviderRunCredential[] = [];
  const missing: ProviderCredential[] = [];
  for (const c of specOf(row).credentials) {
    const value = own[c.env] || (c.reuse ? await config(c.reuse) : undefined);
    if (value) resolved.push({ env: c.env, value, placeholder: await providerPlaceholder(row.id, c.env), hosts: c.hosts });
    else if (!c.optional) missing.push(c);
  }
  return { resolved, missing };
}

export async function providerRunCredentials(id: string): Promise<{ resolved: ProviderRunCredential[]; missing: ProviderCredential[] }> {
  const row = await prisma.provider.findUnique({ where: { id } });
  if (!row) throw new Error(`No agent "${id}" is added in Cloudly.`);
  return resolveCredentials(row, await masterKey());
}

/** Every added agent's keys, as the proxy fills them in. */
export async function providerProxySecrets(): Promise<{ placeholder: string; value: string; hosts: string[] }[]> {
  const key = await masterKey();
  const out: { placeholder: string; value: string; hosts: string[] }[] = [];
  for (const row of await prisma.provider.findMany({ where: { enabled: true } })) {
    for (const c of (await resolveCredentials(row, key)).resolved) out.push({ placeholder: c.placeholder, value: c.value, hosts: c.hosts });
  }
  return out;
}

/** Hosts the added agents need beyond their keys' (sign-in, model lists). */
export async function providerHosts(): Promise<string[]> {
  const rows = await prisma.provider.findMany({ where: { enabled: true } });
  return [...new Set(rows.flatMap((r) => specOf(r).hosts))];
}

/**
 * The image-build part for every added agent. Turned-off agents stay installed,
 * so turning one back on doesn't mean another download.
 */
export async function providerInstallScript(): Promise<string> {
  const rows = await prisma.provider.findMany({ orderBy: { id: "asc" } });
  return rows.map((r) => providerInstallBlock(r.id, specOf(r).launch)).join("\n\n");
}

/** Whether a harness id names an agent sessions may use: built in, or added and on. */
export async function harnessAvailable(id: string, builtin: readonly string[]): Promise<boolean> {
  return builtin.includes(id) || Boolean(await enabledProvider(id));
}

// --- Whether an agent can run now -------------------------------------------------

/** What each built-in agent signs in with, any one of them. */
const BUILTIN_SIGN_IN: Record<string, { name: string; keys: string[]; need: string }> = {
  "native-claude": { name: "Claude Code", keys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"], need: "an Anthropic API key or a Claude plan token under Settings → Keys and connections" },
  "native-codex": { name: "Codex", keys: ["OPENAI_API_KEY", "CODEX_AUTH_JSON"], need: "an OpenAI API key or a ChatGPT sign-in under Settings → Keys and connections" },
  "gemini-acp": { name: "Gemini CLI", keys: ["GEMINI_API_KEY"], need: "a Gemini API key under Settings → Keys and connections" },
};

export interface AgentReadiness {
  id: string;
  name: string;
  ready: boolean;
  /** Why not, in a sentence the user can act on. */
  reason?: string;
}

/** An added agent is installed once an image built after it was added is ready. */
export function providerInstalled(createdAt: Date, image: { status: string; image: string; updatedAt: Date } | null): boolean {
  return Boolean(image && image.status === "ready" && image.image !== "cloud-agents-base" && image.updatedAt >= createdAt);
}

/**
 * Whether an agent can take a turn now: signed in (a key or plan sign-in), and
 * for an added agent, turned on and installed. `name` is used for agents
 * Cloudly doesn't have at all.
 */
export async function agentReadiness(id: string, name?: string): Promise<AgentReadiness> {
  const builtin = BUILTIN_SIGN_IN[id];
  if (builtin) {
    for (const key of builtin.keys) if (await config(key)) return { id, name: builtin.name, ready: true };
    return { id, name: builtin.name, ready: false, reason: `${builtin.name} needs ${builtin.need}.` };
  }
  const p = isProviderHarness(id) ? await getProvider(id) : null;
  const label = p?.name ?? name ?? id;
  if (!p) {
    const unavailable = catalogEntry(id)?.unavailable;
    return { id, name: label, ready: false, reason: unavailable ? `${label} can't run in Cloudly: ${unavailable}` : `${label} isn't added. Add it under Settings → Agents.` };
  }
  if (!p.enabled) return { id, name: label, ready: false, reason: `${label} is turned off under Settings → Agents.` };
  if (p.missing.length) {
    const labels = p.credentials.filter((c) => p.missing.includes(c.env)).map((c) => `a ${c.label}`);
    return { id, name: label, ready: false, reason: `${label} needs ${labels.join(" and ")} under Settings → Agents.` };
  }
  const image = await prisma.sandboxImage.findUnique({ where: { id: 1 } });
  if (!providerInstalled(p.createdAt, image)) {
    return { id, name: label, ready: false, reason: image?.status === "failed" ? `${label} isn't installed: the sandbox image didn't build (see Settings → Sandbox tools).` : `${label} is still being installed into the sandbox image.` };
  }
  return { id, name: label, ready: true };
}
