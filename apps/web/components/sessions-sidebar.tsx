"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type ThreadSummary } from "@/lib/api";
import { harnessById, oktasFor, relativeTime, STATUS_LABEL } from "@/lib/harness";
import { Oktas } from "./notation";
import { PlusIcon } from "./icons";

export function SessionsSidebar() {
  const pathname = usePathname();
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ threads: ThreadSummary[] }>("/threads")
        .then((r) => alive && setThreads(r.threads))
        .catch(() => {});
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => setOpen(false), [pathname]);

  return (
    <aside className="side" data-open={open || undefined} aria-label="Sessions">
      <div className="side-head">
        <button type="button" className="side-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          Sessions{threads ? ` (${threads.length})` : ""}
        </button>
        <Link href="/app" className="btn btn-signal side-new">
          <PlusIcon />
          New session
        </Link>
      </div>

      <nav className="side-list">
        {threads === null ? (
          <div className="skeleton" style={{ width: "70%", margin: "12px 14px" }} aria-busy="true" />
        ) : threads.length === 0 ? (
          <p className="side-empty">No sessions yet. Start one and it will appear here.</p>
        ) : (
          threads.map((t) => {
            const href = `/app/s/${t.id}`;
            return (
              <Link key={t.id} href={href} className="side-item" aria-current={pathname === href ? "page" : undefined}>
                <Oktas eighths={oktasFor(t.lastStatus)} obscured={t.lastStatus === "failed"} title={STATUS_LABEL[t.lastStatus]} />
                <span className="side-title">{t.title}</span>
                <span className="side-meta">
                  {t.repo.split("/")[1]} · <span className="latin">{harnessById(t.harness).genus}</span> · {relativeTime(t.updatedAt)}
                </span>
              </Link>
            );
          })
        )}
      </nav>
    </aside>
  );
}
