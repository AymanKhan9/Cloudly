import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  prisma, listProviders, getProvider, addProvider, updateProvider, deleteProvider, setProviderCredentials,
  removeProviderCredential,
} from "@repo/db";
import {
  ACP_REGISTRY_URL, BUILTIN_AGENTS, PROVIDER_CATALOG, catalogEntry, catalogLaunch, launchFromRegistry,
  providerIdFrom, registryInstallable, type ProviderSpec, type RegistryAgent,
} from "@repo/shared/providers";
import type { AuthEnv } from "./middleware/auth_middleware";

// Settings > Agents: agents beyond the three built in, added the way T3 Code
// adds providers. From Cloudly's catalog, from the public ACP registry, or a
// command the user enters. The worker installs each into the sandbox image and
// runs it over ACP; its keys stay here and reach the sandbox as placeholders.

export const agents = new Hono<AuthEnv>();

const RegistryAgentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/i),
  name: z.string().max(100),
  version: z.string().max(100),
  description: z.string().max(1000).optional(),
  website: z.string().max(500).optional(),
  repository: z.string().max(500).optional(),
  icon: z.string().max(500).optional(),
  distribution: z.record(z.string(), z.any()),
});

let registryCache: { at: number; agents: RegistryAgent[] } | null = null;
const REGISTRY_TTL_MS = 60 * 60 * 1000;

/** The ACP registry, fetched at most hourly. Entries that don't parse are left out. */
export async function fetchRegistry(fetcher: typeof fetch = fetch): Promise<RegistryAgent[]> {
  if (registryCache && Date.now() - registryCache.at < REGISTRY_TTL_MS) return registryCache.agents;
  const res = await fetcher(process.env.ACP_REGISTRY_URL ?? ACP_REGISTRY_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`The ACP registry answered ${res.status}.`);
  const body = (await res.json()) as { agents?: unknown[] };
  const list = (Array.isArray(body.agents) ? body.agents : []).flatMap((a) => {
    const parsed = RegistryAgentSchema.safeParse(a);
    return parsed.success ? [parsed.data as RegistryAgent] : [];
  });
  registryCache = { at: Date.now(), agents: list };
  return list;
}

export function resetRegistryCache() {
  registryCache = null;
}

/** Catalog marks live in the web app; registry agents use the registry's own icon. */
const catalogIcon = (id: string) => `/logos/agents/${id.replace(/^acp-/, "")}.svg`;

/**
 * Registry icons, served from this origin: the web app draws them as CSS masks
 * (so they take the theme's text color), and masks need same-origin or CORS,
 * which the registry's CDN doesn't send.
 */
const registryIcon = (agent: RegistryAgent) => (agent.icon ? `/api/settings/agents/icon/${agent.id}` : null);
const ICON_HOST = "cdn.agentclientprotocol.com";
const ICON_MAX_BYTES = 64 * 1024;
const iconCache = new Map<string, string>();

agents.get("/", async (c) => {
  const image = await prisma.sandboxImage.findUnique({ where: { id: 1 } });
  // Installed once an image finished building after the agent was added. (An agent
  // whose own install failed inside a good build says so when a turn starts.)
  const builtAt = image?.status === "ready" && image.image !== "cloud-agents-base" ? image.updatedAt : null;
  return c.json({
    agents: (await listProviders()).map((a) => ({ ...a, installed: Boolean(builtAt && builtAt >= a.createdAt) })),
    catalog: PROVIDER_CATALOG.map((e) => ({ ...e, icon: e.unavailable ? null : catalogIcon(e.id) })),
    builtin: BUILTIN_AGENTS,
    image: image ? { status: image.status, updatedAt: image.updatedAt } : null,
  });
});

