import type { RunEvent } from "@repo/shared/run-event";

export interface RunCost {
  usd: number;
  estimated: boolean;
}

// USD per million tokens. These are defaults for estimating harnesses that
// report tokens rather than dollars; override them in .env to match the
// model you actually run. Claude Code reports exact USD and ignores these.
function price(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tokensToUsd(input: number, output: number, prefix: string, inDefault: number, outDefault: number): number {
  return (
    (input / 1_000_000) * price(`${prefix}_INPUT_PER_MTOK`, inDefault) +
    (output / 1_000_000) * price(`${prefix}_OUTPUT_PER_MTOK`, outDefault)
  );
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Cost of a run from its `done` event, or null when the harness reported nothing usable. */
export function costFromDoneEvent(harness: string, event: Pick<RunEvent, "kind" | "data">): RunCost | null {
  if (!event.data || typeof event.data !== "object") return null;
  const data = event.data as Record<string, any>;

  // Claude reports cost on failed results too (budget reached, crashes); that spend counts.
  if (harness === "native-claude") {
    if (event.kind !== "done" && event.kind !== "error") return null;
    return typeof data.totalCostUsd === "number" ? { usd: data.totalCostUsd, estimated: false } : null;
  }
  if (event.kind !== "done") return null;

  switch (harness) {

    case "native-codex": {
      const usage = data.usage;
      if (!usage) return null;
      return {
        usd: tokensToUsd(num(usage.input_tokens), num(usage.output_tokens), "PRICE_CODEX", 1.25, 10),
        estimated: true,
      };
    }

    case "gemini-acp": {
      const tokens = data._meta?.quota?.token_count;
      if (!tokens) return null;
      return {
        usd: tokensToUsd(num(tokens.input_tokens), num(tokens.output_tokens), "PRICE_GEMINI", 0.3, 2.5),
        estimated: true,
      };
    }

    default:
      return null;
  }
}
