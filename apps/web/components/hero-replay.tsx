"use client";

import { useEffect, useMemo, useState } from "react";
import { CloudPlate } from "./cloud-plate";
import { Courses, type Course } from "./courses";
import { Barometer, Oktas, STATE_WORD, budgetStateFor } from "./notation";
import { HARNESSES, usd, type HarnessId } from "@/lib/harness";

interface Step {
  kind: Course["kind"];
  body: string;
  cost?: number;
}

// Illustrative run on a fictional repo, shaped like the events each harness
// adapter actually emits. Labeled as illustrative wherever it renders.
const REPLAYS: Record<HarnessId, Step[]> = {
  "native-claude": [
    { kind: "status", body: "Cloned acme/billing-api at 4e1c09b into a fresh sandbox" },
    { kind: "text", body: "I'll add per-key rate limiting to POST /invoices." },
    { kind: "tool_call", body: "Read src/routes/invoices.ts" },
    { kind: "tool_call", body: "Edit src/middleware/rate-limit.ts" },
    { kind: "tool_call", body: "Bash  bun test" },
    { kind: "tool_result", body: "41 pass · 0 fail" },
    { kind: "text", body: "Added a token bucket keyed on the API key, 60 req/min." },
    { kind: "done", body: "Turn complete · cost reported by Claude", cost: 0.38 },
    { kind: "status", body: "Patch exported · commit 7f3a2d1 · pushed agent/run-c41e" },
    { kind: "pr", body: "acme/billing-api #214 opened" },
  ],
  "native-codex": [
    { kind: "status", body: "Cloned acme/billing-api at 4e1c09b into a fresh sandbox" },
    { kind: "text", body: "Planning: add a rate limiter in front of POST /invoices." },
    { kind: "tool_call", body: "command  rg -n \"invoices\" src" },
    { kind: "tool_call", body: "file_change  src/middleware/rate-limit.ts" },
    { kind: "tool_call", body: "command  bun test" },
    { kind: "tool_result", body: "41 pass · 0 fail" },
    { kind: "text", body: "Token bucket in place; tests cover the 429 path." },
    { kind: "done", body: "Turn complete · 182k in / 9k out tokens", cost: 0.32 },
    { kind: "status", body: "Patch exported · commit 7f3a2d1 · pushed agent/run-c41e" },
    { kind: "pr", body: "acme/billing-api #214 opened" },
  ],
  "gemini-acp": [
    { kind: "status", body: "Cloned acme/billing-api at 4e1c09b into a fresh sandbox" },
    { kind: "text", body: "I'll rate-limit POST /invoices per API key." },
    { kind: "tool_call", body: "read_file  src/routes/invoices.ts" },
    { kind: "tool_call", body: "replace  src/middleware/rate-limit.ts" },
    { kind: "tool_call", body: "run_shell_command  bun test" },
    { kind: "tool_result", body: "41 pass · 0 fail" },
    { kind: "text", body: "Done: 60 requests per minute per key, 429 beyond that." },
    { kind: "done", body: "Turn complete · 211k in / 8k out tokens", cost: 0.09 },
    { kind: "status", body: "Patch exported · commit 7f3a2d1 · pushed agent/run-c41e" },
    { kind: "pr", body: "acme/billing-api #214 opened" },
  ],
};

// The illustrative month the replay's run lands in: already $15.70 of a $20
// limit, so a run's cost visibly moves the needle toward Change.
const MONTH_BEFORE = 15.7;
const MONTH_LIMIT = 20;

const STEP_MS = 1300;
const HOLD_MS = 4400;

function stamp(i: number) {
  const s = 4 + i * 23;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function HeroReplay() {
  const [harnessId, setHarnessId] = useState<HarnessId>("native-claude");
  const [shown, setShown] = useState(0);
  const [reduced, setReduced] = useState(false);
  const harness = HARNESSES.find((h) => h.id === harnessId)!;
  const steps = REPLAYS[harnessId];

  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    if (reduced) {
      setShown(steps.length);
      return;
    }
    setShown(0);
    let i = 0;
    let timer: number;
    const tick = () => {
      i = i >= steps.length ? 0 : i + 1;
      setShown(i);
      timer = window.setTimeout(tick, i === steps.length ? HOLD_MS : i === 0 ? 900 : STEP_MS);
    };
    timer = window.setTimeout(tick, 700);
    return () => window.clearTimeout(timer);
  }, [harnessId, reduced, steps.length]);

  const visible = steps.slice(0, Math.min(shown, steps.length));
  const progress = visible.length / steps.length;
  const cost = visible.reduce((sum, s) => sum + (s.cost ?? 0), 0);
  const finished = visible.at(-1)?.kind === "pr";
  const statusWord = visible.length === 0 ? "Queued" : finished ? "PR opened" : progress > 0.75 ? "Opening PR" : "Running";
  const month = MONTH_BEFORE + cost;
  const monthState = budgetStateFor(month / MONTH_LIMIT);

  const courses: Course[] = useMemo(
    () =>
      visible.slice(-4).map((s, idx) => {
        const i = visible.length - Math.min(4, visible.length) + idx;
        return { key: `${harnessId}-${i}`, at: stamp(i), kind: s.kind, body: s.body };
      }),
    [visible, harnessId],
  );

  return (
    <figure className="plate mount" style={{ margin: 0 }}>
      <div className="mount-head">
        <span className="caps">Plate I</span>
        <div className="harness-switch" role="group" aria-label="Harness">
          {HARNESSES.map((h) => (
            <button key={h.id} type="button" aria-pressed={h.id === harnessId} onClick={() => setHarnessId(h.id)}>
              {h.name}
            </button>
          ))}
        </div>
      </div>

      <div className="mount-window plate-sky">
        <CloudPlate
          growth={0.1 + progress * 0.9}
          genus={harness.genusIndex}
          label={`${harness.genus} cloud growing as the ${harness.name} run progresses`}
        />
        <div className="plate-overlay">
          <span className="latin genus">{harness.genus}</span>
          <span className="harness">{harness.name}</span>
        </div>
      </div>

      <div className="mount-log" style={{ minHeight: 4 * 37 }} aria-live="polite">
        <Courses courses={courses} animate={!reduced} />
      </div>

      <div className="mount-foot">
        <div className="mount-status">
          <Oktas eighths={finished ? 8 : Math.round(progress * 7)} title={`Progress ${Math.round(progress * 100)}%`} />
          <span className="stamp" data-inked={finished || undefined}>
            {statusWord}
          </span>
        </div>
        <div className="mount-reading">
          <Barometer compact tone="light" ratio={month / MONTH_LIMIT} spentLabel={usd(month)} limitLabel={usd(MONTH_LIMIT)} className="mini-dial" />
          <div>
            <span className="num cost">
              {cost ? usd(cost, harness.cost === "estimated") : "$0.00"}
            </span>
            <span className="sub">
              {harness.cost === "exact" ? "reported" : "estimated"} · month{" "}
              <span className="num">{usd(month)}</span> of {usd(MONTH_LIMIT)}, {STATE_WORD[monthState]}
            </span>
          </div>
        </div>
      </div>

      <figcaption className="mount-caption">
        <span>
          <span className="latin">
            {harness.genus} {harness.species}
          </span>
          , observed on your station.
        </span>
        <span>Illustrative run and spend</span>
      </figcaption>
    </figure>
  );
}
