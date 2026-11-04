"use client";

import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import { DEFAULT_EFFORT, EFFORT_LABEL, effortLevels } from "@repo/shared/effort";
import { MODELS, type Harness, type HarnessId } from "@/lib/harness";
import { AgentLogo } from "./agent-logo";

export interface AgentChoice {
  harness: string;
  /** null: the agent's own default. */
  model: string | null;
  effort: string | null;
}

type Option = { value: string; label: string; hint?: string };

/**
 * One menu for the agent, its model and its effort, as in T3 Code: agents down
 * the left, the chosen agent's models in the middle (searchable, or type any
 * model ID), its effort levels on the right.
 */
export function AgentModelPicker({
  value,
  harnesses,
  onChange,
  offered,
  efforts,
  up = false,
  note,
  ref,
}: {
  value: AgentChoice;
  harnesses: Harness[];
  onChange: (next: AgentChoice) => void;
  /** Models the current agent reported on its last turn (added agents). */
  offered?: Option[];
  /** Effort levels the current agent reported (added agents). */
  efforts?: { current?: string; options: { value: string; label: string }[] } | null;
  up?: boolean;
  /** A line at the foot of the menu. */
  note?: string;
  /** show() opens it (the chat's "/model"). */
  ref?: React.Ref<{ show: () => void }>;
}) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState(value.harness);
  const [q, setQ] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ show: () => setOpen(true) }));

  useEffect(() => {
    if (!open) return;
    setViewing(value.harness);
    setQ("");
    window.requestAnimationFrame(() => search.current?.focus());
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, value.harness]);

  const agent = harnesses.find((h) => h.id === viewing);
  const models: Option[] = useMemo(() => {
    const list: Option[] = MODELS[viewing as HarnessId] ?? (viewing === value.harness && offered?.length ? offered : agent?.models ?? []);
    const words = q.trim().toLowerCase();
    return words ? list.filter((m) => `${m.label} ${m.value}`.toLowerCase().includes(words)) : list;
  }, [viewing, value.harness, offered, agent, q]);
  const levels: { value: string; label: string }[] =
    viewing === value.harness && efforts?.options.length ? efforts.options : effortLevels(viewing).map((l) => ({ value: l, label: EFFORT_LABEL[l] ?? l }));
  const defaultEffort = viewing === value.harness ? efforts?.current ?? DEFAULT_EFFORT[viewing as keyof typeof DEFAULT_EFFORT] : DEFAULT_EFFORT[viewing as keyof typeof DEFAULT_EFFORT];

  const current = harnesses.find((h) => h.id === value.harness);
  const modelLabel =
    value.model ? (MODELS[value.harness as HarnessId] ?? offered ?? current?.models ?? []).find((m) => m.value === value.model)?.label ?? value.model : "Default model";
  const effortLabel = value.effort ? EFFORT_LABEL[value.effort] ?? efforts?.options.find((o) => o.value === value.effort)?.label ?? value.effort : null;

  const pick = (next: Partial<AgentChoice>) => {
    const switching = viewing !== value.harness;
    onChange({
      harness: viewing,
      // Another agent starts from its own defaults unless something is picked for it.
      model: next.model !== undefined ? next.model : switching ? null : value.model,
      effort: next.effort !== undefined ? next.effort : switching ? null : value.effort,
    });
  };

  const typed = q.trim();
  return (
    <div className="amp" ref={root}>
      <button type="button" className="pill amp-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={`${current?.name ?? value.harness}: ${modelLabel}`}>
        <AgentLogo harness={value.harness} icon={current?.icon} size={15} />
        <span className="pill-text">{value.model ? modelLabel : current?.name ?? value.harness}</span>
        {effortLabel ? <span className="amp-effort">{effortLabel}</span> : null}
        <CaretDown size={11} className="pill-caret" />
      </button>
      {open ? (
        <div className="menu amp-pop" data-up={up || undefined} role="dialog" aria-label="Agent, model and effort">
          <div className="amp-agents" role="tablist" aria-label="Agents" aria-orientation="vertical">
            {harnesses.map((h) => (
              <button
                key={h.id}
                type="button"
                role="tab"
                aria-selected={viewing === h.id}
                className="amp-agent"
                title={h.ready === false ? `${h.name}: ${h.reason ?? "not ready"}` : h.name}
                data-off={h.ready === false || undefined}
                data-current={value.harness === h.id || undefined}
                onClick={() => setViewing(h.id)}
              >
                <AgentLogo harness={h.id} icon={h.icon} size={18} />
                <span className="amp-agent-label">{h.name}</span>
              </button>
            ))}
          </div>

          <div className="amp-models">
            <label className="amp-search">
              <MagnifyingGlass size={14} />
              <input
                ref={search}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search ${agent?.name ?? ""} models`}
                aria-label="Search models"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const first = models[0];
                    if (first) pick({ model: first.value });
                    else if (typed && !/\s/.test(typed)) pick({ model: typed });
                    setOpen(false);
                  }
                }}
              />
            </label>
            <p className="amp-agent-name">
              {agent?.name ?? viewing}
              {agent?.ready === false ? <span className="dim"> · {agent.reason ?? "not ready"}</span> : null}
            </p>
            <ul role="listbox" aria-label={`${agent?.name ?? ""} models`}>
              {!typed ? (
                <li>
                  <button type="button" role="option" aria-selected={viewing === value.harness && !value.model} onClick={() => (pick({ model: null }), setOpen(false))}>
                    <span className="t">Default model</span>
                    <span className="dim">Chosen by the agent</span>
                    {viewing === value.harness && !value.model ? <Check size={13} weight="bold" /> : null}
                  </button>
                </li>
              ) : null}
              {models.map((m) => {
                const on = viewing === value.harness && value.model === m.value;
                const hint = m.hint ?? (/(^|[-/ ])free$/i.test(m.value) ? "Free" : undefined);
                return (
                  <li key={m.value}>
                    <button type="button" role="option" aria-selected={on} onClick={() => (pick({ model: m.value }), setOpen(false))} title={m.value}>
                      <span className="t">{m.label}</span>
                      {hint ? <span className="dim">{hint}</span> : null}
                      {on ? <Check size={13} weight="bold" /> : null}
                    </button>
                  </li>
                );
              })}
              {typed && !/\s/.test(typed) && !models.some((m) => m.value === typed) ? (
                <li>
                  <button type="button" role="option" aria-selected={false} onClick={() => (pick({ model: typed }), setOpen(false))}>
                    <span className="t">Use {typed}</span>
                  </button>
                </li>
              ) : null}
              {!models.length && !typed ? <li className="amp-none">{agent?.name ?? "This agent"} lists its models once it has run a turn. Type a model ID to use one.</li> : null}
            </ul>
          </div>

          <div className="amp-efforts" role="group" aria-label="Effort">
            <p className="amp-col-head">Effort</p>
            {levels.length ? (
              <>
                {levels.map((l) => {
                  const on = viewing === value.harness && value.effort === l.value;
                  return (
                    <button key={l.value} type="button" aria-pressed={on} onClick={() => pick({ effort: l.value })}>
                      {l.label}
                      {l.value === defaultEffort ? <span className="dim">Default</span> : null}
                    </button>
                  );
                })}
                <button type="button" aria-pressed={viewing === value.harness && !value.effort} onClick={() => pick({ effort: null })}>
                  Agent&apos;s default
                </button>
              </>
            ) : (
              <p className="dim amp-none">Set by the model.</p>
            )}
          </div>
          {note ? <p className="amp-note">{note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
