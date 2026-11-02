import { z } from "zod";
import type { AgentInstall, AgentLaunch, RegistryAgent } from "./providers";

// Keeping added agents current: what the ACP registry lists now, with npm
// packages it doesn't pin pinned to their latest release, compared with what an
// agent was installed at.

export const RegistryAgentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/i),
  name: z.string().max(100),
  version: z.string().max(100),
  description: z.string().max(1000).optional(),
  website: z.string().max(500).optional(),
  repository: z.string().max(500).optional(),
  icon: z.string().max(500).optional(),
  distribution: z.record(z.string(), z.any()),
});

/** The registry's agents; entries that don't parse are left out. */
export function parseRegistry(body: unknown): RegistryAgent[] {
  const list = (body as { agents?: unknown[] } | null)?.agents;
  return (Array.isArray(list) ? list : []).flatMap((a) => {
    const parsed = RegistryAgentSchema.safeParse(a);
    return parsed.success ? [parsed.data as RegistryAgent] : [];
  });
}

/** "pkg@1.2.3" → ["pkg", "1.2.3"]; "@scope/pkg" → ["@scope/pkg", null]. */
export function splitPackage(spec: string): [string, string | null] {
  const at = spec.lastIndexOf("@");
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1) || null] : [spec, null];
}

const EXACT = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/**
 * An install with every npm package pinned to an exact version: one with no
 * version (or a range) gets its latest release. Without a pin, the image
 * build's cache would keep whatever version it first installed, forever.
 */
export async function pinInstall(install: AgentInstall, latest: (name: string) => Promise<string | null>): Promise<AgentInstall> {
  if (install.kind !== "npm") return install;
  const packages: string[] = [];
  for (const spec of install.packages) {
    const [name, version] = splitPackage(spec);
    if (version && EXACT.test(version)) {
      packages.push(spec);
      continue;
    }
    const v = await latest(name);
    packages.push(v ? `${name}@${v}` : spec);
  }
  return { kind: "npm", packages };
}

/** The latest version of an npm package, from the public registry. */
export async function npmLatest(name: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const res = await fetcher(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) return null;
  const v = ((await res.json().catch(() => null)) as { version?: unknown } | null)?.version;
  return typeof v === "string" && EXACT.test(v) ? v : null;
}

/** JSON with object keys sorted: a launch read back from Postgres (jsonb) has its keys in another order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Whether two launches install and start the same thing. */
export function sameLaunch(a: AgentLaunch, b: AgentLaunch): boolean {
  const norm = (l: AgentLaunch) => canonical([l.install, l.args ?? [], l.env ?? {}]);
  return norm(a) === norm(b);
}

/**
 * A version to show and to remember: the registry's version, plus any other
 * pinned packages ("0.0.35 · pi-coding-agent 1.5.0").
 */
export function launchVersion(launch: AgentLaunch, registryVersion?: string | null): string {
  const parts: string[] = [];
  if (registryVersion) parts.push(registryVersion);
  if (launch.install.kind === "npm") {
    launch.install.packages.forEach((spec, i) => {
      const [name, version] = splitPackage(spec);
      if (!version) return;
      // The first package is the one the registry versions.
      if (i === 0 && registryVersion && version === registryVersion) return;
      parts.push(`${name.replace(/^@[^/]+\//, "")} ${version}`);
    });
  }
  return parts.join(" · ") || "unversioned";
}
