/**
 * How hard each agent thinks, as each one names it. Saved per session and
 * passed to every later turn. null means the agent's own default.
 * - Claude Agent SDK `effort`: xhigh and max only exist on some models; the SDK
 *   silently uses the nearest level the model has.
 * - Codex SDK `modelReasoningEffort`.
 * - Gemini CLI: no ACP option, so the runner sets thinkingLevel through a model
 *   config override in the session's ~/.gemini/settings.json (LOW or HIGH).
 */
export const EFFORT_LEVELS = {
  "native-claude": ["low", "medium", "high", "xhigh", "max"],
  "native-codex": ["low", "medium", "high", "xhigh"],
  "gemini-acp": ["low", "high"],
} as const satisfies Record<string, readonly string[]>;

/** The level each agent uses when none is chosen, for showing in the UI. */
export const DEFAULT_EFFORT: Record<keyof typeof EFFORT_LEVELS, string> = {
  "native-claude": "high",
  "native-codex": "medium",
  "gemini-acp": "high",
};

export const EFFORT_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLevels(harness: string): readonly string[] {
  return (EFFORT_LEVELS as Record<string, readonly string[]>)[harness] ?? [];
}
