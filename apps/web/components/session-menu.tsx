"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { ThreadSummary } from "@/lib/api";

// A session's right-click menu in the sidebar, like T3 Code's thread menu. Copy
// gives ways to point at the session from elsewhere: paste its link, id or
// reference into another session and that session's agent can read it or send
// it a message (see the sessions tools).

/** Writes text to the clipboard, also where the async API isn't allowed (an instance on plain HTTP). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** How another session's agent is told about this one: everything it needs to find it. */
export function sessionReference(t: Pick<ThreadSummary, "id" | "title" | "repo" | "branch">): string {
  return t.repo
    ? `Cloudly session "${t.title}" (id ${t.id}) on ${t.repo}, branch ${t.branch}`
    : `Cloudly session "${t.title}" (id ${t.id}), no project`;
}

/** Where its work lives: the repo and branch, as a path on GitHub (T3 Code's "Copy path"). */
export function sessionPath(t: Pick<ThreadSummary, "repo" | "branch">): string {
  return `github.com/${t.repo}/tree/${t.branch}`;
}

export type MenuItem = Item;

type Item =
  | { kind: "action"; label: string; icon: React.ReactNode; run: () => void; done?: string; danger?: boolean }
  | { kind: "submenu"; label: string; icon: React.ReactNode; items: Item[] }
  | { kind: "separator" };

function MenuList({
  items,
  at,
  label,
  onDone,
  onBack,
  autoFocus,
}: {
  items: Item[];
  at: { x: number; y: number };
  label: string;
  onDone: (message?: string) => void;
  onBack?: () => void;
  autoFocus: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const [open, setOpen] = useState<number | null>(null);
  const [sub, setSub] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
  }, [at]);

  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [autoFocus]);

  const buttons = () => [...(ref.current?.querySelectorAll<HTMLElement>(":scope > [role=menuitem]") ?? [])];

  function openSub(i: number, target: HTMLElement) {
    const r = target.getBoundingClientRect();
    setSub({ x: r.right + 4, y: r.top - 5 });
    setOpen(i);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const list = buttons();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const next = list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length];
      next?.focus();
    } else if (e.key === "ArrowLeft" && onBack) {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (onBack) onBack();
      else onDone();
    }
  }

  return (
    <div ref={ref} className="ctx-menu" role="menu" aria-label={label} style={{ left: pos.x, top: pos.y }} onKeyDown={onKeyDown}>
      {items.map((item, i) => {
        if (item.kind === "separator") return <div key={i} className="ctx-sep" role="separator" />;
        if (item.kind === "submenu") {
          return (
            <button
              key={i}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open === i}
              className="ctx-item"
              onMouseEnter={(e) => openSub(i, e.currentTarget)}
              onClick={(e) => openSub(i, e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openSub(i, e.currentTarget);
                }
              }}
            >
              {item.icon}
              <span>{item.label}</span>
              <CaretRight size={12} className="ctx-caret" />
            </button>
          );
        }
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className="ctx-item"
            data-danger={item.danger || undefined}
            onMouseEnter={() => setOpen(null)}
            onClick={() => {
              item.run();
              onDone(item.done);
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        );
      })}
      {open !== null && items[open]?.kind === "submenu" ? (
        <MenuList
          items={(items[open] as Extract<Item, { kind: "submenu" }>).items}
          at={sub}
          label={(items[open] as Extract<Item, { kind: "submenu" }>).label}
          onDone={onDone}
          onBack={() => {
            const parent = buttons()[open];
            setOpen(null);
            parent?.focus();
          }}
          autoFocus
        />
      ) : null}
    </div>
  );
}

/** A right-click menu at `at`, closed by Escape, a click outside, scrolling or resizing. */
export function ContextMenu({ items, at, label, onClose }: { items: Item[]; at: { x: number; y: number }; label: string; onClose: (message?: string) => void }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose();
    };
    const blur = () => onClose();
    document.addEventListener("mousedown", away);
    window.addEventListener("resize", blur);
    window.addEventListener("scroll", blur, true);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("resize", blur);
      window.removeEventListener("scroll", blur, true);
    };
  }, [onClose]);

  return (
    <div ref={root}>
      <MenuList items={items} at={at} label={label} onDone={onClose} autoFocus />
    </div>
  );
}