agents.get("/registry", async (c) => {
  let list: RegistryAgent[];
  try {
    list = await fetchRegistry();
  } catch (err) {
    return c.json({ message: `Couldn't load the ACP registry: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
  const added = new Set((await prisma.provider.findMany({ select: { sourceId: true } })).map((p) => p.sourceId));
  return c.json({
    agents: list.map((a) => {
      const catalog = PROVIDER_CATALOG.find((e) => e.registryId === a.id);
      return {
        id: a.id,
        name: a.name,
        version: a.version,
        description: a.description ?? "",
        website: a.website ?? a.repository ?? null,
        icon: registryIcon(a),
        installable: registryInstallable(a),
        // Added already, through the catalog or the registry.
        added: added.has(a.id) || Boolean(catalog && added.has(catalog.id)),
        catalogId: catalog?.id ?? null,
      };
    }),
  });
});

agents.get("/icon/:id", async (c) => {
  const id = c.req.param("id");
  let svg = iconCache.get(id);
  if (svg === undefined) {
    const agent = (await fetchRegistry().catch(() => [])).find((a) => a.id === id);
    let url: URL;
    try {
      url = new URL(agent?.icon ?? "");
    } catch {
      return c.body(null, 404);
    }
    if (url.protocol !== "https:" || url.hostname !== ICON_HOST) return c.body(null, 404);
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" }).catch(() => null);
    const body = res?.ok ? await res.text() : "";
    if (!body.trimStart().startsWith("<svg") || body.length > ICON_MAX_BYTES) return c.body(null, 404);
    iconCache.set(id, (svg = body));
  }
  return c.body(svg, 200, {
    "content-type": "image/svg+xml",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=86400",
  });
});

const KeysSchema = z.object({
  values: z.record(z.string(), z.string().max(8000).nullable()).default({}),
  define: z.array(z.object({ env: z.string().max(64), hosts: z.array(z.string().max(253)).max(20), label: z.string().max(80).optional() })).max(20).default([]),
});

const AddSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog"), id: z.string().max(80) }),
  z.object({ kind: z.literal("registry"), id: z.string().max(80) }),
  z.object({
    kind: z.literal("custom"),
    name: z.string().trim().min(1).max(64),
    command: z.string().trim().min(1).max(500).refine((s) => !/[\n\r\0]/.test(s), "One line."),
    args: z.array(z.string().max(500).refine((s) => !/[\n\r\0]/.test(s), "One line each.")).max(30).default([]),
    installScript: z.string().max(20_000).default(""),
  }),
]).and(z.object({
  /** What it's called in Cloudly, if not its own name. */
  name: z.string().trim().max(64).optional(),
  hosts: z.array(z.string().max(253)).max(30).optional(),
  keys: KeysSchema.optional(),
}));

/** "acp-cursor", or "acp-cursor-2" when that's taken by an agent from somewhere else. */
async function freeId(base: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!(await prisma.provider.findUnique({ where: { id } }))) return id;
  }
  throw new Error("Too many agents with that name.");
}

agents.post("/", zValidator("json", AddSchema), async (c) => {
  const body = c.req.valid("json");
  let input: Parameters<typeof addProvider>[0];
  try {
    if (body.kind === "catalog" || (body.kind === "registry" && PROVIDER_CATALOG.some((e) => e.registryId === body.id))) {
      // A registry agent the catalog knows gets the catalog's keys and hosts.
      const entry = body.kind === "catalog" ? catalogEntry(body.id) : PROVIDER_CATALOG.find((e) => e.registryId === body.id);
      if (!entry) return c.json({ message: "No such agent in Cloudly's catalog." }, 404);
      if (entry.unavailable) return c.json({ message: entry.unavailable }, 400);
      const registry = entry.registryId ? await fetchRegistry() : [];
      const launch = catalogLaunch(entry, registry);
      if (!launch) return c.json({ message: `${entry.name} isn't in the ACP registry right now, so Cloudly can't tell how to install it.` }, 502);
      const listed = registry.find((a) => a.id === entry.registryId);
      input = {
        id: entry.id,
        name: body.name || entry.name,
        source: "catalog",
        sourceId: entry.id,
        version: listed?.version,
        icon: catalogIcon(entry.id),
        spec: { launch, credentials: entry.credentials, hosts: [...entry.hosts, ...(body.hosts ?? [])] },
      };
    } else if (body.kind === "registry") {
      const agent = (await fetchRegistry()).find((a) => a.id === body.id);
      if (!agent) return c.json({ message: "That agent isn't in the ACP registry." }, 404);
      const launch = launchFromRegistry(agent);
      if (!launch) return c.json({ message: `${agent.name} has no build for a Linux sandbox.` }, 400);
      input = {
        id: await freeId(providerIdFrom(agent.id)),
        name: body.name || agent.name,
        source: "registry",
        sourceId: agent.id,
        version: agent.version,
        icon: registryIcon(agent) ?? undefined,
        spec: { launch, credentials: [], hosts: body.hosts ?? [] },
      };
    } else {
      const spec: ProviderSpec = {
        launch: { install: { kind: "script", script: body.installScript.trim(), cmd: body.command }, args: body.args },
        credentials: [],
        hosts: body.hosts ?? [],
      };
      input = { id: await freeId(providerIdFrom(body.name)), name: body.name, source: "custom", spec };
    }
  } catch (err) {
    return c.json({ message: `Couldn't load the ACP registry: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }

  let added;
  try {
    added = await addProvider(input);
  } catch (err) {
    return c.json({ message: err instanceof Error ? err.message : String(err) }, 400);
  }
  if (body.keys && (Object.keys(body.keys.values).length || body.keys.define.length)) {
    try {
      await setProviderCredentials(added.id, body.keys.values, body.keys.define);
    } catch (err) {
      // The agent is added; its keys can be fixed from its row.
      return c.json({ agent: await getProvider(added.id), message: err instanceof Error ? err.message : String(err) }, 201);
    }
  }
  return c.json({ agent: await getProvider(added.id) }, 201);
});

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  hosts: z.array(z.string().max(253)).max(30).optional(),
});

agents.patch("/:id", zValidator("json", PatchSchema), async (c) => {
  if (!(await getProvider(c.req.param("id")))) return c.json({ message: "No such agent." }, 404);
  try {
    await updateProvider(c.req.param("id"), c.req.valid("json"));
  } catch (err) {
    return c.json({ message: err instanceof Error ? err.message : String(err) }, 400);
  }
  return c.json({ agent: await getProvider(c.req.param("id")) });
});

agents.put("/:id/keys", zValidator("json", KeysSchema), async (c) => {
  if (!(await getProvider(c.req.param("id")))) return c.json({ message: "No such agent." }, 404);
  const { values, define } = c.req.valid("json");
  try {
    await setProviderCredentials(c.req.param("id"), values, define);
  } catch (err) {
    return c.json({ message: err instanceof Error ? err.message : String(err) }, 400);
  }
  return c.json({ agent: await getProvider(c.req.param("id")) });
});

agents.delete("/:id/keys/:env", async (c) => {
  const agent = await getProvider(c.req.param("id"));
  if (!agent) return c.json({ message: "No such agent." }, 404);
  // A catalog agent's own keys are part of it; only ones the user defined can go.
  if (agent.source === "catalog" && catalogEntry(agent.sourceId ?? "")?.credentials.some((k) => k.env === c.req.param("env"))) {
    return c.json({ message: "That key is part of the agent. Clear its value instead." }, 400);
  }
  await removeProviderCredential(agent.id, c.req.param("env"));
  return c.json({ agent: await getProvider(agent.id) });
});

agents.delete("/:id", async (c) => {
  await deleteProvider(c.req.param("id"));
  return c.body(null, 204);
});
