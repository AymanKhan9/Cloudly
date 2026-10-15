export type HarnessId = "native-claude" | "native-codex" | "gemini-acp";

export interface Harness {
  id: HarnessId;
  name: string;
  cost: "exact" | "estimated";
}

export const HARNESSES: Harness[] = [
  { id: "native-claude", name: "Claude Agent", cost: "exact" },
  { id: "native-codex", name: "Codex", cost: "estimated" },
  { id: "gemini-acp", name: "Gemini CLI", cost: "estimated" },
];

/**
 * Models offered by the /model menu. The agents accept any model ID their
 * vendor serves, so the menu also lets you type one; these are the common picks.
 * Codex: developers.openai.com/codex/models. Gemini: geminicli.com/docs/cli/model.
 */
export const MODELS: Record<HarnessId, { value: string; label: string; hint?: string }[]> = {
  "native-claude": [
    { value: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Most capable" },
    { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { value: "claude-fable-5-1", label: "Claude Fable 5.1" },
    { value: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Fastest" },
  ],
  "native-codex": [{ value: "gpt-5.5", label: "GPT-5.5" }],
  "gemini-acp": [
    { value: "gemini-3-pro-preview", label: "Gemini 3 Pro", hint: "Preview" },
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash", hint: "Preview" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
};

export function harnessById(id: string): Harness {
  return (
    HARNESSES.find((h) => h.id === id) ?? {
      id: id as HarnessId,
      name: id,
      cost: "estimated",
    }
  );
}

export function usd(n: number | null | undefined, estimated = false): string {
  if (n === null || n === undefined) return "-";
  const v = n < 1 ? n.toFixed(3).replace(/0$/, "") : n.toFixed(2);
  return `${estimated ? "~" : ""}$${v}`;
}

export type RunStatus = "queued" | "running" | "finalizing" | "succeeded" | "failed" | "cancelled";

export const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  finalizing: "Opening PR",
  succeeded: "PR opened",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

