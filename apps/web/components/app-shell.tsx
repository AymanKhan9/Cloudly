"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { GearSix, List, NotePencil, SignOut, UsersThree, Warning, X } from "@phosphor-icons/react";
import { api, type CouncilSummary, type ThreadSummary } from "@/lib/api";
import { harnessById, relativeTime, usd } from "@/lib/harness";
import { useApp } from "./app-context";
import { Mark } from "./icons";
import { ThemeToggle } from "./theme-toggle";
import { SpendBar, StatusIcon } from "./status";

const DAY = 86_400_000;

function groupOf(iso: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t = new Date(iso).getTime();
  if (t >= start.getTime()) return "Today";
  if (t >= start.getTime() - DAY) return "Yesterday";
  if (t >= start.getTime() - 7 * DAY) return "Previous 7 days";
  return "Older";
}


function Sessions({ pathname }: { pathname: string }) {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [councils, setCouncils] = useState<CouncilSummary[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api<{ councils: CouncilSummary[] }>("/councils")
        .then((r) => alive && setCouncils(r.councils))
        .catch(() => {});
      return api<{ threads: ThreadSummary[] }>("/threads")
        .then((r) => alive && setThreads(r.threads))
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  if (threads === null)
    return (
      <div style={{ display: "grid", gap: 14, padding: "18px 10px" }} aria-busy="true">
        {[70, 55, 80, 60].map((w) => (
          <div key={w} className="skeleton" style={{ width: `${w}%` }} />
        ))}
      </div>
    );

  if (threads.length === 0 && councils.length === 0) return <p className="rail-empty">Your sessions show up here. Start one to hand the agent its first task.</p>;

  // Sessions and councils, newest first.
  const items = [
    ...threads.map((t) => ({ kind: "thread" as const, at: t.updatedAt, t })),
    ...councils.map((c) => ({ kind: "council" as const, at: c.updatedAt, c })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  let last = "";
  return (
    <>
      {items.map((item) => {
        if (item.kind === "council") {
          const c = item.c;
          const group = groupOf(c.updatedAt);
          const head = group !== last ? <div className="rail-group">{(last = group)}</div> : null;
          const href = `/app/council/${c.id}`;
          return (
            <div key={c.id}>
              {head}
              <Link href={href} className="rail-item" aria-current={pathname === href ? "page" : undefined}>
                {c.status === "running" ? <StatusIcon status="running" size={15} /> : <UsersThree size={15} style={{ color: c.status === "done" ? "var(--ok)" : "var(--text-3)" }} />}
                <span className="t">{c.question}</span>
                <span className="m">
                  Council of {c.members.length}
                  {c.repo ? ` · ${c.repo.split("/")[1]}` : ", web research"}, {relativeTime(c.updatedAt)}
                </span>
              </Link>
            </div>
          );
        }
        const t = item.t;
        const group = groupOf(t.updatedAt);
        const head = group !== last ? <div className="rail-group">{(last = group)}</div> : null;
        const href = `/app/s/${t.id}`;
        return (
          <div key={t.id}>
            {head}
            <Link href={href} className="rail-item" aria-current={pathname === href ? "page" : undefined}>
              <StatusIcon status={t.lastStatus} pr={Boolean(t.prUrl)} size={15} />
              <span className="t">{t.title}</span>
              <span className="m">
                {t.repo.split("/")[1]} · {harnessById(t.harness).name}{t.arenaId ? " in an arena" : ""}, {relativeTime(t.updatedAt)}
              </span>
            </Link>
          </div>
        );
      })}
    </>
  );
}

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
          <Sessions pathname={pathname} />
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
