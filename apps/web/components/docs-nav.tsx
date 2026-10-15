"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { DOCS, hrefOf } from "@/lib/docs";

const GROUPS = [...new Set(DOCS.map((d) => d.group))];

function Links({ pathname }: { pathname: string }) {
  return (
    <>
      {GROUPS.map((g) => (
        <div key={g} className="docs-group">
          <h2>{g}</h2>
          {DOCS.filter((d) => d.group === g).map((d) => {
            const href = hrefOf(d.slug);
            return (
              <Link key={d.slug} href={href} aria-current={pathname === href ? "page" : undefined}>
                {d.title}
              </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}

export function DocsNav() {
  const pathname = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  const current = DOCS.find((d) => hrefOf(d.slug) === pathname);

  // Close the phone menu after choosing a page.
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [pathname]);

  return (
    <>
      <nav className="docs-nav" aria-label="Docs">
        <Links pathname={pathname} />
      </nav>
      <details className="docs-menu" ref={menu}>
        <summary>
          <span>{current?.title ?? "Docs"}</span>
          <CaretDown size={14} />
        </summary>
        <nav aria-label="Docs">
          <Links pathname={pathname} />
        </nav>
      </details>
    </>
  );
}
