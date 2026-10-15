import { readFileSync } from "node:fs";
import path from "node:path";
import { DOCS, slugify } from "./docs";

// Server only: the docs sidebar (a client component) imports lib/docs.ts, so
// file reading lives here to keep node:fs out of the browser bundle.

/** Read at build time: every docs route is prerendered. */
export function loadDoc(slug: string) {
  const i = DOCS.findIndex((d) => d.slug === slug);
  if (i === -1) return null;
  const markdown = readFileSync(path.join(process.cwd(), "content/docs", `${slug}.md`), "utf8");
  const toc = [...markdown.matchAll(/^## (.+)$/gm)].map((m) => {
    const text = m[1]!.replace(/`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    return { text, id: slugify(text) };
  });
  return { page: DOCS[i]!, markdown, toc, prev: DOCS[i - 1], next: DOCS[i + 1] };
}
