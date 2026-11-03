"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CalendarBlank, ChartBar, DownloadSimple, GearSix, Lightbulb, TreeStructure, List, NotePencil, SignOut, Warning, X } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { usd } from "@/lib/harness";
import { useApp } from "./app-context";
import { Mark } from "./icons";
import { ThemeToggle } from "./theme-toggle";
import { SpendBar } from "./status";
import { SessionList } from "./session-list";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, budget } = useApp();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  // Ctrl/Cmd+K starts a new session from anywhere in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        router.push("/app");
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
          <Link href="/app/plans" className="rail-link" aria-current={pathname.startsWith("/app/plans") ? "page" : undefined}>
            <TreeStructure size={17} />
            Plans
          </Link>
          <Link href="/app/scorecard" className="rail-link" aria-current={pathname.startsWith("/app/scorecard") ? "page" : undefined}>
            <ChartBar size={17} />
            Scorecard
          </Link>
          <Link href="/app/lessons" className="rail-link" aria-current={pathname.startsWith("/app/lessons") ? "page" : undefined}>
            <Lightbulb size={17} />
            Lessons
          </Link>
          <Link href="/app/import" className="rail-link" aria-current={pathname.startsWith("/app/import") ? "page" : undefined}>
            <DownloadSimple size={17} />
            Import
          </Link>
          <Link href="/app/schedules" className="rail-link" aria-current={pathname.startsWith("/app/schedules") ? "page" : undefined}>
            <CalendarBlank size={17} />
            Schedules
          </Link>
          <Link href="/app/settings" className="rail-link" aria-current={pathname.startsWith("/app/settings") ? "page" : undefined}>
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
