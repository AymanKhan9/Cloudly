"use client";

import { useEffect, useState } from "react";

/** "On this page", with the section being read marked as you scroll. */
export function DocToc({ toc }: { toc: { id: string; text: string }[] }) {
  const [active, setActive] = useState(toc[0]?.id);

  useEffect(() => {
    // The section being read is the last heading scrolled past the top third of the
    // screen; at the very bottom, the last one (it may be too short to get there).
    const update = () => {
      const line = window.innerHeight / 3;
      let current = toc[0]?.id;
      for (const t of toc) {
        const el = document.getElementById(t.id);
        if (el && el.getBoundingClientRect().top <= line) current = t.id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = toc.at(-1)?.id;
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [toc]);

  return (
    <aside className="docs-toc" aria-label="On this page">
      <h2>On this page</h2>
      {toc.map((t) => (
        <a key={t.id} href={`#${t.id}`} aria-current={active === t.id ? "location" : undefined}>
          {t.text}
        </a>
      ))}
    </aside>
  );
}
