export type HarnessId = "native-claude" | "native-codex" | "gemini-acp";

export interface Harness {
  id: HarnessId;
  name: string;
  /** Each harness is classified under one cloud genus; the plate renders it. */
  genus: string;
  species: string;
  genusIndex: number;
  cost: "exact" | "estimated";
}

export const HARNESSES: Harness[] = [
  { id: "native-claude", name: "Claude Agent", genus: "Cumulus", species: "congestus", genusIndex: 0, cost: "exact" },
  { id: "native-codex", name: "Codex", genus: "Altocumulus", species: "stratiformis", genusIndex: 1, cost: "estimated" },
  { id: "gemini-acp", name: "Gemini CLI", genus: "Cirrus", species: "fibratus", genusIndex: 2, cost: "estimated" },
];

export function harnessById(id: string): Harness {
  return (
    HARNESSES.find((h) => h.id === id) ?? {
      id: id as HarnessId,
      name: id,
      genus: "Nubes",
      species: "incerta",
      genusIndex: 0,
      cost: "estimated",
    }
  );
}

export function usd(n: number | null | undefined, estimated = false): string {
  if (n === null || n === undefined) return "—";
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

/** Sky cover for a run status, in oktas. Running runs report their own progress. */
export function oktasFor(status: RunStatus, progress = 0.4): number {
  switch (status) {
    case "queued":
      return 0;
    case "running":
      return 1 + Math.round(progress * 5);
    case "finalizing":
      return 7;
    case "succeeded":
      return 8;
    default:
      return 8;
  }
}

export function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function roman(n: number): string {
  const table: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
    [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let out = "";
  let rest = Math.max(1, Math.floor(n));
  for (const [value, glyph] of table) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}
