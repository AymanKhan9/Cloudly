"use client";

import { Moon, Sun } from "@phosphor-icons/react";
import { THEME_KEY } from "@/lib/theme";


/** Switches between light and dark; until clicked, the system's theme applies. */
export function ThemeToggle({ className = "icon-btn" }: { className?: string }) {
  function toggle() {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
  }

  return (
    <button type="button" className={`${className} theme-toggle`} onClick={toggle} aria-label="Switch between light and dark" title="Switch between light and dark">
      <Sun size={17} className="to-light" />
      <Moon size={17} className="to-dark" />
    </button>
  );
}
