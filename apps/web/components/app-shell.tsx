"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { GearSix, List, NotePencil, SidebarSimple, SignOut, Warning, X } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { usd } from "@/lib/harness";
import { useApp } from "./app-context";
import { Mark } from "./icons";
import { ThemeToggle } from "./theme-toggle";
import { SpendBar } from "./status";
import { SessionList } from "./session-list";
import { RAIL_KEY } from "@/lib/theme";

/** Collapses or expands the sidebar, remembered in this browser. */
function setRail(closed: boolean) {
  if (closed) document.documentElement.dataset.rail = "closed";
  else delete document.documentElement.dataset.rail;
  try {
    localStorage.setItem(RAIL_KEY, closed ? "closed" : "open");
  } catch {}
}

// Pages that live under Settings (see app/app/(manage)).
const MANAGE = ["/app/settings", "/app/plans", "/app/scorecard", "/app/lessons", "/app/import", "/app/schedules"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, budget } = useApp();
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState(false);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => setClosed(document.documentElement.dataset.rail === "closed"), []);
  const toggleRail = () => {
    const next = document.documentElement.dataset.rail !== "closed";
    setRail(next);
    setClosed(next);
  };

  // Ctrl/Cmd+K starts a new session from anywhere in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        router.push("/app");
      }
      // Ctrl/Cmd+B shows or hides the sidebar.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleRail();
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  async function signOut() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    window.location.assign("/signin");
  }

  const state = budget?.limitUsd ? budget.state : "fair";

  return (
    <div className="shell">
      <aside className="rail" data-open={open || undefined} aria-label="Sessions">
        <div className="rail-head">
          <Link href="/app" className="wordmark" aria-label="Cloudly, new session">
            <Mark />
            Cloudly
          </Link>
          <button type="button" className="icon-btn mobile-only" onClick={() => setOpen(false)} aria-label="Close menu">
            <X size={18} />
          </button>
          <button type="button" className="icon-btn desktop-only" onClick={toggleRail} aria-label="Hide the sidebar" aria-expanded={!closed} title="Hide the sidebar (Ctrl B)">
            <SidebarSimple size={18} />
          </button>
        </div>

        <Link href="/app" className="btn btn-secondary rail-new" aria-current={pathname === "/app" ? "page" : undefined}>
          <NotePencil size={16} />
          New session
          <kbd>Ctrl K</kbd>
        </Link>

        <nav className="rail-list" aria-label="Sessions">
          <SessionList pathname={pathname} />
        </nav>

        <div className="rail-foot">
          {budget ? (
            <Link href="/app/settings" className="rail-spend" aria-label="Spend this month, open settings">
              <span className="row">
                <span>{budget.limitUsd ? "Spend this month" : "Spend, no limit set"}</span>
                <span className="num">
                  {usd(budget.spentUsd)}
                  {budget.limitUsd ? ` / ${usd(budget.limitUsd)}` : ""}
                </span>
              </span>
              {budget.limitUsd ? <SpendBar ratio={budget.ratio} state={state} /> : null}
            </Link>
          ) : null}
          <Link href="/app/settings" className="rail-link" aria-current={MANAGE.some((p) => pathname.startsWith(p)) ? "page" : undefined}>
            <GearSix size={17} />
            Settings
          </Link>
          <div className="user-row">
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" />
            ) : (
              <span className="avatar" aria-hidden="true">
                {user?.login.slice(0, 1).toUpperCase() ?? ""}
              </span>
            )}
            <span className="name">{user?.login ?? ""}</span>
            <ThemeToggle />
            <button type="button" className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
              <SignOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="scrim" data-open={open || undefined} onClick={() => setOpen(false)} />

      {/* While the sidebar is hidden: a slim bar to bring it back. */}
      <nav className="rail-mini" aria-label="Sidebar hidden">
        <button type="button" className="icon-btn" onClick={toggleRail} aria-label="Show the sidebar" aria-expanded={!closed} title="Show the sidebar (Ctrl B)">
          <SidebarSimple size={18} />
        </button>
        <Link href="/app" className="icon-btn" aria-label="New session" title="New session (Ctrl K)">
          <NotePencil size={18} />
        </Link>
        <span className="spacer" />
        <Link href="/app/settings" className="icon-btn" aria-label="Settings" title="Settings" aria-current={MANAGE.some((p) => pathname.startsWith(p)) ? "page" : undefined}>
          <GearSix size={18} />
        </Link>
      </nav>

      <div className="main">
        <div className="mobile-bar">
          <button type="button" className="icon-btn" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
            <List size={20} />
          </button>
          <Link href="/app" className="wordmark">
            <Mark />
            Cloudly
          </Link>
          <Link href="/app" className="icon-btn" aria-label="New session">
            <NotePencil size={19} />
          </Link>
        </div>

        {state !== "fair" && budget?.limitUsd ? (
          <div className="banner" data-state={state} role="status">
            <Warning size={17} weight="bold" />
            <span>
              {state === "storm"
                ? `Spend limit reached: ${usd(budget.spentUsd)} of ${usd(budget.limitUsd)}. New runs are blocked; a turn that was already running finished first.`
                : `${Math.round(budget.ratio * 100)}% of this month's limit used (${usd(budget.spentUsd)} of ${usd(budget.limitUsd)}).`}
            </span>
            <Link href="/app/settings">{state === "storm" ? "Raise the limit" : "Review limit"}</Link>
          </div>
        ) : null}

        {children}
      </div>
    </div>
  );
}
