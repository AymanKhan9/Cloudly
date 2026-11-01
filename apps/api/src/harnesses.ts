import { z } from 'zod';
import { harnessAvailable, listProviders } from '@repo/db';
import { isProviderHarness, providerDisplayName } from '@repo/shared/providers';

export const HARNESSES = [
  { id: 'native-claude', name: 'Claude Agent', cost: 'exact' },
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
}

/** Built-in agents, then the added ones that are turned on. */
export async function listHarnesses(): Promise<HarnessInfo[]> {
  const added = (await listProviders()).filter((p) => p.enabled);
  return [
    ...HARNESSES.map((h) => ({ ...h })),
    ...added.map((p) => ({
      id: p.id,
      name: p.name,
      cost: process.env[`PRICE_${p.id.toUpperCase().replace(/-/g, '_')}_INPUT_PER_MTOK`] ? ('estimated' as const) : ('none' as const),
      icon: p.icon,
      missing: p.missing,
    })),
  ];
}

export function harnessName(id: string): string {
  return HARNESSES.find((h) => h.id === id)?.name ?? (isProviderHarness(id) ? providerDisplayName(id) : id);
}

export function threadTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0]!.replace(/\s+/g, ' ');
  return line.length > 64 ? `${line.slice(0, 63).trimEnd()}…` : line;
}
