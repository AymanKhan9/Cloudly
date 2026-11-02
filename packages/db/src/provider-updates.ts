import { prisma, Prisma } from "./client";
import { catalogEntry, catalogLaunch, launchFromRegistry, type AgentLaunch, type ProviderSpec, type RegistryAgent } from "@repo/shared/providers";
import { pinInstall, sameLaunch, launchVersion } from "@repo/shared/agent-updates";

// Updates for added agents. A check compares what each catalog or registry
// agent was installed at with what the ACP registry (and npm, for packages it
// doesn't pin) has now. With auto-update on, a newer one replaces the agent's
// launch, which changes the image's install script, so the worker rebuilds the
// sandbox image; turns already running keep the image they started on. If the
// new version doesn't install, the build hook below puts the old one back and
// skips that version from then on. Agents added by command are never updated.

export interface UpdateSources {
  registry: () => Promise<RegistryAgent[]>;
  npmLatest: (name: string) => Promise<string | null>;
}

export interface UpdateResult {
  id: string;
  from: string | null;
  to: string;
  /** installing: the image is rebuilding with it; available: auto-update is off; skipped: it failed before. */
  outcome: "installing" | "available" | "skipped";
}

type Row = Awaited<ReturnType<typeof prisma.provider.findMany>>[number];
const json = (v: unknown) => v as Prisma.InputJsonValue;

/** What an agent would be installed at today, or null for one that can't be updated. */
export async function latestLaunch(row: Pick<Row, "id" | "source" | "sourceId">, src: UpdateSources): Promise<{ launch: AgentLaunch; version: string } | null> {
  let launch: AgentLaunch | null = null;
  let registryVersion: string | undefined;
  if (row.source === "catalog") {
    const entry = catalogEntry(row.sourceId ?? row.id);
    if (!entry || entry.unavailable) return null;
    const registry = entry.registryId ? await src.registry() : [];
    launch = catalogLaunch(entry, registry);
    registryVersion = registry.find((a) => a.id === entry.registryId)?.version;
  } else if (row.source === "registry") {
    const agent = (await src.registry()).find((a) => a.id === row.sourceId);
    if (!agent) return null;
    launch = launchFromRegistry(agent);
    registryVersion = agent.version;
  }
  if (!launch) return null;
  launch = { ...launch, install: await pinInstall(launch.install, src.npmLatest) };
  return { launch, version: launchVersion(launch, registryVersion) };
}

/** Switches an agent to a new launch; the image rebuilds with it. */
async function install(row: Row, launch: AgentLaunch, version: string) {
  const spec = row.spec as unknown as ProviderSpec;
  await prisma.provider.update({
    where: { id: row.id },
    data: {
      spec: json({ ...spec, launch }),
      version,
      previousLaunch: json(spec.launch),
      previousVersion: row.version,
      updateState: "updating",
      updateNote: `Installing ${version}.`,
      availableVersion: null,
      availableLaunch: Prisma.DbNull,
    },
  });
}

/** Checks every catalog and registry agent, and installs what's newer where auto-update is on. */
export async function checkProviderUpdates(src: UpdateSources, now = new Date()): Promise<UpdateResult[]> {
  const rows = await prisma.provider.findMany({ where: { source: { in: ["catalog", "registry"] } }, orderBy: { id: "asc" } });
  const results: UpdateResult[] = [];
  for (const row of rows) {
    // A build with an update in it hasn't finished: wait for it.
    if (row.updateState === "updating") continue;
    let latest: Awaited<ReturnType<typeof latestLaunch>>;
    try {
      latest = await latestLaunch(row, src);
    } catch (err) {
      console.warn(`[agents] couldn't check ${row.id} for updates: ${(err as Error).message}`);
      continue;
    }
    if (!latest) continue;
    const current = (row.spec as unknown as ProviderSpec).launch;
    if (sameLaunch(latest.launch, current)) {
      await prisma.provider.update({ where: { id: row.id }, data: { checkedAt: now, availableVersion: null, availableLaunch: Prisma.DbNull } });
      continue;
    }
    if (latest.version === row.skipVersion) {
      await prisma.provider.update({ where: { id: row.id }, data: { checkedAt: now } });
      results.push({ id: row.id, from: row.version, to: latest.version, outcome: "skipped" });
      continue;
    }
    if (row.autoUpdate) {
      await install(row, latest.launch, latest.version);
      await prisma.provider.update({ where: { id: row.id }, data: { checkedAt: now } });
      results.push({ id: row.id, from: row.version, to: latest.version, outcome: "installing" });
    } else {
      await prisma.provider.update({ where: { id: row.id }, data: { checkedAt: now, availableVersion: latest.version, availableLaunch: json(latest.launch) } });
      results.push({ id: row.id, from: row.version, to: latest.version, outcome: "available" });
    }
  }
  return results;
}

/** Installs the update a check found for an agent with auto-update off. */
export async function installAvailableUpdate(id: string): Promise<boolean> {
  const row = await prisma.provider.findUnique({ where: { id } });
  if (!row?.availableLaunch || !row.availableVersion || row.updateState === "updating") return false;
  await install(row, row.availableLaunch as unknown as AgentLaunch, row.availableVersion);
  return true;
}

/**
 * After an image build: updated agents that installed are done; any that
 * didn't (its install block reported failing, or the build failed) go back to
 * the version they had, and that version is skipped from then on.
 */
export async function settleProviderUpdates(build: { ok: boolean; log: string }, now = new Date()): Promise<{ updated: string[]; rolledBack: string[] }> {
  const rows = await prisma.provider.findMany({ where: { updateState: "updating" } });
  const out = { updated: [] as string[], rolledBack: [] as string[] };
  for (const row of rows) {
    // Its own install failed: that version is skipped. The whole build failed
    // for something else (the setup script): back to the old one for now, and
    // the new version is tried again at the next check.
    const itFailed = build.log.includes(`cloudly: ${row.id} failed to install`);
    const failed = itFailed || !build.ok;
    if (failed && row.previousLaunch) {
      const spec = row.spec as unknown as ProviderSpec;
      await prisma.provider.update({
        where: { id: row.id },
        data: {
          spec: json({ ...spec, launch: row.previousLaunch }),
          version: row.previousVersion,
          ...(itFailed ? { skipVersion: row.version } : {}),
          updateState: "failed",
          updateNote: itFailed
            ? `${row.version} didn't install, so it's back on ${row.previousVersion ?? "the version it had"}. That version won't be tried again.`
            : `The sandbox image didn't build, so it's back on ${row.previousVersion ?? "the version it had"} for now. ${row.version} will be tried again.`,
          previousLaunch: Prisma.DbNull,
          previousVersion: null,
        },
      });
      out.rolledBack.push(row.id);
    } else {
      await prisma.provider.update({
        where: { id: row.id },
        data: {
          updateState: "updated",
          updateNote: row.previousVersion ? `Updated from ${row.previousVersion} to ${row.version}.` : `Updated to ${row.version}.`,
          updatedVersionAt: now,
          previousLaunch: Prisma.DbNull,
          previousVersion: null,
        },
      });
      out.updated.push(row.id);
    }
  }
  return out;
}
