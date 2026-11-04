import { checkProviderUpdates, type UpdateSources } from "@repo/db";
import { ACP_REGISTRY_URL } from "@repo/shared/providers";
import { parseRegistry, npmLatest } from "@repo/shared/agent-updates";
import { pause } from "./pause";

// Added agents' updates, every few hours (CLOUDLY_AGENT_UPDATE_HOURS, 6 by
// default; 0 turns the checks off). See packages/db/src/provider-updates.ts.

export const liveSources: UpdateSources = {
  async registry() {
    const res = await fetch(process.env.ACP_REGISTRY_URL ?? ACP_REGISTRY_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`the ACP registry answered ${res.status}`);
    return parseRegistry(await res.json());
  },
  npmLatest: (name) => npmLatest(name),
};

/** Fetches the registry once per check, however many agents ask for it. */
export function oncePerCheck(src: UpdateSources): UpdateSources {
  let registry: ReturnType<UpdateSources["registry"]> | null = null;
  return { registry: () => (registry ??= src.registry()), npmLatest: src.npmLatest };
}

export async function runAgentUpdateLoop(signal: AbortSignal): Promise<void> {
  const hours = Number(process.env.CLOUDLY_AGENT_UPDATE_HOURS ?? 6);
  if (!Number.isFinite(hours) || hours <= 0) return;
  // A minute after start, so a restart doesn't hold up the worker; then every few hours.
  await pause(60_000, signal);
  while (!signal.aborted) {
    try {
      const results = await checkProviderUpdates(oncePerCheck(liveSources));
      for (const r of results) console.log(`[agents] ${r.id}: ${r.from ?? "?"} → ${r.to} (${r.outcome})`);
    } catch (err) {
      console.error("[agents] update check failed:", err);
    }
    await pause(hours * 3600_000, signal);
  }
}
