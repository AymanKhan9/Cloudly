"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";

interface Option {
  value: string;
  label: string;
  hint?: string;
}

/**
 * A select drawn by the page instead of the OS: native option popups ignore
 * the theme on some platforms and size to their longest option.
 */
export function Picker({
  label,
  icon,
  value,
  options,
  onChange,
  searchable = false,
  disabled = false,
  placeholder = "Choose",
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  searchable?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const current = options.find((o) => o.value === value);

  const show = () => {
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (o: Option) => {
    onChange(o.value);
    close();
  };

  useEffect(() => {
    if (!open) return;
    (searchable ? search.current : list.current)?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, searchable]);

  // Keep the highlighted option in view while moving with the keyboard.
  useEffect(() => {
    if (open) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = shown.length;
      if (n) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = shown[active];
      if (o) pick(o);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <div className="picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="pill"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={`${label}: ${current?.label ?? placeholder}`}
        title={current?.label}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
      >
        {icon}
        <span className="pill-text">{current?.label ?? placeholder}</span>
        <CaretDown size={11} className="pill-caret" />
      </button>

      {open ? (
        <div className="menu" onKeyDown={onKey}>
          {searchable ? (
            <div className="menu-search">
              <MagnifyingGlass size={14} />
              <input
                ref={search}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                placeholder={`Search ${label.toLowerCase()}`}
                aria-label={`Search ${label.toLowerCase()}`}
                aria-controls={`${id}-list`}
                aria-activedescendant={shown[active] ? `${id}-${active}` : undefined}
              />
            </div>
          ) : null}
          <div
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label={label}
            tabIndex={searchable ? -1 : 0}
            aria-activedescendant={!searchable && shown[active] ? `${id}-${active}` : undefined}
            className="menu-list"
          >
            {shown.length === 0 ? <p className="menu-empty">No matches</p> : null}
            {shown.map((o, i) => (
              <div
                key={o.value}
                id={`${id}-${i}`}
                data-i={i}
                role="option"
                aria-selected={o.value === value}
                data-active={i === active || undefined}
                className="menu-item"
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(o)}
              >
                <span className="menu-label">
                  {o.label}
                  {o.hint ? <small>{o.hint}</small> : null}
                </span>
                {o.value === value ? <Check size={14} weight="bold" /> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
