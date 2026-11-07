import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "content/compare");

export type Comparison = { slug: string; title: string; description: string; markdown: string };

/** content/compare/<slug>.md, each with a `title:` and `description:` front matter. */
export function comparisons(): Comparison[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const raw = readFileSync(join(DIR, f), "utf8");
      const [, front = "", markdown = raw] = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
      const field = (k: string) => front.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1] ?? "";
      return { slug: f.slice(0, -3), title: field("title"), description: field("description"), markdown };
    });
}
