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

