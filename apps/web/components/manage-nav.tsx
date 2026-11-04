"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell, Bug, CalendarBlank, ChartBar, ChatsCircle, CheckCircle, Cube, DownloadSimple, FolderSimple, GithubLogo, Key,
  Lightbulb, LockKey, MagnifyingGlass, Notebook, PlugsConnected, Robot, SlidersHorizontal, TreeStructure,
} from "@phosphor-icons/react";

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
  /** More words search finds it by. */
  keywords?: string;
}

/** Settings, split by subject the way T3 Code's are, with the pages that used to sit in the sidebar. */
export const MANAGE_NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Settings",
    items: [
      { href: "/app/settings", label: "General", icon: SlidersHorizontal, keywords: "spend limit budget alert email theme appearance dark light sidebar account sign out" },
      { href: "/app/settings/keys", label: "Keys and sign-ins", icon: Key, keywords: "anthropic openai gemini claude codex plan token chatgpt github logins allowed resend api key" },
      { href: "/app/settings/agents", label: "Agents", icon: Robot, keywords: "pi opencode cursor grok antigravity registry acp command update trial providers" },
      { href: "/app/settings/mcp", label: "MCP servers", icon: PlugsConnected, keywords: "oauth tools linear notion connectors" },
    ],
  },
  {
    group: "Sandbox",
    items: [
      { href: "/app/settings/sandbox", label: "Tools and network", icon: Cube, keywords: "setup script presets node python desktop image build hosts egress allow list" },
      { href: "/app/settings/secrets", label: "Secrets", icon: LockKey, keywords: "environment variables env placeholder repo secrets" },
      { href: "/app/settings/files", label: "Repo files", icon: FolderSimple, keywords: "kept files /files data fixtures" },
      { href: "/app/settings/context", label: "Shared context", icon: Notebook, keywords: "notes editor tokens mcp cursor claude code" },
    ],
  },
  {
    group: "Automation",
    items: [
      { href: "/app/settings/checks", label: "Checks and review", icon: CheckCircle, keywords: "tests reviewer fix attempts screenshots merge when ready lessons" },
      { href: "/app/settings/github", label: "GitHub triggers", icon: GithubLogo, keywords: "webhook issues label mention pull request review ci fix" },
      { href: "/app/settings/sentry", label: "Sentry", icon: Bug, keywords: "errors issues integration" },
      { href: "/app/schedules", label: "Schedules", icon: CalendarBlank, keywords: "scheduled tasks cron nightly weekly" },
    ],
  },
  {
    group: "Notifications",
    items: [
      { href: "/app/settings/notifications", label: "Notifications", icon: Bell, keywords: "dm webhook needs you done failed merged" },
      { href: "/app/settings/chat", label: "Discord and Slack", icon: ChatsCircle, keywords: "bot slash command link account" },
    ],
  },
  {
    group: "Workspace",
    items: [
      { href: "/app/plans", label: "Plans", icon: TreeStructure, keywords: "big task parallel sessions" },
      { href: "/app/scorecard", label: "Scorecard", icon: ChartBar, keywords: "agents merged cost auto" },
      { href: "/app/lessons", label: "Lessons", icon: Lightbulb, keywords: "corrections rules notes" },
      { href: "/app/import", label: "Import", icon: DownloadSimple, keywords: "session claude codex pi gemini opencode command pull" },
    ],
  },
];

const ALL = MANAGE_NAV.flatMap((g) => g.items);

/** The menu entry for a page: an exact match, else the one it's under (a plan's page is under Plans). */
export function navItemFor(pathname: string): NavItem | undefined {
  return ALL.find((i) => pathname === i.href) ?? ALL.find((i) => i.href !== "/app/settings" && pathname.startsWith(i.href + "/"));
}

export function ManageNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const current = navItemFor(pathname) ?? ALL[0]!;

  // "/" searches settings, as in T3 Code.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const groups = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return MANAGE_NAV;
    return MANAGE_NAV.map((g) => ({
      ...g,
      items: g.items.filter((i) => {
        const text = `${g.group} ${i.label} ${i.keywords ?? ""}`.toLowerCase();
        return words.every((w) => text.includes(w));
      }),
    })).filter((g) => g.items.length);
  }, [q]);

  return (
    <>
      <nav className="manage-nav" aria-label="Settings">
        <label className="manage-search">
          <MagnifyingGlass size={15} />
          <span className="visually-hidden">Search settings</span>
          <input
            ref={search}
            type="search"
            placeholder="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              const first = groups[0]?.items[0];
              if (e.key === "Enter" && first) {
                router.push(first.href);
                setQ("");
                search.current?.blur();
              }
              if (e.key === "Escape") setQ("");
            }}
          />
          <kbd>/</kbd>
        </label>
        {groups.map((g) => (
          <div key={g.group} className="manage-group">
            {g.group !== "Settings" ? <p className="manage-group-name">{g.group}</p> : null}
            {g.items.map((i) => {
              const Icon = i.icon;
              return (
                <Link key={i.href} href={i.href} className="manage-link" aria-current={current.href === i.href ? "page" : undefined}>
                  <Icon size={16} />
                  {i.label}
                </Link>
              );
            })}
          </div>
        ))}
        {groups.length === 0 ? <p className="manage-none">Nothing matches.</p> : null}
      </nav>

      {/* On a phone: one menu instead of the list. */}
      <label className="manage-select">
        <span className="visually-hidden">Settings page</span>
        <select className="select" value={current.href} onChange={(e) => router.push(e.target.value)}>
          {MANAGE_NAV.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.items.map((i) => (
                <option key={i.href} value={i.href}>
                  {i.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
    </>
  );
}
