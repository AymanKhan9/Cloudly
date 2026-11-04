import { z } from 'zod';
import { agentReadiness, harnessAvailable, listProviders, prisma, type AgentReadiness } from '@repo/db';
import { isProviderHarness, providerDisplayName, agentFeatures } from '@repo/shared/providers';

export const HARNESSES = [
  { id: 'native-claude', name: 'Claude Code', cost: 'exact' },
  { id: 'native-codex', name: 'Codex', cost: 'estimated' },
  { id: 'gemini-acp', name: 'Gemini CLI', cost: 'estimated' },
] as const;

const BUILTIN_IDS = HARNESSES.map((h) => h.id);

/** A built-in agent, or one added under Settings > Agents and turned on. */
export const HarnessId = z
  .string()
  .max(80)
  .refine((id) => harnessAvailable(id, BUILTIN_IDS), "Unknown agent, or it's turned off under Settings > Agents.");

/** The same check outside a request body (query strings). */
export async function isHarness(id: string): Promise<boolean> {
  return harnessAvailable(id, BUILTIN_IDS);
}

export interface HarnessInfo {
  id: string;
  name: string;
  /** "none": an added agent with no prices set, so its turns record no cost. */
  cost: 'exact' | 'estimated' | 'none';
  /** Added agents: their mark (a catalog or registry icon URL). */
  icon?: string | null;
  /** Added agents: a key it can't run without isn't set yet. */
  missing?: string[];
  /** Signed in (and for an added agent, on and installed), so a turn can start now. */
  ready: boolean;
  /** Why not, when it isn't. */
  reason?: string;
  /** Added agents: the models it offered at the start of its last turn, so one can be picked before a session starts. */
  models?: { value: string; label: string }[];
  /** And the one it uses when none is picked. */
  defaultModel?: string;
}

/**
 * An added agent lists its models only once a session starts, so the list is
 * the one from its most recent turns that reported one.
 */
export async function reportedModels(harness: string): Promise<{ models: { value: string; label: string }[]; defaultModel?: string } | null> {
  const runs = await prisma.run.findMany({ where: { harness }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true } });
  if (!runs.length) return null;
  const events = await prisma.runEvent.findMany({
    where: { runId: { in: runs.map((r) => r.id) }, kind: 'status', data: { path: ['type'], equals: 'models' } },
    orderBy: { ts: 'desc' },
    take: 1,
    select: { data: true },
  });
  const d = events[0]?.data as { current?: unknown; options?: unknown } | undefined;
  if (!d || !Array.isArray(d.options)) return null;
  const models = (d.options as { value?: unknown; label?: unknown }[])
    .filter((o) => typeof o?.value === 'string')
    .slice(0, 400)
    .map((o) => ({ value: String(o.value), label: typeof o.label === 'string' ? o.label : String(o.value) }));
  return models.length ? { models, ...(typeof d.current === 'string' ? { defaultModel: d.current } : {}) } : null;
}

/** Built-in agents, then the added ones that are turned on. */
export async function listHarnesses(): Promise<HarnessInfo[]> {
  const added = (await listProviders()).filter((p) => p.enabled);
  const list: Omit<HarnessInfo, 'ready'>[] = [
    ...HARNESSES.map((h) => ({ ...h })),
    ...added.map((p) => ({
      id: p.id,
      name: p.name,
      // Pi and OpenCode report what their turns cost; others only with prices set.
      cost: agentFeatures(p.id).cost
        ? ('exact' as const)
        : process.env[`PRICE_${p.id.toUpperCase().replace(/-/g, '_')}_INPUT_PER_MTOK`] ? ('estimated' as const) : ('none' as const),
      icon: p.icon,
      missing: p.missing,
    })),
  ];
  return Promise.all(list.map(async (h) => {
    const [r, offered] = await Promise.all([agentReadiness(h.id), isProviderHarness(h.id) ? reportedModels(h.id) : null]);
    return { ...h, ready: r.ready, ...(r.reason ? { reason: r.reason } : {}), ...(offered ?? {}) };
  }));
}

/** Readiness for any agents by id, including ones that aren't added. */
export async function checkAgents(ids: string[], names: Record<string, string> = {}): Promise<AgentReadiness[]> {
  return Promise.all([...new Set(ids)].slice(0, 30).map((id) => agentReadiness(id, names[id])));
}

export function harnessName(id: string): string {
  return HARNESSES.find((h) => h.id === id)?.name ?? (isProviderHarness(id) ? providerDisplayName(id) : id);
}

export function threadTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0]!.replace(/\s+/g, ' ');
  return line.length > 64 ? `${line.slice(0, 63).trimEnd()}…` : line;
}
