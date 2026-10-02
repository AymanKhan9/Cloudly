"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApp } from "./app-context";
import { Mark, StormFlag } from "./icons";
import { Oktas, STATE_WORD } from "./notation";
import { api } from "@/lib/api";
import { usd } from "@/lib/harness";

const NAV = [
  { href: "/app", label: "New session" },
  { href: "/app/settings", label: "Settings" },
];

export function AppChrome() {
  const pathname = usePathname();
  const { user, budget } = useApp();

  async function signOut() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    window.location.assign("/signin");
  }

  const state = budget?.state ?? "fair";
  const eighths = budget?.limitUsd ? Math.min(8, Math.round(budget.ratio * 8)) : 0;

  return (
    <>
      <header className="app-bar">
        <div className="wrap">
          <Link href="/app" className="wordmark" aria-label="Cloudly home">
            <Mark />
            Cloudly
          </Link>
          <nav className="app-nav" aria-label="App">
            {NAV.map((n) => {
              const active = n.href === "/app" ? pathname === "/app" : pathname.startsWith(n.href);
              return (
                <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}>
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="app-user">
            {budget ? (
              <Link href="/app/settings" className="reading" data-state={state} aria-label="Spend limit settings">
                <span className="reading-text" style={{ color: "var(--mist)" }}>
                  Limit
                </span>
                <Oktas eighths={eighths} size={18} />
                <span className="caps">{budget.limitUsd ? STATE_WORD[state] : "None"}</span>
                <span className="num">
                  {usd(budget.spentUsd)}
                  {budget.limitUsd ? ` / ${usd(budget.limitUsd)}` : ""}
                </span>
              </Link>
            ) : null}
            {user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : null}
            <button type="button" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      {state !== "fair" && budget?.limitUsd ? (
        <div className="banner" data-state={state} role="status">
          <div className="wrap">
            {state === "storm" ? <StormFlag /> : null}
            <span>
              {state === "storm"
                ? `Spend limit reached: ${usd(budget.spentUsd)} of ${usd(budget.limitUsd)}. New runs are blocked and running ones were cancelled.`
                : `${Math.round(budget.ratio * 100)}% of this month's limit used (${usd(budget.spentUsd)} of ${usd(budget.limitUsd)}).`}
            </span>
            <Link href="/app/settings">{state === "storm" ? "Raise the limit" : "Review limit"}</Link>
          </div>
        </div>
      ) : null}
    </>
  );
}
